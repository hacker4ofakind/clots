import { beforeEach, describe, expect, it, vi } from "vitest";
import { Clot, type ClotDeps } from "../src/clot.js";
import type { DaemonTools, TurnContext } from "../src/tools.js";
import { Store } from "../src/store.js";
import { FakeChat } from "../src/chat/fake.js";
import type { AgentRunner, TurnHandle, TurnRequest, TurnResult } from "../src/agent/runner.js";
import type { Router, RouterInput } from "../src/router.js";
import type { Effort, RouterDecision, TurnActivity } from "../src/types.js";
import type { InboundMessage } from "../src/chat/adapter.js";
import type { ClotEvent } from "../src/events/types.js";

interface Step {
  say?: string[];
  contextPercent?: number;
  ok?: boolean;
  limit?: { resetsAt: number };
  hold?: boolean;
  activity?: TurnActivity;
  /** Something the turn does while it runs, such as calling one of its tools. */
  act?: (req: TurnRequest) => Promise<void> | void;
}

class FakeRunner implements AgentRunner {
  calls: TurnRequest[] = [];
  pushes: { text: string; effort?: Effort }[] = [];
  script: Step[] = [];
  release?: () => void;
  acceptPushes = true;

  startTurn(req: TurnRequest): TurnHandle {
    this.calls.push(req);
    const step = this.script.shift() ?? {};
    const done = (async (): Promise<TurnResult> => {
      for (const line of step.say ?? ["ok"]) req.onText(line);
      if (step.act) await step.act(req);
      if (step.hold) await new Promise<void>((resolve) => (this.release = resolve));
      return {
        sessionId: req.resume ?? req.newSessionId ?? "",
        contextPercent: step.contextPercent ?? 10,
        ok: step.ok ?? true,
        limit: step.limit,
        activity: step.activity,
      };
    })();
    return {
      push: (text, effort) => {
        if (this.acceptPushes) this.pushes.push({ text, effort });
        return this.acceptPushes;
      },
      stop: () => undefined,
      done,
    };
  }
}

class FakeRouter implements Router {
  inputs: RouterInput[] = [];
  next: RouterDecision[] = [];
  async decide(input: RouterInput): Promise<RouterDecision> {
    this.inputs.push(input);
    return this.next.shift() ?? { effort: "medium" };
  }
}

const USER = "user-1";
let store: Store;
let chat: FakeChat;
let router: FakeRouter;
let runner: FakeRunner;
let clot: Clot;
let now: Date;
let ids: number;
let timers: { ms: number; fn: () => void }[];
let seq: number;
let turnEnds: string[];
/** Dependencies a test adds to the Clot it builds. */
let extra: Partial<ClotDeps>;

function msg(text: string, overrides: Partial<InboundMessage> = {}): InboundMessage {
  seq += 1;
  return { id: `m${seq}`, channelId: store.activeSession("graphite")!.channelId, authorId: USER, text, at: now, ...overrides };
}

function build(rolloverPercent = 65): Clot {
  return new Clot({
    name: "graphite",
    store,
    chat,
    router,
    runner,
    timeZone: "UTC",
    userId: USER,
    rolloverPercent,
    now: () => now,
    newId: () => `sess-${++ids}`,
    schedule: (ms, fn) => void timers.push({ ms, fn }),
    onTurnEnd: async (name) => void turnEnds.push(name),
    ...extra,
  });
}

function event(id: string, overrides: Partial<ClotEvent> = {}): ClotEvent {
  const e: ClotEvent = {
    id,
    source: "github",
    kind: "issue_opened",
    account: "github", place: "octo/widgets",
    actor: "someone",
    title: "Issue #7 opened: Login fails",
    body: "Steps to reproduce...",
    url: "https://github.com/octo/widgets/issues/7",
    ref: "7",
    subject: "issue:7",
    automated: false,
    outsider: false,
    receivedAt: now.getTime(),
    ...overrides,
  };
  store.insertEvent(e);
  return e;
}

beforeEach(async () => {
  store = new Store(":memory:");
  chat = new FakeChat();
  router = new FakeRouter();
  runner = new FakeRunner();
  now = new Date("2026-10-10T12:00:00Z");
  ids = 0;
  seq = 0;
  timers = [];
  turnEnds = [];
  extra = {};
  clot = build();
  await clot.init();
});

