import { beforeEach, describe, expect, it, vi } from "vitest";
import { Clot } from "../src/clot.js";
import { Store } from "../src/store.js";
import { FakeChat } from "../src/chat/fake.js";
import type { AgentRunner, TurnHandle, TurnRequest, TurnResult } from "../src/agent/runner.js";
import type { Router, RouterInput } from "../src/router.js";
import type { Effort, RouterDecision, TurnActivity } from "../src/types.js";
import type { InboundMessage } from "../src/chat/adapter.js";

interface Step {
  say?: string[];
  contextPercent?: number;
  ok?: boolean;
  limit?: { resetsAt: number };
  hold?: boolean;
  activity?: TurnActivity;
}

class FakeRunner implements AgentRunner {
  calls: TurnRequest[] = [];
  pushes: { text: string; effort: Effort }[] = [];
  script: Step[] = [];
  release?: () => void;
  acceptPushes = true;

  startTurn(req: TurnRequest): TurnHandle {
    this.calls.push(req);
    const step = this.script.shift() ?? {};
    const done = (async (): Promise<TurnResult> => {
      for (const line of step.say ?? ["ok"]) req.onText(line);
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
      done,
    };
  }
}

class FakeRouter implements Router {
  inputs: RouterInput[] = [];
  next: RouterDecision[] = [];
  async decide(input: RouterInput): Promise<RouterDecision> {
    this.inputs.push(input);
    return this.next.shift() ?? { effort: "medium", modeChange: "none" };
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
  });
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
  clot = build();
  await clot.init();
});

