import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRunner, TurnHandle, TurnRequest, TurnResult } from "../src/agent/runner.js";
import { FakeChat } from "../src/chat/fake.js";
import { Clot } from "../src/clot.js";
import { CacheKeeper, KEEP_WARM_AFTER_MS, KEEP_WARM_PROMPT, KEEP_WARM_RETRY_MS } from "../src/keep-warm.js";
import { Store } from "../src/store.js";
import type { Router } from "../src/router.js";

const MIN = 60_000;

describe("CacheKeeper", () => {
  function make(last: Record<string, number | undefined>) {
    const clock = { now: 1_000_000_000_000 };
    const pings: string[] = [];
    const keeper = new CacheKeeper({
      names: () => Object.keys(last),
      now: () => clock.now,
      lastTurnAt: (name) => last[name],
      ping: async (name) => {
        pings.push(name);
        // A ping is a turn: it starts the Clot's clock again.
        last[name] = clock.now;
      },
    });
    return { keeper, clock, pings, last };
  }

  it("pings a Clot 55 minutes after its own last turn, not before", async () => {
    const t0 = 1_000_000_000_000;
    const { keeper, clock, pings } = make({ a: t0 });
    clock.now = t0 + KEEP_WARM_AFTER_MS - 1;
    await keeper.tick();
    expect(pings).toEqual([]);
    clock.now = t0 + KEEP_WARM_AFTER_MS;
    await keeper.tick();
    expect(pings).toEqual(["a"]);
  });

  it("times each Clot from its own last turn", async () => {
    const t0 = 1_000_000_000_000;
    const { keeper, clock, pings } = make({ old: t0, recent: t0 + 30 * MIN, never: undefined });
    clock.now = t0 + 55 * MIN;
    await keeper.tick();
    expect(pings).toEqual(["old"]);
    clock.now = t0 + 84 * MIN;
    await keeper.tick();
    expect(pings).toEqual(["old"]);
    clock.now = t0 + 85 * MIN;
    await keeper.tick();
    expect(pings).toEqual(["old", "recent"]);
  });

  it("counts a ping as a turn: the next is due 55 minutes after it", async () => {
    const t0 = 1_000_000_000_000;
    const { keeper, clock, pings } = make({ a: t0 });
    clock.now = t0 + 55 * MIN;
    await keeper.tick();
    clock.now = t0 + 100 * MIN;
    await keeper.tick();
    expect(pings).toEqual(["a"]);
    clock.now = t0 + 110 * MIN;
    await keeper.tick();
    expect(pings).toEqual(["a", "a"]);
  });

  it("does not ping a Clot again while its ping is still running", async () => {
    const t0 = 1_000_000_000_000;
    let release!: () => void;
    const ping = vi.fn(() => new Promise<void>((resolve) => (release = resolve)));
    const keeper = new CacheKeeper({ names: () => ["a"], now: () => t0 + 60 * MIN, lastTurnAt: () => t0, ping });
    const first = keeper.tick();
    await keeper.tick();
    expect(ping).toHaveBeenCalledTimes(1);
    release();
    await first;
  });

  it("survives a ping that throws", async () => {
    const t0 = 1_000_000_000_000;
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const ping = vi.fn(async (name: string) => {
      if (name === "a") throw new Error("boom");
    });
    const keeper = new CacheKeeper({ names: () => ["a", "b"], now: () => t0 + 60 * MIN, lastTurnAt: () => t0, ping });
    await keeper.tick();
    expect(ping).toHaveBeenCalledTimes(2);
    error.mockRestore();
  });
});

