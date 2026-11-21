import { beforeEach, describe, expect, it } from "vitest";
import { ALLOWANCE, Meter } from "../src/composio/meter.js";
import { Store } from "../src/store.js";

let store: Store;
let told: string[];
let clock: number;
let meter: Meter;

beforeEach(() => {
  store = new Store(":memory:");
  told = [];
  clock = Date.UTC(2026, 10, 19);
  meter = new Meter({ store, now: () => clock, tellHome: async (t) => void told.push(t) });
});

describe("Meter", () => {
  it("says how much of a pool's calls and events is used, as fractions, for the recipe read budget", async () => {
    expect(meter.used(true)).toEqual({ calls: 0, events: 0 });
    await meter.count("call", "slack:work", true, ALLOWANCE.calls.managed * 0.8);
    await meter.count("delivery", "slack:work", true, ALLOWANCE.events.managed * 0.25);
    expect(meter.used(true)).toEqual({ calls: 0.8, events: 0.25 });
    expect(meter.used(false)).toEqual({ calls: 0, events: 0 });
  });

  it("counts tool calls and deliveries per calendar month, managed apps apart", async () => {
    await meter.count("call", "linear:proton", false, 3);
    await meter.count("call", "googlecalendar:personal", true, 2);
    await meter.count("delivery", "linear:proton", false);
    expect(meter.usage()).toMatchObject({ calls: { own: 3, managed: 2 }, events: { own: 1, managed: 0 } });
    clock = Date.UTC(2026, 11, 2);
    expect(meter.usage()).toMatchObject({ calls: { own: 0, managed: 0 }, events: { own: 0, managed: 0 } });
    await meter.count("call", "linear:proton", false);
    expect(meter.usage().calls.own).toBe(1);
  });

  it("warns once at 70% and once at 90% of an allowance, naming the biggest consumers", async () => {
    await meter.count("call", "linear:proton", false, ALLOWANCE.calls.own * 0.5);
    await meter.count("call", "notion:main", false, ALLOWANCE.calls.own * 0.1);
    expect(told).toEqual([]);
    await meter.count("call", "notion:main", false, ALLOWANCE.calls.own * 0.11);
    expect(told).toHaveLength(1);
    expect(told[0]).toContain("70%");
    expect(told[0]).toContain("tool calls");
    expect(told[0].indexOf("linear:proton")).toBeLessThan(told[0].indexOf("notion:main"));
    await meter.count("call", "notion:main", false, 10);
    expect(told).toHaveLength(1);
    await meter.count("call", "notion:main", false, ALLOWANCE.calls.own * 0.2);
    expect(told).toHaveLength(2);
    expect(told[1]).toContain("90%");
  });

  it("measures each allowance on its own: events, and the managed apps' smaller ones", async () => {
    await meter.count("delivery", "linear:proton", false, ALLOWANCE.events.own * 0.71);
    expect(told.filter((t) => t.includes("trigger events"))).toHaveLength(1);
    await meter.count("call", "googlecalendar:personal", true, ALLOWANCE.calls.managed * 0.71);
    expect(told.filter((t) => t.includes("Composio-managed"))).toHaveLength(1);
  });

  it("warns again in the next month", async () => {
    await meter.count("call", "linear:proton", false, ALLOWANCE.calls.own * 0.75);
    clock = Date.UTC(2026, 11, 5);
    await meter.count("call", "linear:proton", false, ALLOWANCE.calls.own * 0.75);
    expect(told).toHaveLength(2);
  });

  it("keeps its counts across a restart", async () => {
    await meter.count("call", "linear:proton", false, 5);
    const again = new Meter({ store, now: () => clock, tellHome: async () => {} });
    expect(again.usage().calls.own).toBe(5);
  });
});
