import { beforeEach, describe, expect, it, vi } from "vitest";
import { Clot } from "../src/clot.js";
import { Store } from "../src/store.js";
import { FakeChat } from "../src/chat/fake.js";
import type { AgentRunner, TurnHandle, TurnRequest, TurnResult } from "../src/agent/runner.js";
import type { Router, RouterInput } from "../src/router.js";
import type { Effort, RouterDecision } from "../src/types.js";
import type { InboundMessage } from "../src/chat/adapter.js";

interface Step {
  say?: string[];
  contextPercent?: number;
  ok?: boolean;
  limit?: { resetsAt: number };
  hold?: boolean;
}

class FakeRunner implements AgentRunner {
  calls: TurnRequest[] = [];
  pushes: { text: string; effort: Effort }[] = [];
  script: Step[] = [];
  release?: () => void;

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
      };
    })();
    return { push: (text, effort) => void this.pushes.push({ text, effort }), done };
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

  it("asks the session to continue after a pause when nothing is queued", async () => {
    const resetsAt = Math.floor(now.getTime() / 1000) + 60;
    runner.script = [{ ok: false, limit: { resetsAt } }, {}];
    await clot.onMessage(msg("big task"));

    now = new Date(resetsAt * 1000);
    timers[0].fn();
    await vi.waitFor(() => expect(runner.calls).toHaveLength(2));
    expect(runner.calls[1].prompt).toContain("The usage limit has reset");
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