describe("Clot", () => {
  it("creates a category, a first channel and a session on init", () => {
    expect(chat.channels.map((c) => c.name)).toEqual(["graphite-1010"]);
    expect(store.activeSession("graphite")).toMatchObject({ id: "sess-1", started: false });
  });

  it("starts a new session on the first message and posts the reply", async () => {
    router.next = [{ effort: "low" }];
    runner.script = [{ say: ["On it."] }];
    const channel = store.activeSession("graphite")!.channelId;

    await clot.onMessage(msg("check the footer link"));

    expect(runner.calls[0]).toMatchObject({ newSessionId: "sess-1", effort: "low", role: "main", prompt: "check the footer link" });
    expect(runner.calls[0].resume).toBeUndefined();
    expect(chat.postsIn(channel)).toContain("On it.");
  });

  it("shows typing from the moment a message arrives until the turn ends", async () => {
    const channel = store.activeSession("graphite")!.channelId;
    runner.script = [{ hold: true }];

    const turn = clot.onMessage(msg("build the page"));
    await vi.waitFor(() => expect(runner.release).toBeDefined());
    expect(chat.typing.has(channel)).toBe(true);
    runner.release!();
    await turn;

    expect(chat.typing.has(channel)).toBe(false);
  });

  it("posts what the turn changed and ran, after the reply, and keeps it out of the router's context", async () => {
    const channel = store.activeSession("graphite")!.channelId;
    const activity = { files: [{ path: "src/a.ts", added: 2, removed: 1 }], commands: ["npm test"] };
    runner.script = [{ say: ["Done."], activity }, {}];

    await clot.onMessage(msg("fix it"));
    await clot.onMessage(msg("thanks"));

    expect(chat.activities).toEqual([{ channelId: channel, activity }]);
    expect(router.inputs[1].tail.map((t) => t.text)).toEqual(["fix it", "Done."]);
    expect(runner.calls[1].prompt).toBe("thanks");
  });

  it("posts no summary for a turn that changed and ran nothing", async () => {
    runner.script = [{ activity: { files: [], commands: [] } }, {}];
    await clot.onMessage(msg("hello"));
    await clot.onMessage(msg("again"));
    expect(chat.activities).toEqual([]);
  });

  it("resumes the same session on the next message", async () => {
    await clot.onMessage(msg("one"));
    await clot.onMessage(msg("two"));
    expect(runner.calls[1].resume).toBe("sess-1");
    expect(runner.calls[1].newSessionId).toBeUndefined();
  });

  it("tells the user when a turn fails", async () => {
    const channel = store.activeSession("graphite")!.channelId;
    runner.script = [{ ok: false, say: [], contextPercent: 0 }];
    await clot.onMessage(msg("do it"));
    expect(chat.postsIn(channel).at(-1)).toBe("That turn ended with an error. Send your message again to retry.");
    expect(store.activeSession("graphite")!.started).toBe(false);
  });

  it("gives the router the last four messages", async () => {
    runner.script = [{ say: ["a1"] }, { say: ["a2"] }, { say: ["a3"] }];
    await clot.onMessage(msg("q1"));
    await clot.onMessage(msg("q2"));
    await clot.onMessage(msg("q3"));
    expect(router.inputs[2].tail.map((t) => t.text)).toEqual(["q1", "a1", "q2", "a2"]);
  });

  it("pushes a message that arrives during a turn instead of starting another", async () => {
    runner.script = [{ hold: true }];
    router.next = [{ effort: "medium" }, { effort: "low" }];

    const first = clot.onMessage(msg("build the page"));
    await vi.waitFor(() => expect(runner.release).toBeDefined());
    await clot.onMessage(msg("meanwhile, check if Fable 5.5 is out"));
    runner.release!();
    await first;

    expect(runner.calls).toHaveLength(1);
    expect(runner.pushes).toEqual([{ text: "[sent while you were working]\nmeanwhile, check if Fable 5.5 is out", effort: "low" }]);
    expect(store.nextPending("graphite")).toBeUndefined();
  });

  it("keeps later messages behind a deferred &close instead of feeding them to the old session", async () => {
    runner.script = [{ hold: true }, {}];

    const first = clot.onMessage(msg("build the page"));
    await vi.waitFor(() => expect(runner.release).toBeDefined());
    await clot.onMessage(msg("&close nosummary"));
    await clot.onMessage(msg("now write the tests"));
    expect(runner.pushes).toEqual([]);
    runner.release!();
    await first;

    expect(runner.calls).toHaveLength(2);
    expect(runner.calls[1]).toMatchObject({ newSessionId: "sess-2", prompt: "now write the tests" });
  });

  it("keeps a message for the next turn when the live turn no longer accepts input", async () => {
    runner.script = [{ hold: true }, {}];
    runner.acceptPushes = false;

    const first = clot.onMessage(msg("build the page"));
    await vi.waitFor(() => expect(runner.release).toBeDefined());
    await clot.onMessage(msg("one more thing"));
    runner.release!();
    await first;

    expect(runner.calls).toHaveLength(2);
    expect(runner.calls[1].prompt).toBe("one more thing");
    expect(store.nextPending("graphite")).toBeUndefined();
  });

  it("keeps the new session when closing the old channel fails", async () => {
    runner.script = [{ contextPercent: 70 }, { say: ["RECAP"] }, {}];
    chat.makeReadOnly = async () => {
      throw new Error("Missing Permissions");
    };

    await clot.onMessage(msg("do the thing"));

    expect(store.activeSession("graphite")).toMatchObject({ id: "sess-2", seed: "RECAP" });
    await clot.onMessage(msg("carry on"));
    expect(runner.calls[2]).toMatchObject({ newSessionId: "sess-2" });
  });

  it("rolls over at the threshold: recap, new channel, old channel read-only, seeded next prompt", async () => {
    const oldChannel = store.activeSession("graphite")!.channelId;
    runner.script = [{ contextPercent: 70 }, { say: ["RECAP: built the footer."] }, {}];

    await clot.onMessage(msg("do the thing"));

    expect(runner.calls[1]).toMatchObject({ resume: "sess-1", role: "main" });
    expect(runner.calls[1].prompt).toContain("Write a recap");
    const fresh = store.activeSession("graphite")!;
    expect(fresh).toMatchObject({ id: "sess-2", started: false, seed: "RECAP: built the footer." });
    expect(chat.channels[0].name).toBe("graphite-1010-2");
    expect(chat.postsIn(fresh.channelId)[0]).toContain("<@user-1>");
    expect(chat.postsIn(fresh.channelId)[0]).toContain("RECAP: built the footer.");
    expect(chat.postsIn(oldChannel).at(-1)).toContain(`<#${fresh.channelId}>`);
    expect(chat.readOnly.has(oldChannel)).toBe(true);

    await clot.onMessage(msg("carry on"));
    expect(runner.calls[2]).toMatchObject({ newSessionId: "sess-2" });
    expect(runner.calls[2].prompt).toContain("RECAP: built the footer.");
    expect(store.activeSession("graphite")!.seed).toBeNull();
  });

  it("announces the rollover in the old channel before the recap is written", async () => {
    const oldChannel = store.activeSession("graphite")!.channelId;
    runner.script = [{ contextPercent: 70 }, { hold: true, say: ["RECAP"] }];

    const turn = clot.onMessage(msg("do the thing"));
    await vi.waitFor(() => expect(runner.release).toBeDefined());
    expect(chat.postsIn(oldChannel).at(-1)).toBe("This thread hit the context limit and will be closed. Waiting on handoff...");
    expect(chat.channels).toHaveLength(1);
    runner.release!();
    await turn;

    expect(chat.postsIn(oldChannel).at(-1)).toContain("This session is closed.");
  });

  it("says so when the handoff could not be written", async () => {
    const oldChannel = store.activeSession("graphite")!.channelId;
    runner.script = [{ contextPercent: 70 }, { ok: false, say: [] }];
    await clot.onMessage(msg("do the thing"));
    expect(chat.postsIn(oldChannel).at(-1)).toBe("The handoff could not be written. This thread stays open; I'll try again after the next message.");
    expect(store.activeSession("graphite")!.channelId).toBe(oldChannel);
  });

  it("does not post the recap turn's text into the old channel", async () => {
    const oldChannel = store.activeSession("graphite")!.channelId;
    runner.script = [{ contextPercent: 70 }, { say: ["RECAP: secret sauce."] }];
    await clot.onMessage(msg("do the thing"));
    expect(chat.postsIn(oldChannel)).not.toContain("RECAP: secret sauce.");
  });

  it("points messages in a closed channel to the live one", async () => {
    const oldChannel = store.activeSession("graphite")!.channelId;
    runner.script = [{ contextPercent: 70 }, { say: ["RECAP"] }];
    await clot.onMessage(msg("do the thing"));
    const live = store.activeSession("graphite")!.channelId;

    await clot.onMessage(msg("hello?", { channelId: oldChannel }));

    expect(chat.postsIn(oldChannel).at(-1)).toBe(`This session is closed. Continue in <#${live}>.`);
    expect(runner.calls).toHaveLength(2);
  });

  it("ignores messages from anyone but the user", async () => {
    await clot.onMessage(msg("hi", { authorId: "stranger" }));
    expect(runner.calls).toHaveLength(0);
  });

  it("ignores a message it has already seen", async () => {
    const m = msg("once");
    await clot.onMessage(m);
    await clot.onMessage(m);
    expect(runner.calls).toHaveLength(1);
  });

  it("pauses at the usage limit, says so once, queues, and resumes at the reset", async () => {
    const channel = store.activeSession("graphite")!.channelId;
    const resetsAt = Math.floor(now.getTime() / 1000) + 3600;
    runner.script = [{ ok: false, limit: { resetsAt } }, {}];

    await clot.onMessage(msg("big task"));
    expect(chat.postsIn(channel).filter((p) => p.startsWith("Paused"))).toEqual(["Paused: usage limit reached. I'll resume at 13:00."]);
    expect(timers[0].ms).toBe(3600_000);

    await clot.onMessage(msg("are you there?"));
    expect(runner.calls).toHaveLength(1);
    expect(chat.postsIn(channel).filter((p) => p.startsWith("Paused"))).toHaveLength(1);

    now = new Date(resetsAt * 1000);
    timers[0].fn();
    await vi.waitFor(() => expect(runner.calls).toHaveLength(2));
    expect(runner.calls[1].prompt).toContain("cut off");
    expect(runner.calls[1].prompt).toContain("are you there?");
    expect(store.getClot("graphite")!.pausedUntil).toBeNull();
  });

  it("does not start a second turn when the reset timer fires during a turn the user already started", async () => {
    const resetsAt = Math.floor(now.getTime() / 1000) + 60;
    runner.script = [{ ok: false, limit: { resetsAt } }, { hold: true }];
    await clot.onMessage(msg("big task"));

    now = new Date(resetsAt * 1000 + 1000);
    const turn = clot.onMessage(msg("are you back?"));
    await vi.waitFor(() => expect(runner.release).toBeDefined());
    timers[0].fn();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(runner.calls).toHaveLength(2);
    runner.release!();
    await turn;

    expect(runner.calls).toHaveLength(2);
    expect(store.nextPending("graphite")).toBeUndefined();
  });

  it("resumes on startup when the pause expired while the daemon was down", async () => {
    const resetsAt = Math.floor(now.getTime() / 1000) + 60;
    runner.script = [{ ok: false, limit: { resetsAt } }, {}];
    await clot.onMessage(msg("big task"));

    now = new Date(resetsAt * 1000 + 5000);
    timers = [];
    await build().init();
    expect(timers.map((t) => t.ms)).toEqual([0]);
    timers[0].fn();

    await vi.waitFor(() => expect(runner.calls).toHaveLength(2));
    expect(runner.calls[1].prompt).toContain("The usage limit has reset");
  });

  it("still schedules the resume when the pause notice cannot be posted", async () => {
    const resetsAt = Math.floor(now.getTime() / 1000) + 60;
    runner.script = [{ ok: false, limit: { resetsAt } }];
    const post = chat.post.bind(chat);
    chat.post = async (channelId, text) => {
      if (text.startsWith("Paused")) throw new Error("Discord is down");
      return post(channelId, text);
    };

    await clot.onMessage(msg("big task"));

    expect(timers).toHaveLength(1);
    expect(store.getClot("graphite")!.pausedUntil).toBe(resetsAt);
  });

  it("does not lose the wake-up when the reset timer fires while the pause notice is being posted", async () => {
    const resetsAt = Math.floor(now.getTime() / 1000) + 1;
    runner.script = [{ ok: false, limit: { resetsAt } }, {}];
    const post = chat.post.bind(chat);
    chat.post = async (channelId, text) => {
      if (text.startsWith("Paused")) {
        now = new Date(resetsAt * 1000);
        timers[0].fn();
      }
      return post(channelId, text);
    };

    await clot.onMessage(msg("big task"));

    expect(runner.calls).toHaveLength(2);
    expect(runner.calls[1].prompt).toContain("The usage limit has reset");
    expect(store.getClot("graphite")!.pausedUntil).toBeNull();
  });

  it("pauses when a rollover's recap hits the usage limit, and does not invent a continuation", async () => {
    const channel = store.activeSession("graphite")!.channelId;
    const resetsAt = Math.floor(now.getTime() / 1000) + 3600;
    runner.script = [{ contextPercent: 70 }, { ok: false, say: [], limit: { resetsAt } }, { contextPercent: 70 }, { say: ["RECAP"] }];

    await clot.onMessage(msg("do the thing"));
    expect(store.getClot("graphite")!.pausedUntil).toBe(resetsAt);
    expect(store.activeSession("graphite")!.channelId).toBe(channel);
    expect(chat.postsIn(channel).at(-1)).toBe("Paused: usage limit reached. I'll resume at 13:00.");

    now = new Date(resetsAt * 1000);
    timers[0].fn();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(runner.calls).toHaveLength(2);

    await clot.onMessage(msg("carry on"));
    expect(runner.calls[2].prompt).toBe("carry on");
    expect(store.activeSession("graphite")!.id).toBe("sess-2");
  });

  it("asks the session to continue after a pause when nothing is queued", async () => {
    const resetsAt = Math.floor(now.getTime() / 1000) + 60;
    runner.script = [{ ok: false, limit: { resetsAt } }, {}];
    await clot.onMessage(msg("big task"));

    now = new Date(resetsAt * 1000);
    timers[0].fn();
    await vi.waitFor(() => expect(runner.calls).toHaveLength(2));
    expect(runner.calls[1].prompt).toContain("The usage limit has reset");
  });

  describe("commands", () => {
    it("&effort with a message sets that message's effort and is stripped from the prompt", async () => {
      router.next = [{ effort: "low" }];
      await clot.onMessage(msg("&effort medium refactor the auth module"));
      expect(runner.calls[0]).toMatchObject({ effort: "medium", prompt: "refactor the auth module" });
      expect(router.inputs[0].text).toBe("refactor the auth module");
    });

    it("&effort alone applies to the next message only", async () => {
      const channel = store.activeSession("graphite")!.channelId;
      router.next = [{ effort: "low" }, { effort: "low" }];

      await clot.onMessage(msg("&effort medium"));
      expect(runner.calls).toHaveLength(0);
      expect(chat.postsIn(channel).at(-1)).toBe("Effort for your next message: medium.");

      await clot.onMessage(msg("plan the migration"));
      await clot.onMessage(msg("and the rollback"));
      expect(runner.calls.map((c) => c.effort)).toEqual(["medium", "low"]);
    });

    it("answers &effort high with the usage text and starts no turn", async () => {
      const channel = store.activeSession("graphite")!.channelId;
      await clot.onMessage(msg("&effort high fix it"));
      expect(runner.calls).toHaveLength(0);
      expect(chat.postsIn(channel).at(-1)).toContain("`&effort low|medium [message]`");
    });

    it("answers a wrong or unknown command without involving the model", async () => {
      const channel = store.activeSession("graphite")!.channelId;
      await clot.onMessage(msg("&effort max do it"));
      await clot.onMessage(msg("&clsoe"));
      expect(runner.calls).toHaveLength(0);
      expect(router.inputs).toHaveLength(0);
      expect(chat.postsIn(channel).slice(-2).every((p) => p.includes("&close nosummary"))).toBe(true);
    });

    it("&close hands off like a rollover and says the user asked for it", async () => {
      const oldChannel = store.activeSession("graphite")!.channelId;
      runner.script = [{}, { say: ["RECAP: built the footer."] }, {}];
      await clot.onMessage(msg("do the thing"));

      await clot.onMessage(msg("&close"));

      expect(runner.calls[1]).toMatchObject({ resume: "sess-1", role: "main" });
      expect(runner.calls[1].prompt).toContain("The user has asked to close this session");
      expect(chat.postsIn(oldChannel)).toContain("Closing this session at your request. Waiting on handoff...");
      const fresh = store.activeSession("graphite")!;
      expect(fresh).toMatchObject({ id: "sess-2", seed: "RECAP: built the footer.", seedReason: "user" });
      expect(chat.postsIn(fresh.channelId)[0]).toContain("started at your request");
      expect(chat.postsIn(fresh.channelId)[0]).toContain("RECAP: built the footer.");
      expect(chat.postsIn(oldChannel).at(-1)).toBe(`This session was closed at your request. Continued in <#${fresh.channelId}>.`);
      expect(chat.readOnly.has(oldChannel)).toBe(true);

      await clot.onMessage(msg("carry on"));
      expect(runner.calls[2].prompt).toContain("the user asked for a fresh one");
    });

    it("&close nosummary starts from scratch: no recap turn, no seed, empty router context", async () => {
      const oldChannel = store.activeSession("graphite")!.channelId;
      await clot.onMessage(msg("do the thing"));

      await clot.onMessage(msg("&close nosummary"));

      expect(runner.calls).toHaveLength(1);
      const fresh = store.activeSession("graphite")!;
      expect(fresh).toMatchObject({ id: "sess-2", seed: null, started: false });
      expect(chat.postsIn(fresh.channelId)[0]).toContain("from scratch at your request");
      expect(chat.readOnly.has(oldChannel)).toBe(true);

      await clot.onMessage(msg("hello"));
      expect(runner.calls[1]).toMatchObject({ newSessionId: "sess-2", prompt: "hello", role: "main" });
      expect(router.inputs.at(-1)!.tail).toEqual([]);
    });

    it("&effort alone is used up by the next message even when that message joins a running turn", async () => {
      runner.script = [{ hold: true }, {}];
      router.next = [{ effort: "medium" }, { effort: "low" }, { effort: "low" }];

      const first = clot.onMessage(msg("build the page"));
      await vi.waitFor(() => expect(runner.release).toBeDefined());
      await clot.onMessage(msg("&effort medium"));
      await clot.onMessage(msg("also check the footer"));
      expect(runner.pushes).toEqual([{ text: "[sent while you were working]\nalso check the footer", effort: "medium" }]);
      runner.release!();
      await first;

      await clot.onMessage(msg("and the header"));
      expect(runner.calls[1].effort).toBe("low");
    });

    it("&effort alone is kept when the running turn refuses the message", async () => {
      runner.script = [{ hold: true }, {}];
      runner.acceptPushes = false;
      router.next = [{ effort: "medium" }, { effort: "low" }, { effort: "low" }];

      const first = clot.onMessage(msg("build the page"));
      await vi.waitFor(() => expect(runner.release).toBeDefined());
      await clot.onMessage(msg("&effort medium"));
      await clot.onMessage(msg("also check the footer"));
      runner.release!();
      await first;

      expect(runner.calls[1]).toMatchObject({ prompt: "also check the footer", effort: "medium" });
    });

    it("an explicit &effort on the next message replaces an earlier &effort, which is then spent", async () => {
      await clot.onMessage(msg("&effort medium"));
      await clot.onMessage(msg("&effort low check the link"));
      await clot.onMessage(msg("and the footer"));
      expect(runner.calls.map((c) => c.effort)).toEqual(["low", "medium"]);
    });

    it("&close nosummary discards a recap the new session has not used yet", async () => {
      runner.script = [{ contextPercent: 70 }, { say: ["RECAP"] }, {}];
      await clot.onMessage(msg("do the thing"));
      const channel = store.activeSession("graphite")!.channelId;

      await clot.onMessage(msg("&close nosummary"));

      expect(store.activeSession("graphite")).toMatchObject({ id: "sess-2", channelId: channel, seed: null });
      expect(chat.postsIn(channel).at(-1)).toBe("Recap discarded. This session now starts from scratch.");
      expect(runner.calls).toHaveLength(2);

      await clot.onMessage(msg("hello"));
      expect(runner.calls[2]).toMatchObject({ newSessionId: "sess-2", prompt: "hello", role: "main" });
    });

    it("&close keeps a recap the new session has not used yet", async () => {
      runner.script = [{ contextPercent: 70 }, { say: ["RECAP"] }];
      await clot.onMessage(msg("do the thing"));
      await clot.onMessage(msg("&close"));
      expect(store.activeSession("graphite")).toMatchObject({ id: "sess-2", seed: "RECAP" });
    });

    it("pauses and retries &close after the reset when the recap turn hits the usage limit", async () => {
      const resetsAt = Math.floor(now.getTime() / 1000) + 3600;
      runner.script = [{}, { ok: false, say: [], limit: { resetsAt } }, { say: ["RECAP"] }];
      await clot.onMessage(msg("do the thing"));

      await clot.onMessage(msg("&close"));
      expect(store.getClot("graphite")!.pausedUntil).toBe(resetsAt);
      expect(store.activeSession("graphite")!.id).toBe("sess-1");

      now = new Date(resetsAt * 1000);
      timers[0].fn();
      await vi.waitFor(() => expect(store.activeSession("graphite")!.id).toBe("sess-2"));
      expect(runner.calls).toHaveLength(3);
      expect(store.activeSession("graphite")).toMatchObject({ seed: "RECAP", seedReason: "user" });
    });

    it("&close on a session that has not been used does nothing", async () => {
      const channel = store.activeSession("graphite")!.channelId;
      await clot.onMessage(msg("&close"));
      expect(runner.calls).toHaveLength(0);
      expect(store.activeSession("graphite")!.channelId).toBe(channel);
      expect(chat.postsIn(channel).at(-1)).toBe("This session is already fresh; there is nothing to close.");
    });

    it("&close sent during a turn waits for the turn, and is never passed to the model", async () => {
      const channel = store.activeSession("graphite")!.channelId;
      runner.script = [{ hold: true }, { say: ["RECAP"] }];

      const first = clot.onMessage(msg("build the page"));
      await vi.waitFor(() => expect(runner.release).toBeDefined());
      await clot.onMessage(msg("&close"));
      expect(runner.pushes).toEqual([]);
      expect(chat.postsIn(channel).at(-1)).toBe("I'll close this session when the current turn finishes.");
      runner.release!();
      await first;

      expect(store.activeSession("graphite")!.id).toBe("sess-2");
    });

    it("tells the user how to retry when the handoff for &close cannot be written", async () => {
      const channel = store.activeSession("graphite")!.channelId;
      runner.script = [{}, { ok: false, say: [] }];
      await clot.onMessage(msg("do the thing"));
      await clot.onMessage(msg("&close"));
      expect(store.activeSession("graphite")!.channelId).toBe(channel);
      expect(chat.postsIn(channel).at(-1)).toContain("&close nosummary");
    });
  });

  describe("events", () => {
    it("runs a queued event as a locked turn of its own, marked as untrusted", async () => {
      const channel = store.activeSession("graphite")!.channelId;
      router.next = [{ effort: "low" }];
      runner.script = [{ say: ["It fails because the cookie is not set."] }];

      await clot.queueEvent(event("d-1"), "Someone reported that login fails. Looking into it.");
      await vi.waitFor(() => expect(chat.postsIn(channel)).toContain("It fails because the cookie is not set."));

      expect(chat.postsIn(channel)).toContain("Someone reported that login fails. Looking into it. <https://github.com/octo/widgets/issues/7>");
      expect(runner.calls[0]).toMatchObject({ newSessionId: "sess-1", effort: "low", role: "main" });
      expect(runner.calls[0].prompt).toContain("An event arrived from outside this chat");
      expect(runner.calls[0].prompt).toContain("title: Issue #7 opened: Login fails");
      expect(store.getEvent("d-1")!.status).toBe("queued");
      expect(store.tail("graphite", 4)).toEqual([{ role: "clot", text: "It fails because the cookie is not set." }]);
    });

    it("does not let an event use a one-off effort, or act as a command", async () => {
      store.setNextEffort("graphite", "low");
      router.next = [{ effort: "medium" }];

      await clot.queueEvent(event("d-1", { title: "&close nosummary", body: "&close nosummary" }), "Odd issue.");
      await vi.waitFor(() => expect(runner.calls).toHaveLength(1));

      expect(runner.calls[0]).toMatchObject({ effort: "medium", role: "main", model: "claude-opus-5-5" });
      expect(store.nextEffort("graphite")).toBe("low");
      expect(store.activeSession("graphite")!.id).toBe("sess-1");
    });

    it("keeps events and messages in the order they arrived, and never feeds an event into a running turn by itself", async () => {
      runner.script = [{ hold: true }, {}, {}];

      const first = clot.onMessage(msg("build the page"));
      await vi.waitFor(() => expect(runner.release).toBeDefined());
      expect(clot.isBusy()).toBe(true);
      await clot.queueEvent(event("d-1"), "Login fails.");
      await clot.onMessage(msg("and add a footer"));
      expect(runner.pushes).toEqual([]);
      runner.release!();
      await first;

      expect(clot.isBusy()).toBe(false);
      expect(runner.calls.map((c) => c.prompt.includes("An event arrived"))).toEqual([false, true, false]);
      expect(runner.calls[2].prompt).toBe("and add a footer");
    });

    it("does not use up the user's message in an event's turn: it waits for a chat turn of its own", async () => {
      runner.script = [{ hold: true }, {}];
      await clot.queueEvent(event("d-1"), "Login fails.");
      await vi.waitFor(() => expect(runner.release).toBeDefined());

      await clot.onMessage(msg("fix it now"));
      expect(runner.pushes).toEqual([]);
      expect(store.nextPending("graphite")).toMatchObject({ text: "fix it now", status: "pending" });
      runner.release!();

      await vi.waitFor(() => expect(runner.calls).toHaveLength(2));
      expect(runner.calls.map((c) => c.prompt.includes("An event arrived"))).toEqual([true, false]);
      expect(runner.calls[1].prompt).toBe("fix it now");
    });

    it("keeps the lock on an investigation the usage limit cut off, across a restart too", async () => {
      const resetsAt = Math.floor(now.getTime() / 1000) + 60;
      runner.script = [{ ok: false, limit: { resetsAt } }, {}];
      await clot.queueEvent(event("d-1"), "Login fails.");
      await vi.waitFor(() => expect(store.getClot("graphite")!.pausedUntil).toBe(resetsAt));
      expect(store.activeSession("graphite")).toMatchObject({ interrupted: true, interruptedKind: "event" });

      now = new Date(resetsAt * 1000 + 5000);
      timers = [];
      await build().init();
      timers[0].fn();

      await vi.waitFor(() => expect(runner.calls).toHaveLength(2));
      expect(runner.calls[1]).toMatchObject({ role: "main" });
      expect(runner.calls[1].prompt).toContain("The usage limit has reset");
      expect(runner.calls[1].prompt).toContain("An event arrived from outside this chat");
    });

    it("says so when looking into an event fails", async () => {
      const channel = store.activeSession("graphite")!.channelId;
      runner.script = [{ ok: false, say: [], contextPercent: 0 }];
      await clot.queueEvent(event("d-1"), "Login fails.");
      await vi.waitFor(() => expect(chat.postsIn(channel).at(-1)).toBe("Looking into that event ended with an error. Ask me about it to try again."));
    });

    it("reports that no turn is running: once at startup and after every turn", async () => {
      expect(turnEnds).toEqual(["graphite"]);
      await clot.onMessage(msg("one"));
      await clot.onMessage(msg("&effort high"));
      await clot.queueEvent(event("d-1"), "Login fails.");
      await vi.waitFor(() => expect(runner.calls).toHaveLength(2));
      await vi.waitFor(() => expect(turnEnds).toEqual(["graphite", "graphite", "graphite"]));
    });

    it("queues from the after-turn hook without starting a second drain", async () => {
      const queued = event("d-1");
      let once = true;
      const hooked = new Clot({
        name: "graphite",
        store,
        chat,
        router,
        runner,
        timeZone: "UTC",
        userId: USER,
        rolloverPercent: 65,
        now: () => now,
        newId: () => `sess-${++ids}`,
        schedule: (ms, fn) => void timers.push({ ms, fn }),
        onTurnEnd: async () => {
          if (runner.calls.length === 1 && once) {
            once = false;
            await hooked.queueEvent(queued, "Login fails.", false);
          }
        },
      });
      await hooked.init();

      await hooked.onMessage(msg("build the page"));

      expect(runner.calls.map((c) => c.prompt.includes("An event arrived"))).toEqual([false, true]);
      expect(store.nextPending("graphite")).toBeUndefined();
    });
  });

  it("re-runs a message that was in flight when the daemon stopped", async () => {
    const m = msg("half done");
    store.enqueue({ id: m.id, clot: "graphite", channelId: m.channelId, text: m.text, receivedAt: 1 });
    store.setInboxStatus(m.id, "running");

    await build().init();

    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0].prompt).toContain("cut off");
    expect(runner.calls[0].prompt).toContain("half done");
  });
});

