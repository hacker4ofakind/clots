import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GateState, Reading } from "../src/gates.js";
import { SpendLog } from "../src/spend.js";
import { Store } from "../src/store.js";

let store: Store;
let clock: number;
let posted: { clot: string; text: string }[];
let failPost: boolean;
let gate: GateState;
let five: Reading | undefined;
let seven: Reading | undefined;
let refreshes: number;

const MIN = 60_000;
// Monday 2026-11-09 10:00 UTC; the week started that day at 00:00 UTC.
const MONDAY = Date.UTC(2026, 10, 9, 10, 0);

function make(over: { weeklyWarnUsd?: number | undefined; timeZone?: string } = {}) {
  return new SpendLog({
    store,
    now: () => clock,
    timeZone: over.timeZone ?? "UTC",
    ...("weeklyWarnUsd" in over ? { weeklyWarnUsd: over.weeklyWarnUsd } : {}),
    post: async (clot, text) => {
      if (failPost) throw new Error("no channel");
      posted.push({ clot, text });
    },
    gate: () => gate,
    meter: { refresh: async () => void (refreshes += 1), fiveHour: () => five, sevenDay: () => seven },
  });
}
const spentBy = (clot: string, who?: string) => store.spendSince(0).filter((r) => r.clot === clot && (who === undefined || r.who === who)).reduce((s, r) => s + r.usd, 0);

beforeEach(() => {
  store = new Store(":memory:");
  clock = MONDAY;
  posted = [];
  failPost = false;
  gate = { holds: null };
  five = undefined;
  seven = undefined;
  refreshes = 0;
});

describe("booking", () => {
  it("books the increase of a session's running total", async () => {
    const log = make();
    for (const total of [0.5, 0.8, 1.1]) {
      await log.book({ clot: "graphite", who: "main", sessionId: "s1", total });
    }
    const rows = store.spendSince(0);
    expect(rows).toHaveLength(1);
    expect(rows[0].usd).toBeCloseTo(1.1);
    // The increments: 0.50, 0.30, 0.30 (checked through a second session booked one total at a time).
    store.bookSpend({ at: 1, clot: "x", who: "main", sessionId: "s2", total: 0.5 });
    expect(store.bookSpend({ at: 2, clot: "x", who: "main", sessionId: "s2", total: 0.8 })).toBeCloseTo(0.3);
    expect(store.bookSpend({ at: 3, clot: "x", who: "main", sessionId: "s2", total: 1.1 })).toBeCloseTo(0.3);
  });

  it("takes a total that dropped as the turn's cost in full, and books nothing for 0 or no total", async () => {
    const log = make();
    await log.book({ clot: "graphite", who: "main", sessionId: "s1", total: 1.1 });
    await log.book({ clot: "graphite", who: "main", sessionId: "s1", total: 0.2 });
    expect(spentBy("graphite")).toBeCloseTo(1.3);
    await log.book({ clot: "graphite", who: "main", sessionId: "s3", total: 0 });
    await log.book({ clot: "graphite", who: "main", sessionId: "s1", total: undefined });
    expect(spentBy("graphite")).toBeCloseTo(1.3);
    await log.book({ clot: "graphite", who: "main", sessionId: "s1", total: 0.4 });
    expect(spentBy("graphite")).toBeCloseTo(1.5);
  });

  it("books a one-off call's total whole, each time", async () => {
    const log = make();
    await log.book({ clot: "daemon", who: "routing", total: 0.02 });
    await log.book({ clot: "daemon", who: "routing", total: 0.02 });
    expect(spentBy("daemon", "routing")).toBeCloseTo(0.04);
  });

  it("starts the week on Monday 00:00 in the user's zone", () => {
    const log = make({ timeZone: "UTC" });
    expect(log.weekStart(Date.UTC(2026, 10, 15, 23, 59))).toBe(Date.UTC(2026, 10, 9));
    expect(log.weekStart(Date.UTC(2026, 10, 16, 0, 0))).toBe(Date.UTC(2026, 10, 16));
    expect(make({ timeZone: "Africa/Johannesburg" }).weekStart(Date.UTC(2026, 10, 15, 23, 30))).toBe(Date.UTC(2026, 10, 15, 22, 0));
  });

  it("counts an entry on Sunday 23:59 in last week", async () => {
    const log = make();
    clock = Date.UTC(2026, 10, 8, 23, 59);
    await log.book({ clot: "graphite", who: "main", sessionId: "a", total: 3 });
    clock = MONDAY;
    await log.book({ clot: "graphite", who: "main", sessionId: "b", total: 1 });
    const text = await log.report("graphite");
    expect(text).toContain("graphite: $1.00");
  });
});

