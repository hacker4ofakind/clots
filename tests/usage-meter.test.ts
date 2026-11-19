import { describe, expect, it, vi } from "vitest";
import type { UsageSnapshot } from "../src/gates.js";
import { UsageMeter } from "../src/usage-meter.js";

function fakeStore() {
  const state = new Map<string, string>();
  return { state, getState: (k: string) => state.get(k), setState: (k: string, v: string) => void state.set(k, v) };
}
const MIN = 60_000;

function make(read: () => Promise<UsageSnapshot | undefined> = async () => undefined, store = fakeStore(), start = 1_000_000_000_000) {
  const clock = { now: start };
  const meter = new UsageMeter({ store, now: () => clock.now, read });
  return { meter, clock, store };
}

describe("observe", () => {
  it("takes both windows from an event, converting seconds to milliseconds", () => {
    const { meter, clock } = make();
    const resetsAt = (clock.now + 3_600_000) / 1000;
    meter.observe({ status: "allowed", type: "five_hour", windows: { five_hour: { utilization: 54, resetsAt }, seven_day: { utilization: 31, resetsAt: resetsAt + 86_400 } } });
    expect(meter.fiveHour()).toMatchObject({ percent: 54, resetsAt: resetsAt * 1000 });
    expect(meter.sevenDay()?.percent).toBe(31);
  });

  it("takes a single window from the event's own type", () => {
    const { meter, clock } = make();
    meter.observe({ status: "allowed", type: "five_hour", utilization: 12, resetsAt: (clock.now + MIN) / 1000 });
    expect(meter.fiveHour()?.percent).toBe(12);
    expect(meter.sevenDay()).toBeUndefined();
  });

  it("ignores other window types and events with no utilization or no reset", () => {
    const { meter, clock } = make();
    const resetsAt = (clock.now + MIN) / 1000;
    meter.observe({ status: "allowed", type: "seven_day_opus", utilization: 90, resetsAt });
    meter.observe({ status: "allowed", type: "five_hour", resetsAt });
    meter.observe({ status: "allowed", type: "five_hour", utilization: 90 });
    expect(meter.fiveHour()).toBeUndefined();
    meter.observe({ status: "allowed", type: "five_hour", utilization: 40, resetsAt });
    meter.observe({ status: "allowed", type: "five_hour", resetsAt });
    expect(meter.fiveHour()?.percent).toBe(40);
  });

  it("has no five-hour reading once its window has reset", () => {
    const { meter, clock } = make();
    meter.observe({ status: "allowed", type: "five_hour", utilization: 60, resetsAt: (clock.now + MIN) / 1000 });
    expect(meter.fiveHour()).toBeDefined();
    clock.now += 2 * MIN;
    expect(meter.fiveHour()).toBeUndefined();
  });

  it("tells listeners when a reading changes, not when it repeats", () => {
    const { meter, clock } = make();
    const fn = vi.fn();
    meter.onChange(fn);
    const e = { status: "allowed" as const, type: "five_hour", utilization: 10, resetsAt: (clock.now + MIN) / 1000 };
    meter.observe(e);
    meter.observe(e);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("keeps its readings across a restart", () => {
    const { meter, clock, store } = make();
    meter.observe({ status: "allowed", type: "five_hour", utilization: 60, resetsAt: (clock.now + 3_600_000) / 1000 });
    const { meter: restarted } = make(undefined, store, clock.now);
    expect(restarted.fiveHour()?.percent).toBe(60);
  });
});

describe("refresh", () => {
  const answer = (percent: number, now: number): UsageSnapshot => ({ fiveHour: { percent, resetsAt: now + 3_600_000, readAt: now } });

  it("makes no call while the reading is younger than the age asked for", async () => {
    const read = vi.fn(async () => answer(10, 0));
    const { meter, clock } = make(read);
    meter.observe({ status: "allowed", type: "five_hour", utilization: 20, resetsAt: (clock.now + 3_600_000) / 1000 });
    clock.now += 2 * MIN;
    await meter.refresh(5 * MIN);
    expect(read).not.toHaveBeenCalled();
    clock.now += 4 * MIN;
    await meter.refresh(5 * MIN);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("makes one call for two at once", async () => {
    let release!: (s: UsageSnapshot) => void;
    const read = vi.fn(() => new Promise<UsageSnapshot | undefined>((r) => (release = r)));
    const { meter, clock } = make(read);
    const a = meter.refresh(0);
    const b = meter.refresh(0);
    release(answer(33, clock.now));
    await Promise.all([a, b]);
    expect(read).toHaveBeenCalledTimes(1);
    expect(meter.fiveHour()?.percent).toBe(33);
  });

  it("keeps the old reading when a call fails, and retries after 5, 10, 20 and 60 minutes", async () => {
    const read = vi.fn(async () => undefined);
    const { meter, clock } = make(read);
    meter.observe({ status: "allowed", type: "five_hour", utilization: 70, resetsAt: (clock.now + 10 * 3_600_000) / 1000 });
    clock.now += 10 * MIN;
    await meter.refresh(5 * MIN);
    expect(meter.fiveHour()?.percent).toBe(70);
    expect(read).toHaveBeenCalledTimes(1);
    let calls = 1;
    for (const wait of [5, 10, 20, 60, 60]) {
      clock.now += (wait - 1) * MIN;
      await meter.refresh(0);
      expect(read).toHaveBeenCalledTimes(calls);
      clock.now += MIN;
      await meter.refresh(0);
      calls += 1;
      expect(read).toHaveBeenCalledTimes(calls);
    }
    expect(meter.failing).toBe(true);
  });

  it("keeps a reading a rate-limit event gave while a slow call was out", async () => {
    let release!: (s: UsageSnapshot) => void;
    const { meter, clock } = make(() => new Promise<UsageSnapshot | undefined>((r) => (release = r)));
    meter.observe({ status: "allowed", type: "five_hour", utilization: 20, resetsAt: (clock.now + 3_600_000) / 1000 });
    clock.now += 10 * MIN;
    const pending = meter.refresh(5 * MIN);
    clock.now += MIN;
    meter.observe({ status: "allowed", type: "five_hour", utilization: 80, resetsAt: (clock.now + 3_600_000) / 1000 });
    clock.now += MIN;
    release({ fiveHour: { percent: 30, resetsAt: clock.now + 3_600_000, readAt: clock.now }, sevenDay: { percent: 5, resetsAt: clock.now + 86_400_000, readAt: clock.now } });
    await pending;
    expect(meter.fiveHour()?.percent).toBe(80);
    expect(meter.sevenDay()?.percent).toBe(5);
  });

  it("leaves a window alone when the answer has nothing for it", async () => {
    const { meter, clock } = make(async () => ({ sevenDay: { percent: 5, resetsAt: clock.now + 86_400_000, readAt: clock.now } }));
    meter.observe({ status: "allowed", type: "five_hour", utilization: 44, resetsAt: (clock.now + 3_600_000) / 1000 });
    clock.now += 10 * MIN;
    await meter.refresh(5 * MIN);
    expect(meter.fiveHour()?.percent).toBe(44);
    expect(meter.sevenDay()?.percent).toBe(5);
  });

  it("starts again after a success", async () => {
    let ok = false;
    const read = vi.fn(async () => (ok ? answer(1, clock.now) : undefined));
    const { meter, clock } = make(read);
    await meter.refresh(0);
    ok = true;
    clock.now += 5 * MIN;
    await meter.refresh(0);
    expect(meter.failing).toBe(false);
    expect(meter.fiveHour()?.percent).toBe(1);
  });
});
