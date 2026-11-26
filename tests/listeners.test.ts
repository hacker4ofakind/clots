import { beforeEach, describe, expect, it } from "vitest";
import { retryWait, Supervisor, TELL_AFTER } from "../src/listeners.js";

let timers: { ms: number; fn: () => void; cancelled: boolean }[];
let told: string[];
let supervisor: Supervisor;

/** Runs the next wait that is due, and lets what it started settle. */
async function next(): Promise<number> {
  const timer = timers.shift()!;
  if (!timer.cancelled) timer.fn();
  await new Promise((resolve) => setImmediate(resolve));
  return timer.ms;
}

beforeEach(() => {
  timers = [];
  told = [];
  supervisor = new Supervisor({
    schedule: (ms, fn) => {
      const timer = { ms, fn, cancelled: false };
      timers.push(timer);
      return () => void (timer.cancelled = true);
    },
  });
});

describe("retryWait", () => {
  it("doubles from thirty seconds and stops at an hour", () => {
    expect([1, 2, 3, 4].map(retryWait)).toEqual([30_000, 60_000, 120_000, 240_000]);
    expect(retryWait(20)).toBe(3_600_000);
  });
});

describe("Supervisor with a minimum retry wait", () => {
  it("waits at least that long after each failure, so a poll that costs something is not retried faster than it runs", async () => {
    let runs = 0;
    const fifteen = 15 * 60_000;
    supervisor.start({ name: "reddit watch", everyMs: fifteen, minRetryMs: fifteen, tell: async (t) => void told.push(t), run: async () => (runs += 1, Promise.reject(new Error("HTTP 429"))) });
    await new Promise((resolve) => setImmediate(resolve));
    expect(runs).toBe(1);
    // Four failures in a row: every wait is the interval, not 30 s, 1 m, 2 m, 4 m.
    const waits = [await next(), await next(), await next()];
    expect(waits).toEqual([fifteen, fifteen, fifteen]);
    expect(runs).toBe(4);
    expect(told).toHaveLength(1);
  });

  it("does not shorten a longer backoff, and a run that works waits its interval as before", async () => {
    let fail = true;
    supervisor.start({ name: "w", everyMs: 60_000, minRetryMs: 60_000, tell: async () => undefined, run: async () => (fail ? Promise.reject(new Error("x")) : undefined) });
    await new Promise((resolve) => setImmediate(resolve));
    const waits: number[] = [];
    for (let i = 0; i < 8; i++) waits.push(await next());
    // 30 s and 1 m are raised to the minute; later waits keep doubling past it.
    expect(waits).toEqual([60_000, 60_000, 120_000, 240_000, 480_000, 960_000, 1_920_000, 3_600_000]);
    fail = false;
    expect(await next()).toBe(3_600_000);
    expect(await next()).toBe(60_000);
  });

  it("leaves a listener without a minimum as it was", async () => {
    supervisor.start({ name: "x", everyMs: 300_000, tell: async () => undefined, run: async () => Promise.reject(new Error("x")) });
    await new Promise((resolve) => setImmediate(resolve));
    expect(await next()).toBe(30_000);
  });
});

describe("Supervisor", () => {
  it("runs a poll again after its interval while it works", async () => {
    let runs = 0;
    supervisor.start({ name: "feed", everyMs: 300_000, tell: async (t) => void told.push(t), run: async () => void (runs += 1) });
    await new Promise((resolve) => setImmediate(resolve));
    expect(runs).toBe(1);
    expect(await next()).toBe(300_000);
    expect(runs).toBe(2);
    expect(told).toEqual([]);
  });

  it("waits longer after each failure, tells the user after three in a row, and again when it works", async () => {
    let fail = true;
    supervisor.start({ name: "email gmail (Clots)", everyMs: 0, tell: async (t) => void told.push(t), run: async (ready) => {
      if (fail) throw new Error("login refused");
      ready();
      await new Promise(() => undefined);
    } });
    await new Promise((resolve) => setImmediate(resolve));
    expect(await next()).toBe(30_000);
    expect(await next()).toBe(60_000);
    expect(told).toEqual(["email gmail (Clots) has failed three times in a row (login refused). I'll keep trying, a little less often each time, and tell you when it works again."]);
    expect(TELL_AFTER).toBe(3);
    fail = false;
    expect(await next()).toBe(120_000);
    expect(told[1]).toBe("email gmail (Clots) works again.");
  });

  it("counts failures afresh once a connection has worked", async () => {
    let runs = 0;
    supervisor.start({ name: "imap", everyMs: 0, tell: async (t) => void told.push(t), run: async (ready) => {
      runs += 1;
      ready();
      throw new Error("connection dropped");
    } });
    await new Promise((resolve) => setImmediate(resolve));
    for (let i = 0; i < 4; i += 1) expect(await next()).toBe(30_000);
    expect(runs).toBe(5);
    expect(told).toEqual([]);
  });

  it("stops one listener and leaves the others running", async () => {
    let a = 0;
    let b = 0;
    const stopA = supervisor.start({ name: "a", everyMs: 1000, tell: async () => undefined, run: async () => void (a += 1) });
    supervisor.start({ name: "b", everyMs: 1000, tell: async () => undefined, run: async () => void (b += 1) });
    await new Promise((resolve) => setImmediate(resolve));
    stopA();
    await next();
    await next();
    expect([a, b]).toEqual([1, 2]);
  });

  it("stops", async () => {
    let runs = 0;
    supervisor.start({ name: "feed", everyMs: 1000, tell: async () => undefined, run: async () => void (runs += 1) });
    await new Promise((resolve) => setImmediate(resolve));
    supervisor.stop();
    await next();
    expect(runs).toBe(1);
  });
});