describe("the weekly warning", () => {
  it("is posted once per week per Clot, and not again after a restart", async () => {
    const log = make({ weeklyWarnUsd: 50 });
    await log.book({ clot: "graphite", who: "main", sessionId: "s", total: 49 });
    expect(posted).toEqual([]);
    await log.book({ clot: "graphite", who: "main", sessionId: "s", total: 52.1 });
    await log.book({ clot: "graphite", who: "main", sessionId: "s", total: 60 });
    expect(posted).toEqual([{ clot: "graphite", text: "graphite has spent an estimated $52.10 this week, past the $50 warning. `/spend` shows where." }]);
    await make({ weeklyWarnUsd: 50 }).book({ clot: "graphite", who: "main", sessionId: "s", total: 70 });
    expect(posted).toHaveLength(1);
    clock += 7 * 86_400_000;
    await log.book({ clot: "graphite", who: "main", sessionId: "n", total: 51 });
    expect(posted).toHaveLength(2);
  });

  it("is claimed before it is posted, so two bookings at once post it once", async () => {
    const log = make({ weeklyWarnUsd: 1 });
    await Promise.all([log.book({ clot: "graphite", who: "main", sessionId: "a", total: 2 }), log.book({ clot: "graphite", who: "main", sessionId: "b", total: 2 })]);
    expect(posted).toHaveLength(1);
  });

  it("is tried again after the next turn when posting failed", async () => {
    const log = make({ weeklyWarnUsd: 1 });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    failPost = true;
    await log.book({ clot: "graphite", who: "main", sessionId: "a", total: 2 });
    expect(posted).toEqual([]);
    failPost = false;
    await log.book({ clot: "graphite", who: "main", sessionId: "a", total: 3 });
    expect(posted).toHaveLength(1);
  });

  it("takes over a claim whose post never finished after five minutes, and never one that was posted", async () => {
    const log = make({ weeklyWarnUsd: 1 });
    const key = `spend-warned:graphite:${log.weekStart(clock)}`;
    store.setState(key, `posting:${clock}`);
    await log.book({ clot: "graphite", who: "main", sessionId: "a", total: 2 });
    expect(posted).toEqual([]);
    clock += 6 * MIN;
    await log.book({ clot: "graphite", who: "main", sessionId: "a", total: 3 });
    expect(posted).toHaveLength(1);
    expect(store.getState(key)).toBe("posted");
    clock += 60 * MIN;
    await log.book({ clot: "graphite", who: "main", sessionId: "a", total: 4 });
    expect(posted).toHaveLength(1);
  });

  it("takes over a bare posting claim from an earlier build, and leaves a taken-over claim to its taker", async () => {
    const log = make({ weeklyWarnUsd: 1 });
    const key = `spend-warned:graphite:${log.weekStart(clock)}`;
    store.setState(key, "posting");
    await log.book({ clot: "graphite", who: "main", sessionId: "a", total: 2 });
    expect(posted).toHaveLength(1);
    expect(store.getState(key)).toBe("posted");

    // A post that fails after its claim was taken over must not delete the taker's claim.
    const slowKey = `spend-warned:shop:${log.weekStart(clock)}`;
    let fail!: () => void;
    const slow = new SpendLog({ store, now: () => clock, timeZone: "UTC", weeklyWarnUsd: 1, post: () => new Promise((_, reject) => (fail = () => reject(new Error("late")))), gate: () => gate, meter: { refresh: async () => undefined, fiveHour: () => undefined, sevenDay: () => undefined } });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const booking = slow.book({ clot: "shop", who: "main", sessionId: "s", total: 2 });
    await vi.waitFor(() => expect(store.getState(slowKey)).toMatch(/^posting:/));
    store.setState(slowKey, "posting:taken-over");
    fail();
    await booking;
    expect(store.getState(slowKey)).toBe("posting:taken-over");
  });

  it("is off without a figure, and never for the daemon or the sweep", async () => {
    await make({ weeklyWarnUsd: undefined }).book({ clot: "graphite", who: "main", sessionId: "a", total: 500 });
    const log = make({ weeklyWarnUsd: 1 });
    await log.book({ clot: "daemon", who: "routing", total: 5 });
    await log.book({ clot: "sweep", who: "sweep", total: 5 });
    expect(posted).toEqual([]);
  });
});

