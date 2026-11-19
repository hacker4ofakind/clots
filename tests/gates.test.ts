import { describe, expect, it } from "vitest";
import { describeGate, gateAt, inLeadIn, mayRunUnderGate, parseSpan, waitingUntil, type GateConfig, type Reading } from "../src/gates.js";
import { wallClock, weekStart, clockLabel } from "../src/time.js";

const ZONE = "UTC";
const days = ["mon", "tue", "wed", "thu", "fri"] as const;
const windows = (start: number, end: number) => Object.fromEntries(days.map((d) => [d, { start, end }]));
const CFG: GateConfig = { scarce: windows(900, 1080), leadIn: windows(600, 900), leadInPercent: 50 };

// 2026-11-09 is a Monday, 2026-11-14 a Saturday.
const at = (day: number, h: number, m = 0, zone = ZONE) => wallClock(2026, 11, day, h, m, 0, zone).getTime();
const reading = (percent: number, resetsAt: number, readAt = 0): Reading => ({ percent, resetsAt, readAt });

describe("scarce mode", () => {
  it("holds from 15:00 up to, not including, 18:00 on a weekday", () => {
    expect(gateAt(at(9, 14, 59), CFG, ZONE, {}).holds).toBe(null);
    expect(gateAt(at(9, 15, 0), CFG, ZONE, {}).holds).toBe("scarce");
    expect(gateAt(at(9, 17, 59), CFG, ZONE, {}).holds).toBe("scarce");
    expect(gateAt(at(9, 18, 0), CFG, ZONE, {}).holds).toBe(null);
  });

  it("does not hold on a day without a window", () => {
    expect(gateAt(at(14, 16, 0), CFG, ZONE, {}).holds).toBe(null);
  });

  it("says when it lifts", () => {
    expect(gateAt(at(9, 16, 0), CFG, ZONE, {}).until).toBe(at(9, 18, 0));
    expect(gateAt(at(13, 17, 0), CFG, ZONE, {}).until).toBe(at(13, 18, 0));
  });

  it("follows the configured time zone, across a change of offset", () => {
    // Zurich is UTC+1 on 2026-10-26 (after the change) and UTC+2 on 2026-10-23 (before).
    const zone = "Europe/Zurich";
    for (const [day, month, offset] of [[23, 10, 2], [26, 10, 1]] as const) {
      const start = Date.UTC(2026, month - 1, day, 15 - offset, 0, 0);
      expect(gateAt(start - 60_000, CFG, zone, {}).holds).toBe(null);
      expect(gateAt(start, CFG, zone, {}).holds).toBe("scarce");
      expect(gateAt(start + 3 * 3_600_000 - 60_000, CFG, zone, {}).holds).toBe("scarce");
      expect(gateAt(start + 3 * 3_600_000, CFG, zone, {}).holds).toBe(null);
    }
  });
});

describe("lead-in", () => {
  const noon = at(9, 12, 0);
  it("holds at or above the percentage, inside the window", () => {
    expect(gateAt(noon, CFG, ZONE, { fiveHour: reading(49, at(9, 13)) }).holds).toBe(null);
    expect(gateAt(noon, CFG, ZONE, { fiveHour: reading(50, at(9, 13)) })).toMatchObject({ holds: "leadIn", percent: 50 });
  });

  it("is off with no reading, outside its window, and after the reading's reset", () => {
    expect(gateAt(noon, CFG, ZONE, {}).holds).toBe(null);
    expect(gateAt(at(9, 9, 0), CFG, ZONE, { fiveHour: reading(90, at(9, 13)) }).holds).toBe(null);
    expect(gateAt(noon, CFG, ZONE, { fiveHour: reading(90, at(9, 11, 30)) }).holds).toBe(null);
  });

  it("lifts at the five-hour reset when that comes before 15:00", () => {
    expect(gateAt(noon, CFG, ZONE, { fiveHour: reading(60, at(9, 13)) }).until).toBe(at(9, 13));
  });

  it("runs into scarce mode when the reset comes after 15:00", () => {
    expect(gateAt(noon, CFG, ZONE, { fiveHour: reading(60, at(9, 16)) }).until).toBe(at(9, 18));
  });

  it("knows its window", () => {
    expect(inLeadIn(noon, CFG, ZONE)).toBe(true);
    expect(inLeadIn(at(9, 15), CFG, ZONE)).toBe(false);
  });
});

describe("no windows", () => {
  it("never holds", () => {
    expect(gateAt(at(9, 16), { scarce: {}, leadIn: {}, leadInPercent: 50 }, ZONE, { fiveHour: reading(99, at(9, 20)) }).holds).toBe(null);
  });
});

describe("mayRunUnderGate", () => {
  it("lets messages, worker rows, choices, digests and resume rows through", () => {
    for (const kind of ["message", "worker", "choice", "digest"] as const) expect(mayRunUnderGate({ id: "a", kind }, false)).toBe(true);
    expect(mayRunUnderGate({ id: "resume-1795097400", kind: "event" }, false)).toBe(true);
  });
  it("lets an event through only when it is urgent", () => {
    expect(mayRunUnderGate({ id: "event:c:1", kind: "event" }, false)).toBe(false);
    expect(mayRunUnderGate({ id: "event:c:1", kind: "event" }, true)).toBe(true);
  });
});

describe("describing a gate", () => {
  it("names scarce mode with its end and a lead-in with its percentage", () => {
    const now = at(9, 16);
    expect(describeGate(gateAt(now, CFG, ZONE, {}), ZONE, now)).toBe("scarce mode until 18:00");
    const noon = at(9, 12);
    expect(describeGate(gateAt(noon, CFG, ZONE, { fiveHour: reading(53.6, at(9, 13)) }), ZONE, noon)).toBe("the five-hour window is at 54%");
    expect(waitingUntil(gateAt(now, CFG, ZONE, {}), ZONE, now)).toBe(" (waiting until 18:00)");
  });

  it("names the weekday when the end is on another day", () => {
    const friday = at(13, 17);
    const cfg: GateConfig = { scarce: { fri: { start: 900, end: 1080 }, mon: { start: 0, end: 1 } }, leadIn: {}, leadInPercent: 50 };
    expect(gateAt(friday, cfg, ZONE, {}).until).toBe(at(13, 18));
    expect(clockLabel(at(16, 10), at(13, 17), ZONE)).toBe("Mon 10:00");
  });
});

describe("parseSpan", () => {
  it("accepts a window and rejects the rest", () => {
    expect(parseSpan("15:00-18:00")).toEqual({ start: 900, end: 1080 });
    for (const bad of ["9-10", "18:00-15:00", "10:00-10:00", "24:00-25:00", "10:61-11:00"]) expect(typeof parseSpan(bad)).toBe("string");
  });
});

describe("weekStart", () => {
  it("is Monday 00:00 in the zone", () => {
    expect(weekStart(Date.UTC(2026, 10, 15, 23, 59), "UTC")).toBe(Date.UTC(2026, 10, 9));
    expect(weekStart(Date.UTC(2026, 10, 16, 0, 0), "UTC")).toBe(Date.UTC(2026, 10, 16));
    // Sunday 23:30 UTC is already Monday in Johannesburg (UTC+2).
    expect(weekStart(Date.UTC(2026, 10, 15, 23, 30), "Africa/Johannesburg")).toBe(Date.UTC(2026, 10, 15, 22, 0));
  });
});