describe("Clot", () => {
  it("creates a category, a first channel and a session on init", () => {
    expect(chat.channels.map((c) => c.name)).toEqual(["graphite-1010"]);
    expect(store.activeSession("graphite")).toMatchObject({ id: "sess-1", started: false });
  });

  it("starts a new session on the first message and posts the reply", async () => {
    router.next = [{ effort: "low", modeChange: "none" }];
    runner.script = [{ say: ["On it."] }];
    const channel = store.activeSession("graphite")!.channelId;

    await clot.onMessage(msg("check the footer link"));

    expect(runner.calls[0]).toMatchObject({ newSessionId: "sess-1", effort: "low", planMode: false, prompt: "check the footer link" });
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

  it("enters brainstorm mode, announces it, and uses plan mode until told to work", async () => {
    const channel = store.activeSession("graphite")!.channelId;
    router.next = [
      { effort: "medium", modeChange: "enter_brainstorm" },
      { effort: "medium", modeChange: "none" },
      { effort: "medium", modeChange: "exit_brainstorm" },
    ];

    await clot.onMessage(msg("let's brainstorm"));
    await clot.onMessage(msg("what about mobile?"));
    await clot.onMessage(msg("sounds good, start working"));

    expect(runner.calls.map((c) => c.planMode)).toEqual([true, true, false]);
    expect(runner.calls[1].prompt).toContain("Brainstorm mode is ON");
    expect(runner.calls[2].prompt).toContain("Brainstorm mode is OFF");
    expect(chat.postsIn(channel)).toContain("Brainstorm mode on.");
    expect(chat.postsIn(channel)).toContain("Brainstorm mode off. Back to work.");
    expect(store.getClot("graphite")!.mode).toBe("action");
  });

  it("pushes a message that arrives during a turn instead of starting another", async () => {
    runner.script = [{ hold: true }];
    router.next = [{ effort: "medium", modeChange: "none" }, { effort: "low", modeChange: "none" }];

    const first = clot.onMessage(msg("build the page"));
    await vi.waitFor(() => expect(runner.release).toBeDefined());
    await clot.onMessage(msg("meanwhile, check if Fable 5.5 is out"));
    runner.release!();
    await first;

    expect(runner.calls).toHaveLength(1);
    expect(runner.pushes).toEqual([{ text: "[sent while you were working]\nmeanwhile, check if Fable 5.5 is out", effort: "low" }]);
    expect(store.nextPending("graphite")).toBeUndefined();
  });

  it("holds back a mid-turn message that starts brainstorming and runs it next, in plan mode", async () => {
    const channel = store.activeSession("graphite")!.channelId;
    runner.script = [{ hold: true }, {}];
    router.next = [
      { effort: "medium", modeChange: "none" },
      { effort: "medium", modeChange: "enter_brainstorm" },
      { effort: "medium", modeChange: "enter_brainstorm" },
    ];

    const first = clot.onMessage(msg("build the page"));
    await vi.waitFor(() => expect(runner.release).toBeDefined());
    await clot.onMessage(msg("wait, let's brainstorm first"));
    expect(runner.pushes).toEqual([]);
    runner.release!();
    await first;

    expect(runner.calls.map((c) => c.planMode)).toEqual([false, true]);
    expect(chat.postsIn(channel)).toContain("Brainstorm mode on.");
    expect(store.getClot("graphite")!.mode).toBe("brainstorm");
  });

  it("holds back a mid-turn message that ends brainstorming and runs it next, with writes allowed", async () => {
    const channel = store.activeSession("graphite")!.channelId;
    store.setMode("graphite", "brainstorm");
    runner.script = [{ hold: true }, {}];
    router.next = [
      { effort: "medium", modeChange: "none" },
      { effort: "medium", modeChange: "exit_brainstorm" },
      { effort: "medium", modeChange: "exit_brainstorm" },
    ];

    const first = clot.onMessage(msg("what about mobile?"));
    await vi.waitFor(() => expect(runner.release).toBeDefined());
    await clot.onMessage(msg("ok, create it"));
    expect(runner.pushes).toEqual([]);
    runner.release!();
    await first;

    expect(runner.calls.map((c) => c.planMode)).toEqual([true, false]);
    expect(chat.postsIn(channel)).toContain("Brainstorm mode off. Back to work.");
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

  it("keeps later messages behind a deferred mode change instead of feeding them to the writable turn", async () => {
    runner.script = [{ hold: true }, {}, {}];
    router.next = [
      { effort: "medium", modeChange: "none" },
      { effort: "medium", modeChange: "enter_brainstorm" },
      { effort: "medium", modeChange: "enter_brainstorm" },
      { effort: "medium", modeChange: "none" },
    ];

    const first = clot.onMessage(msg("build the page"));
    await vi.waitFor(() => expect(runner.release).toBeDefined());
    await clot.onMessage(msg("wait, let's brainstorm first"));
    await clot.onMessage(msg("I'm unsure about the hero section"));
    expect(runner.pushes).toEqual([]);
    runner.release!();
    await first;

    expect(runner.calls.map((c) => c.planMode)).toEqual([false, true, true]);
    expect(runner.calls[2].prompt).toContain("I'm unsure about the hero section");
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

    expect(runner.calls[1]).toMatchObject({ resume: "sess-1", planMode: true });
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
      router.next = [{ effort: "low", modeChange: "none" }];
      await clot.onMessage(msg("&effort high refactor the auth module"));
      expect(runner.calls[0]).toMatchObject({ effort: "high", prompt: "refactor the auth module" });
      expect(router.inputs[0].text).toBe("refactor the auth module");
    });

    it("&effort alone applies to the next message only", async () => {
      const channel = store.activeSession("graphite")!.channelId;
      router.next = [{ effort: "low", modeChange: "none" }, { effort: "low", modeChange: "none" }];

      await clot.onMessage(msg("&effort high"));
      expect(runner.calls).toHaveLength(0);
      expect(chat.postsIn(channel).at(-1)).toBe("Effort for your next message: high.");

      await clot.onMessage(msg("plan the migration"));
      await clot.onMessage(msg("and the rollback"));
      expect(runner.calls.map((c) => c.effort)).toEqual(["high", "low"]);
    });

    it("&effort still lets the router change the mode", async () => {
      router.next = [{ effort: "low", modeChange: "enter_brainstorm" }];
      await clot.onMessage(msg("&effort high let's brainstorm the pricing"));
      expect(runner.calls[0]).toMatchObject({ effort: "high", planMode: true });
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

      expect(runner.calls[1]).toMatchObject({ resume: "sess-1", planMode: true });
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

    it("&close nosummary starts from scratch: no recap turn, no seed, action mode, empty router context", async () => {
      const oldChannel = store.activeSession("graphite")!.channelId;
      await clot.onMessage(msg("do the thing"));
      store.setMode("graphite", "brainstorm");

      await clot.onMessage(msg("&close nosummary"));

      expect(runner.calls).toHaveLength(1);
      const fresh = store.activeSession("graphite")!;
      expect(fresh).toMatchObject({ id: "sess-2", seed: null, started: false });
      expect(chat.postsIn(fresh.channelId)[0]).toContain("from scratch at your request");
      expect(chat.readOnly.has(oldChannel)).toBe(true);
      expect(store.getClot("graphite")!.mode).toBe("action");

      await clot.onMessage(msg("hello"));
      expect(runner.calls[1]).toMatchObject({ newSessionId: "sess-2", prompt: "hello", planMode: false });
      expect(router.inputs.at(-1)!.tail).toEqual([]);
    });

    it("&effort alone is used up by the next message even when that message joins a running turn", async () => {
      runner.script = [{ hold: true }, {}];
      router.next = [{ effort: "medium", modeChange: "none" }, { effort: "low", modeChange: "none" }, { effort: "low", modeChange: "none" }];

      const first = clot.onMessage(msg("build the page"));
      await vi.waitFor(() => expect(runner.release).toBeDefined());
      await clot.onMessage(msg("&effort high"));
      await clot.onMessage(msg("also check the footer"));
      expect(runner.pushes).toEqual([{ text: "[sent while you were working]\nalso check the footer", effort: "high" }]);
      runner.release!();
      await first;

      await clot.onMessage(msg("and the header"));
      expect(runner.calls[1].effort).toBe("low");
    });

    it("&effort alone is kept when the running turn refuses the message", async () => {
      runner.script = [{ hold: true }, {}];
      runner.acceptPushes = false;
      router.next = [{ effort: "medium", modeChange: "none" }, { effort: "low", modeChange: "none" }, { effort: "low", modeChange: "none" }];

      const first = clot.onMessage(msg("build the page"));
      await vi.waitFor(() => expect(runner.release).toBeDefined());
      await clot.onMessage(msg("&effort high"));
      await clot.onMessage(msg("also check the footer"));
      runner.release!();
      await first;

      expect(runner.calls[1]).toMatchObject({ prompt: "also check the footer", effort: "high" });
    });

    it("an explicit &effort on the next message replaces an earlier &effort, which is then spent", async () => {
      await clot.onMessage(msg("&effort high"));
      await clot.onMessage(msg("&effort low check the link"));
      await clot.onMessage(msg("and the footer"));
      expect(runner.calls.map((c) => c.effort)).toEqual(["low", "medium"]);
    });

    it("&close nosummary discards a recap the new session has not used yet", async () => {
      runner.script = [{ contextPercent: 70 }, { say: ["RECAP"] }, {}];
      await clot.onMessage(msg("do the thing"));
      const channel = store.activeSession("graphite")!.channelId;
      store.setMode("graphite", "brainstorm");

      await clot.onMessage(msg("&close nosummary"));

      expect(store.activeSession("graphite")).toMatchObject({ id: "sess-2", channelId: channel, seed: null });
      expect(chat.postsIn(channel).at(-1)).toBe("Recap discarded. This session now starts from scratch.");
      expect(runner.calls).toHaveLength(2);

      await clot.onMessage(msg("hello"));
      expect(runner.calls[2]).toMatchObject({ newSessionId: "sess-2", prompt: "hello", planMode: false });
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
