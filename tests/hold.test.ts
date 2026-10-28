import { beforeEach, describe, expect, it } from "vitest";
import type { ClotEvent } from "../src/events/types.js";
import { Hold } from "../src/hold.js";

let clock: number;
let timers: { at: number; fn: () => void; cancelled: boolean }[];
let released: { clot: string; ids: string[] }[];
let hold: Hold;

function event(id: string, subject = "pr:14"): ClotEvent {
  return { id, source: "github", kind: "ci_failed", account: "github", place: "octo/widgets", actor: "widgets-clot", title: "CI failed: CI on main", body: "", url: "u", ref: "main", subject, automated: true, outsider: false, receivedAt: 0 };
}

/** Moves the clock on and runs the waits that have run out. */
function advance(ms: number): void {
  clock += ms;
  for (const timer of timers.filter((t) => !t.cancelled && t.at <= clock)) {
    timer.cancelled = true;
    timer.fn();
  }
}

beforeEach(() => {
  clock = 0;
  timers = [];
  released = [];
  hold = new Hold({
    quietMs: 60_000,
    capMs: 120_000,
    now: () => clock,
    schedule: (ms, fn) => {
      const timer = { at: clock + ms, fn, cancelled: false };
      timers.push(timer);
      return () => void (timer.cancelled = true);
    },
    onRelease: (clot, events) => void released.push({ clot, ids: events.map((e) => e.id) }),
  });
});

describe("Hold", () => {
  it("releases an event once the quiet period has passed", () => {
    hold.add("graphite", event("d-1"));
    advance(59_000);
    expect(released).toEqual([]);
    advance(1000);
    expect(released).toEqual([{ clot: "graphite", ids: ["d-1"] }]);
  });

  it("starts the quiet period again when another event about the same subject arrives", () => {
    hold.add("graphite", event("d-1"));
    advance(40_000);
    hold.add("graphite", event("d-2"));
    advance(40_000);
    expect(released).toEqual([]);
    advance(20_000);
    expect(released).toEqual([{ clot: "graphite", ids: ["d-1", "d-2"] }]);
  });

  it("never holds a group longer than the cap, however many events keep arriving", () => {
    hold.add("graphite", event("d-1"));
    advance(50_000);
    hold.add("graphite", event("d-2"));
    advance(50_000);
    hold.add("graphite", event("d-3"));
    advance(19_000);
    expect(released).toEqual([]);
    advance(1000);
    expect(released).toEqual([{ clot: "graphite", ids: ["d-1", "d-2", "d-3"] }]);
  });

  it("keeps subjects and Clots apart, and starts afresh after a release", () => {
    hold.add("graphite", event("d-1"));
    hold.add("graphite", event("d-2", "pr:15"));
    hold.add("other", event("d-3"));
    advance(60_000);
    expect(released).toEqual([
      { clot: "graphite", ids: ["d-1"] },
      { clot: "graphite", ids: ["d-2"] },
      { clot: "other", ids: ["d-3"] },
    ]);
    hold.add("graphite", event("d-4"));
    advance(60_000);
    expect(released.at(-1)).toEqual({ clot: "graphite", ids: ["d-4"] });
  });

  it("keeps the same subject in two repositories apart", () => {
    hold.add("home", event("d-1"));
    hold.add("home", { ...event("d-2"), place: "octo/gadgets" });
    advance(60_000);
    expect(released).toEqual([
      { clot: "home", ids: ["d-1"] },
      { clot: "home", ids: ["d-2"] },
    ]);
  });
});