describe("Clot, stage 2b", () => {
  let contexts: TurnContext[];
  let closed: { clot: string; session: string }[];

  const fakeTools: DaemonTools = { show: async () => "", prefilter: async () => "", guidance: async () => "", standing: async () => "", send: async () => "", routing: async () => "", routeCorrect: async () => "", watch: async () => "", webhook: async () => "", startSession: async () => "", messageWorker: async () => "", stopWorker: async () => "", askChoice: async () => "" };

  /** Builds the Clot again, with the daemon's tools and whatever else the test adds. */
  async function rebuild(more: Partial<ClotDeps> = {}): Promise<void> {
    contexts = [];
    closed = [];
    extra = {
      makeTools: (ctx) => {
        contexts.push(ctx);
        return fakeTools;
      },
      onSessionClosed: async (name) => void closed.push({ clot: name, session: store.activeSession(name)!.id }),
      ...more,
    };
    clot = build();
    await clot.init();
  }

  it("gives a turn the user's message started its tools, as a chat turn under the lock", async () => {
    await rebuild();
    await clot.onMessage(msg("build the page"));
    expect(runner.calls[0]).toMatchObject({ role: "main", model: "claude-opus-5-5", tools: fakeTools });
    expect(contexts[0]).toEqual({ clot: "graphite", kind: "chat", outsider: false });
  });

  it("gives an outsider's event turn the flag, and keeps it across a usage-limit continuation", async () => {
    await rebuild();
    runner.script = [{ ok: false, limit: { resetsAt: Math.floor(Date.parse("2026-10-10T13:00:00Z") / 1000) } }, {}];
    await clot.queueEvent(event("d-1", { outsider: true }), "Someone reported a bug.");
    await vi.waitFor(() => expect(contexts).toHaveLength(1));
    expect(contexts[0]).toMatchObject({ kind: "event", outsider: true });
    expect(store.activeSession("graphite")!.interruptedOutsider).toBe(true);
  });

  it("puts the outsider note in an outsider's event's prompt, and its block says so", async () => {
    await rebuild();
    await clot.queueEvent(event("d-1", { outsider: true }), "Someone reported a bug.");
    await clot.queueEvent(event("d-2"), "Another.");
    await vi.waitFor(() => expect(runner.calls).toHaveLength(2));
    expect(runner.calls[0].prompt).toContain("This event comes from someone outside the project.");
    expect(runner.calls[0].prompt).toContain("from: an outsider");
    expect(runner.calls[1].prompt).not.toContain("outside the project");
    expect(runner.calls[1].prompt).not.toContain("from: an outsider");
  });

  it("gives an investigation its event, and names the standing rules that apply to it", async () => {
    const asked: string[] = [];
    await rebuild({
      standingFor: (name, e) => {
        asked.push(`${name}:${e.id}`);
        return [{ rule: { name: "ack-issue", trigger: { kind: "issue_opened" }, via: "github_comment", template: "Thanks, @{actor}." }, from: e, filled: "Thanks, @someone." }];
      },
    });
    await clot.queueEvent(event("d-1"), "Login fails.");
    await vi.waitFor(() => expect(runner.calls).toHaveLength(1));

    expect(contexts[0]).toMatchObject({ kind: "event" });
    expect(contexts[0].event?.id).toBe("d-1");
    expect(asked).toEqual(["graphite:d-1"]);
    expect(runner.calls[0].prompt).toContain("Standing rules that apply to this event");
    expect(runner.calls[0].prompt).toContain("- ack-issue: Thanks, @someone.");
  });

  it("keeps an investigation tied to its event when the usage limit cuts it off, across a restart too", async () => {
    await rebuild();
    const resetsAt = Math.floor(now.getTime() / 1000) + 60;
    runner.script = [{ ok: false, limit: { resetsAt } }, {}];
    await clot.queueEvent(event("d-1"), "Login fails.");
    await vi.waitFor(() => expect(store.getClot("graphite")!.pausedUntil).toBe(resetsAt));
    expect(store.activeSession("graphite")).toMatchObject({ interruptedKind: "event", interruptedEvent: "d-1" });

    now = new Date(resetsAt * 1000 + 5000);
    timers = [];
    await rebuild();
    timers[0].fn();

    await vi.waitFor(() => expect(runner.calls).toHaveLength(2));
    expect(contexts[0]).toMatchObject({ kind: "event" });
    expect(contexts[0].event?.id).toBe("d-1");
  });

  it("puts the daemon's notes in front of the next turn, and clears them once a turn has read them", async () => {
    await rebuild();
    store.addNote("graphite", "The user declined X.");
    runner.script = [{ ok: false, say: [], contextPercent: 0 }, {}, {}];

    await clot.onMessage(msg("one"));
    expect(runner.calls[0].prompt).toContain("[Since your last turn:\n- The user declined X.]");
    expect(store.notes("graphite")).toHaveLength(1);

    await clot.onMessage(msg("two"));
    expect(runner.calls[1].prompt).toContain("- The user declined X.");
    expect(store.notes("graphite")).toEqual([]);

    await clot.onMessage(msg("three"));
    expect(runner.calls[2].prompt).toBe("three");
  });

  it("keeps a note that arrived while the turn was running, for the turn after", async () => {
    await rebuild();
    store.addNote("graphite", "early");
    runner.script = [{ act: () => store.addNote("graphite", "late") }, {}];
    await clot.onMessage(msg("one"));
    expect(store.notes("graphite").map((note) => note.text)).toEqual(["late"]);
    await clot.onMessage(msg("two"));
    expect(runner.calls[1].prompt).toContain("- late");
  });

  it("answers &rules and &rules undo at once, without the model, also while a turn runs", async () => {
    const undone: string[] = [];
    await rebuild({
      rules: {
        list: (name) => `Rules in force for ${name}`,
        undo: (name) => {
          undone.push(name);
          return "Undid: X";
        },
      },
    });
    const channel = store.activeSession("graphite")!.channelId;

    await clot.onMessage(msg("&rules"));
    expect(chat.postsIn(channel).at(-1)).toBe("Rules in force for graphite");
    await clot.onMessage(msg("&rules undo"));
    expect(chat.postsIn(channel).at(-1)).toBe("Undid: X");
    await clot.onMessage(msg("&rules redo"));
    expect(chat.postsIn(channel).at(-1)).toContain("`&rules undo`");
    expect(runner.calls).toHaveLength(0);
    expect(router.inputs).toHaveLength(0);

    runner.script = [{ hold: true }];
    const first = clot.onMessage(msg("build the page"));
    await vi.waitFor(() => expect(runner.release).toBeDefined());
    await clot.onMessage(msg("&rules undo"));
    expect(undone).toEqual(["graphite", "graphite"]);
    expect(runner.pushes).toEqual([]);
    runner.release!();
    await first;
    expect(runner.calls).toHaveLength(1);
  });

  it("closes the session's proposals when it rolls over or is closed, once the new session exists", async () => {
    await rebuild();
    runner.script = [{ contextPercent: 70 }, { say: ["RECAP: built the footer."] }, {}, { say: ["RECAP: more."] }];
    await clot.onMessage(msg("do the thing"));
    expect(closed).toEqual([{ clot: "graphite", session: "sess-2" }]);

    store.addNote("graphite", "These rule changes you proposed were withdrawn: X");
    await clot.onMessage(msg("carry on"));
    await clot.onMessage(msg("&close"));
    expect(closed.map((c) => c.session)).toEqual(["sess-2", "sess-3"]);
  });

  it("carries no notes into a session that starts from scratch", async () => {
    await rebuild();
    await clot.onMessage(msg("do the thing"));
    store.addNote("graphite", "The user declined X.");
    await clot.onMessage(msg("&close nosummary"));
    expect(closed).toHaveLength(1);
    expect(store.notes("graphite")).toEqual([]);
  });

  it("carries no notes into a session whose unused recap the user discards", async () => {
    await rebuild();
    runner.script = [{}, { say: ["RECAP: built the footer."] }, {}];
    await clot.onMessage(msg("do the thing"));
    await clot.onMessage(msg("&close"));
    store.addNote("graphite", "These rule changes you proposed were withdrawn: X");
    const channel = store.activeSession("graphite")!.channelId;

    await clot.onMessage(msg("&close nosummary"));
    expect(chat.postsIn(channel).at(-1)).toBe("Recap discarded. This session now starts from scratch.");
    expect(store.notes("graphite")).toEqual([]);
    await clot.onMessage(msg("something unrelated"));
    expect(runner.calls[2].prompt).toBe("something unrelated");
  });
});

