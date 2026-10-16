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
    expect(told).toEqual(["email gmail (Clots) has failed three times in a row (login refused). I keep trying, waiting longer each time, and will say when it works again."]);
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