describe("Clot.keepWarm", () => {
  class FakeRunner implements AgentRunner {
    calls: TurnRequest[] = [];
    release?: () => void;
    hold = false;
    ok = true;
    limit?: { resetsAt: number };
    startTurn(req: TurnRequest): TurnHandle {
      this.calls.push(req);
      const done = (async (): Promise<TurnResult> => {
        req.onText("ok");
        if (this.hold) await new Promise<void>((resolve) => (this.release = resolve));
        return { sessionId: req.resume ?? req.newSessionId ?? "", contextPercent: 10, ok: this.ok, ...(this.limit ? { limit: this.limit } : {}) };
      })();
      return { push: () => false, stop: () => undefined, done };
    }
  }

  let store: Store;
  let chat: FakeChat;
  let runner: FakeRunner;
  let clot: Clot;
  let now: Date;
  let log: string[];
  const router: Router = { decide: async () => ({ effort: "medium" }) };

  beforeEach(async () => {
    store = new Store(":memory:");
    chat = new FakeChat();
    runner = new FakeRunner();
    now = new Date("2026-10-10T12:00:00Z");
    log = [];
    let ids = 0;
    clot = new Clot({
      name: "graphite",
      store,
      chat,
      router,
      runner,
      timeZone: "UTC",
      userId: "user-1",
      rolloverPercent: 65,
      now: () => now,
      newId: () => `sess-${++ids}`,
      schedule: () => undefined,
      keepWarmLog: (name, text) => void log.push(`${name}: ${text}`),
    });
    await clot.init();
  });

  const channel = () => store.activeSession("graphite")!.channelId;
  const say = (text: string, id = text) => clot.onMessage({ id, channelId: channel(), authorId: "user-1", text, at: now });

  it("does nothing before the session has had a turn", async () => {
    await clot.keepWarm();
    expect(runner.calls).toEqual([]);
  });

  it("records the time of each real turn", async () => {
    expect(clot.lastTurnAt()).toBeUndefined();
    await say("hello");
    expect(clot.lastTurnAt()).toBe(now.getTime());
  });

  it("pings the session with tools refused, and keeps the ping and its reply out of chat and the tail", async () => {
    await say("hello");
    const posts = chat.postsIn(channel()).length;
    const tail = store.tail("graphite", 10).length;
    now = new Date(now.getTime() + KEEP_WARM_AFTER_MS);
    await clot.keepWarm();

    expect(runner.calls[1]).toMatchObject({ resume: "sess-1", prompt: KEEP_WARM_PROMPT, role: "main", noTools: true });
    expect(chat.postsIn(channel()).length).toBe(posts);
    expect(store.tail("graphite", 10).length).toBe(tail);
    expect(log).toEqual(["graphite: reply: ok"]);
    // The ping is a turn: the clock starts again.
    expect(clot.lastTurnAt()).toBe(now.getTime());
  });

  it("does not ping while a turn runs, and the ping makes a message wait, then run", async () => {
    await say("hello");
    runner.hold = true;
    const ping = clot.keepWarm();
    await vi.waitFor(() => expect(runner.release).toBeDefined());
    expect(clot.isBusy()).toBe(true);

    await clot.keepWarm();
    expect(runner.calls.filter((c) => c.prompt === KEEP_WARM_PROMPT)).toHaveLength(1);

    // A message that arrives during the ping is not run beside it.
    await say("second");
    expect(runner.calls).toHaveLength(2);

    runner.hold = false;
    runner.release!();
    await ping;
    await vi.waitFor(() => expect(runner.calls).toHaveLength(3));
    expect(runner.calls[2].prompt).toBe("second");
  });

  it("is not started beside a real turn", async () => {
    runner.hold = true;
    const turn = say("hello");
    await vi.waitFor(() => expect(runner.release).toBeDefined());
    await clot.keepWarm();
    expect(runner.calls).toHaveLength(1);
    runner.hold = false;
    runner.release!();
    await turn;
  });

  it("tries a failed ping again only after the retry delay", async () => {
    await say("hello");
    const first = clot.lastTurnAt();
    runner.ok = false;
    now = new Date(now.getTime() + KEEP_WARM_AFTER_MS);
    await clot.keepWarm();
    expect(runner.calls).toHaveLength(2);
    // A failed ping does not start the clock again.
    expect(clot.lastTurnAt()).toBe(first);
    await clot.keepWarm();
    expect(runner.calls).toHaveLength(2);
    now = new Date(now.getTime() + KEEP_WARM_RETRY_MS);
    await clot.keepWarm();
    expect(runner.calls).toHaveLength(3);
  });

  it("pauses the Clot when the ping hits the usage limit, and does not ping while it is paused", async () => {
    await say("hello");
    runner.limit = { resetsAt: Math.floor(now.getTime() / 1000) + 3600 };
    await clot.keepWarm();
    expect(store.getClot("graphite")!.pausedUntil).not.toBeNull();
    await clot.keepWarm();
    expect(runner.calls).toHaveLength(2);
  });
});