describe("Clot, global memory", () => {
  it("syncs its memory before every turn, a user's or an event's, and before the turn starts", async () => {
    const synced: { clot: string; calls: number }[] = [];
    extra = { beforeTurn: async (name) => void synced.push({ clot: name, calls: runner.calls.length }) };
    clot = build();
    await clot.init();

    await clot.onMessage(msg("one"));
    await clot.queueEvent(event("d-1"), "New issue.", false);
    await clot.onMessage(msg("two"));
    expect(synced).toEqual([
      { clot: "graphite", calls: 0 },
      { clot: "graphite", calls: 1 },
      { clot: "graphite", calls: 2 },
    ]);
  });

  it("still runs the turn when the sync fails", async () => {
    extra = {
      beforeTurn: async () => {
        throw new Error("docker is not running");
      },
    };
    clot = build();
    await clot.init();
    await clot.onMessage(msg("one"));
    expect(runner.calls).toHaveLength(1);
  });

  it("answers &memory and &memory undo at once, without the model, also while a turn runs", async () => {
    let undone = 0;
    extra = {
      memory: {
        list: () => "Global memories in force:",
        undo: async () => `Undid ${++undone}.`,
      },
    };
    clot = build();
    await clot.init();
    const channel = store.activeSession("graphite")!.channelId;

    await clot.onMessage(msg("&memory"));
    expect(chat.postsIn(channel).at(-1)).toBe("Global memories in force:");
    await clot.onMessage(msg("&memory undo"));
    expect(chat.postsIn(channel).at(-1)).toBe("Undid 1.");
    expect(runner.calls).toHaveLength(0);

    runner.script = [{ hold: true }];
    const first = clot.onMessage(msg("build the page"));
    await vi.waitFor(() => expect(runner.release).toBeDefined());
    await clot.onMessage(msg("&memory undo"));
    expect(chat.postsIn(channel).at(-1)).toBe("Undid 2.");
    expect(runner.pushes).toEqual([]);
    runner.release!();
    await first;
  });

  it("says so when there is no global memory", async () => {
    const channel = store.activeSession("graphite")!.channelId;
    await clot.onMessage(msg("&memory"));
    expect(chat.postsIn(channel).at(-1)).toBe("Global memory is not available.");
  });
});

