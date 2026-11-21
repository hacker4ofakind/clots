import { describe, expect, it, vi } from "vitest";
import { GateTicker } from "../src/gate-ticker.js";
import type { GateConfig, UsageSnapshot } from "../src/gates.js";
import { wallClock } from "../src/time.js";

const days = ["mon", "tue", "wed", "thu", "fri"] as const;
const windows = (start: number, end: number) => Object.fromEntries(days.map((d) => [d, { start, end }]));
const CFG: GateConfig = { scarce: windows(900, 1080), leadIn: windows(600, 900), leadInPercent: 50 };
const at = (h: number, m = 0) => wallClock(2026, 11, 9, h, m, 0, "UTC").getTime();

function make(over: Partial<ConstructorParameters<typeof GateTicker>[0]> = {}) {
  const clock = { now: at(9, 0) };
  let usage: UsageSnapshot = {};
  const refresh = vi.fn(async () => undefined);
  const d = {
    meter: { refresh, snapshot: () => usage },
    gates: CFG,
    timeZone: "UTC",
    now: () => clock.now,
    kickAll: vi.fn(),
    wakeWorkers: vi.fn(),
    sweep: vi.fn(async () => undefined),
    ...over,
  };
  return { ticker: new GateTicker(d), clock, d, refresh, setUsage: (u: UsageSnapshot) => (usage = u) };
}

describe("GateTicker", () => {
  it("starts the keep-warm pings on every tick without waiting for them", async () => {
    const keepWarm = vi.fn(() => new Promise<void>(() => undefined));
    const { ticker } = make({ keepWarm });
    await ticker.tick();
    await ticker.tick();
    expect(keepWarm).toHaveBeenCalledTimes(2);
  });

  it("wakes everything at startup and when the gate starts or stops, not on every tick", async () => {
    const { ticker, clock, d } = make();
    await ticker.tick();
    expect(d.kickAll).toHaveBeenCalledTimes(1);
    expect(d.wakeWorkers).toHaveBeenCalledTimes(1);
    await ticker.tick();
    expect(d.kickAll).toHaveBeenCalledTimes(1);
    clock.now = at(15, 0);
    await ticker.tick();
    expect(d.kickAll).toHaveBeenCalledTimes(2);
    clock.now = at(16, 0);
    await ticker.tick();
    expect(d.kickAll).toHaveBeenCalledTimes(2);
    clock.now = at(18, 0);
    await ticker.tick();
    expect(d.kickAll).toHaveBeenCalledTimes(3);
  });

  it("wakes when a new reading puts a lead-in over its threshold", () => {
    const { ticker, clock, d, setUsage } = make();
    clock.now = at(12, 0);
    ticker.recheck();
    expect(d.kickAll).toHaveBeenCalledTimes(1);
    setUsage({ fiveHour: { percent: 60, resetsAt: at(14), readAt: clock.now } });
    ticker.recheck();
    expect(d.kickAll).toHaveBeenCalledTimes(2);
    expect(ticker.gate().holds).toBe("leadIn");
  });

  it("refreshes the usage only inside a lead-in window", async () => {
    const { ticker, clock, refresh } = make();
    await ticker.tick();
    expect(refresh).not.toHaveBeenCalled();
    clock.now = at(11, 0);
    await ticker.tick();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("catches an error in any step and goes on", async () => {
    const { ticker, d } = make({ sweep: vi.fn(async () => Promise.reject(new Error("sweep"))), kickAll: vi.fn(() => { throw new Error("kick"); }) });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(ticker.tick()).resolves.toBeUndefined();
    expect(d.sweep).toHaveBeenCalled();
    const refreshing = make({ meter: { refresh: async () => { throw new Error("read"); }, snapshot: () => ({}) } });
    refreshing.clock.now = at(11, 0);
    await expect(refreshing.ticker.tick()).resolves.toBeUndefined();
    expect(refreshing.d.kickAll).toHaveBeenCalled();
  });

  it("does not wait for the sweep", async () => {
    let finish!: () => void;
    const { ticker, d } = make({ sweep: vi.fn(() => new Promise<void>((r) => (finish = r))) });
    await ticker.tick();
    expect(d.sweep).toHaveBeenCalled();
    finish();
  });
});