describe("/spend", () => {
  async function seed(log: SpendLog) {
    store.createWorker({ id: "1a2b3c4d-0000-0000-0000-000000000000", clot: "encryptify", title: "Fix login redirect", brief: "b", model: "sonnet", effort: "high", branch: "b", base: "main", worktree: "/w", urgent: false });
    await log.book({ clot: "encryptify", who: "main", sessionId: "s", total: 6.1 });
    await log.book({ clot: "encryptify", who: "regrounding", total: 0.3 });
    await log.book({ clot: "encryptify", who: "triage", total: 0.4 });
    await log.book({ clot: "encryptify", who: "worker:1a2b3c4d-0000-0000-0000-000000000000", sessionId: "1a2b3c4d-0000-0000-0000-000000000000", total: 5.6 });
    await log.book({ clot: "shop", who: "main", sessionId: "t", total: 7.75 });
    await log.book({ clot: "daemon", who: "routing", total: 0.12 });
    await log.book({ clot: "sweep", who: "sweep", total: 1.3 });
  }

  it("has the exact layout", async () => {
    const log = make();
    await seed(log);
    gate = { holds: "scarce", until: Date.UTC(2026, 10, 9, 18, 0) };
    five = { percent: 54, resetsAt: Date.UTC(2026, 10, 9, 16, 20), readAt: clock - 3 * MIN };
    seven = { percent: 31, resetsAt: Date.UTC(2026, 10, 12, 9, 0), readAt: clock - 3 * MIN };
    expect(await log.report("encryptify")).toBe(
      [
        "Spend this week, since Mon 9 Nov 00:00. Estimated at API prices; on a subscription this is not a bill.",
        "encryptify: $12.40",
        "- Main session: $6.10",
        "- Checking recaps: $0.30",
        "- Sorting events: $0.40",
        '- Worker 1a2b3c4d "Fix login redirect" (Sonnet 5.5 high): $5.60',
        "All Clots: $20.15. Clots itself: $0.12. Sweep: $1.30.",
        "Gate: scarce mode until 18:00.",
        "Five-hour window: 54%, resets 16:20 (read 3 minutes ago). Seven-day window: 31%, resets Thu 09:00.",
      ].join("\n"),
    );
    expect(refreshes).toBe(1);
  });

  it("leaves out lines with no spend, and says there is no gate and no reading", async () => {
    const log = make();
    await log.book({ clot: "encryptify", who: "main", sessionId: "s", total: 1 });
    const text = await log.report("encryptify");
    expect(text).toContain("encryptify: $1.00\n- Main session: $1.00\nAll Clots: $1.00.\nGate: none.\nUsage reading unavailable.");
    expect(text).not.toContain("Re-grounding");
    expect(text).not.toContain("Daemon");
    expect(text).not.toContain("Sweep");
  });

  it("names a lead-in by the window's percentage", async () => {
    gate = { holds: "leadIn", percent: 54 };
    expect(await make().report("encryptify")).toContain("Gate: the five-hour window is at 54%.");
  });
});