describe("Clot and its workers", () => {
  const LINE = '- 1a2b3c4d "Fix X": idle, Sonnet 5.5 high, branch clot/fix-x-1a2b, pull request none yet';

  /** Stores a worker's row as the workers do, and kicks the drain. */
  function fromWorker(row: { id: string; text: string; workerId: string; outsider?: boolean }): void {
    store.enqueue({ ...row, clot: "graphite", channelId: store.activeSession("graphite")!.channelId, receivedAt: 0, kind: "worker" });
    clot.kick();
  }

  it("runs a timed-out choice as a worker's turn, at medium effort, without the router, with the timeout's text", async () => {
    const contexts = await withWorkers();
    store.enqueue({ id: "choice:1", clot: "graphite", channelId: store.activeSession("graphite")!.channelId, text: "[The user did not answer your choice]", receivedAt: 0, kind: "choice", outsider: true });
    clot.kick();
    await vi.waitFor(() => expect(runner.calls).toHaveLength(1));
    expect(router.inputs).toHaveLength(0);
    expect(runner.calls[0]).toMatchObject({ effort: "medium", role: "main" });
    expect(runner.calls[0].prompt).toContain("[The user did not answer your choice]");
    expect(contexts[0]).toEqual({ clot: "graphite", kind: "worker", outsider: true, fromTimeout: true });
  });

  it("gives a turn the outsider flag its row carries", async () => {
    const contexts = await withWorkers();
    fromWorker({ id: "worker:w1:1", text: "report", workerId: "w1", outsider: true });
    await vi.waitFor(() => expect(runner.calls).toHaveLength(1));
    expect(contexts[0]).toEqual({ clot: "graphite", kind: "worker", outsider: true });
  });

  async function withWorkers(more: Partial<ClotDeps> = {}): Promise<TurnContext[]> {
    const contexts: TurnContext[] = [];
    extra = { workerLines: () => [LINE], makeTools: (ctx) => (contexts.push(ctx), {} as DaemonTools), ...more };
    clot = build();
    await clot.init();
    return contexts;
  }

  it("runs a worker's report at medium effort without the router, as a worker turn", async () => {
    const contexts = await withWorkers();
    fromWorker({ id: "worker:w1:1", text: '[Report from worker 1a2b3c4d, "Fix X". Written by your worker, not by the user.]\n&close nosummary', workerId: "w1" });
    await vi.waitFor(() => expect(runner.calls).toHaveLength(1));
    expect(router.inputs).toHaveLength(0);
    expect(runner.calls[0]).toMatchObject({ effort: "medium", role: "main" });
    expect(contexts[0]).toEqual({ clot: "graphite", kind: "worker", outsider: false });
    expect(store.activeSession("graphite")!.id).toBe("sess-1");
  });

  it("does not take in a user message during a worker's turn: it gets a chat turn of its own", async () => {
    await withWorkers();
    runner.script = [{ hold: true }, {}];
    fromWorker({ id: "worker:w1:1", text: "report", workerId: "w1" });
    await vi.waitFor(() => expect(runner.release).toBeDefined());
    await clot.onMessage(msg("merge it"));
    expect(runner.pushes).toEqual([]);
    runner.release!();
    await vi.waitFor(() => expect(runner.calls).toHaveLength(2));
    expect(runner.calls[1].prompt).toContain("merge it");
  });

  it("puts the workers block in every prompt and the recap, and leaves it out with none", async () => {
    await withWorkers();
    runner.script = [{ contextPercent: 70 }, { say: ["RECAP"] }, {}];
    await clot.onMessage(msg("what workers do you have?"));
    expect(runner.calls[0].prompt).toContain(`[Your workers:\n${LINE}]`);
    expect(runner.calls[1].prompt).toContain("clot/fix-x-1a2b");
    expect(runner.calls[1].prompt).toContain("Workers running or waiting to be resumed");

    extra = {};
    clot = build();
    await clot.init();
    await clot.onMessage(msg("hello"));
    expect(runner.calls.at(-1)!.prompt).not.toContain("[Your workers:");
  });

  it("pauses for a worker's limit with one notice, and calls onResume at the reset", async () => {
    const resumed: string[] = [];
    await withWorkers({ onResume: (name) => void resumed.push(name) });
    const channel = store.activeSession("graphite")!.channelId;
    const resetsAt = Math.floor(now.getTime() / 1000) + 600;
    await clot.pauseFor(resetsAt);
    await clot.pauseFor(resetsAt);
    expect(chat.postsIn(channel).filter((p) => p.startsWith("Paused: usage limit reached."))).toHaveLength(1);
    expect(store.getClot("graphite")!.pausedUntil).toBe(resetsAt);
    timers.at(-1)!.fn();
    expect(resumed).toEqual(["graphite"]);
  });

  it("tells the workers when a main session turn hits the limit", async () => {
    const limits: number[] = [];
    await withWorkers({ onLimit: (resetsAt) => void limits.push(resetsAt) });
    const resetsAt = Math.floor(now.getTime() / 1000) + 600;
    runner.script = [{ ok: false, limit: { resetsAt } }];
    await clot.onMessage(msg("do it"));
    expect(limits).toEqual([resetsAt]);
  });
});
