import { describe, expect, it } from "vitest";
import { digestText, planDrain, DIGEST_HEADER } from "../src/digest.js";
import type { ClotEvent } from "../src/events/types.js";
import type { InboxRow } from "../src/store.js";

let n = 0;
function row(kind: InboxRow["kind"], o: Partial<InboxRow> = {}): InboxRow {
  n += 1;
  return { id: o.id ?? `r${n}`, clot: "c", channelId: "ch", text: "", receivedAt: n, status: "pending", kind, eventId: kind === "event" ? `e${n}` : null, workerId: null, outsider: false, gated: false, urgent: false, ...o };
}
const ids = (rows: InboxRow[]) => rows.map((r) => r.id);

describe("planDrain while a gate holds", () => {
  it("runs the first row that may run and marks the events before it as waiting", () => {
    const a = row("event", { id: "a" });
    const b = row("event", { id: "b", gated: true });
    const m = row("message", { id: "m" });
    const plan = planDrain([a, b, m], true);
    expect(plan.run?.id).toBe("m");
    expect(plan.markGated).toEqual(["a"]);
  });

  it("runs an urgent event, a worker row, a choice and a resume row", () => {
    expect(planDrain([row("event", { id: "a" }), row("event", { id: "u", urgent: true })], true).run?.id).toBe("u");
    for (const kind of ["worker", "choice"] as const) expect(planDrain([row("event", { id: "a" }), row(kind, { id: "x" })], true).run?.id).toBe("x");
    expect(planDrain([row("event", { id: "a" }), row("event", { id: "resume-5" })], true).run?.id).toBe("resume-5");
  });

  it("runs nothing when only ordinary events wait", () => {
    const plan = planDrain([row("event", { id: "a" }), row("event", { id: "b" })], true);
    expect(plan.run).toBeUndefined();
    expect(plan.markGated).toEqual(["a", "b"]);
  });
});

describe("planDrain once no gate holds", () => {
  it("runs the oldest row when it is not waiting", () => {
    const m = row("message", { id: "m" });
    expect(planDrain([m, row("event", { gated: true }), row("event", { gated: true })], false).run?.id).toBe("m");
    expect(planDrain([], false)).toEqual({ markGated: [], run: undefined });
  });

  it("runs a single waiting event as itself and clears its mark", () => {
    const a = row("event", { id: "a", gated: true });
    const plan = planDrain([a, row("message", { id: "m" })], false);
    expect(plan.run?.id).toBe("a");
    expect(plan.ungate).toEqual(["a"]);
    expect(plan.digest).toBeUndefined();
  });

  it("gathers two or more waiting events, in order, in chunks of ten", () => {
    const waiting = Array.from({ length: 23 }, (_, i) => row("event", { id: `g${i + 1}`, gated: true }));
    const plan = planDrain([...waiting.slice(0, 2), row("message", { id: "m" }), ...waiting.slice(2)], false);
    expect(plan.digest?.map(ids)).toEqual([waiting.slice(0, 10), waiting.slice(10, 20), waiting.slice(20)].map(ids));
    expect(plan.run).toBeUndefined();
  });

  it("lets what arrived before the first waiting event run first", () => {
    const m = row("message", { id: "m" });
    const plan = planDrain([m, row("event", { gated: true }), row("event", { gated: true })], false);
    expect(plan.run?.id).toBe("m");
    expect(plan.digest).toBeUndefined();
  });
});

describe("digestText", () => {
  const event = (id: string, o: Partial<ClotEvent> = {}): ClotEvent => ({ id, source: "github", kind: "issue_opened", account: "github", place: "o/r", actor: "a", title: `T ${id}`, body: "body", url: "", ref: "1", subject: "", automated: false, outsider: false, receivedAt: Date.UTC(2026, 10, 9, 14, 32), ...o });

  it("lists each event in its own wrapper with its time, ID and triage line, then its standing rules", () => {
    const text = digestText(
      [
        { event: event("e1"), message: "Login fails.", standing: [{ name: "ack", text: "Thanks." }] },
        { event: event("e2", { outsider: true }), message: null, standing: [] },
      ],
      "Africa/Johannesburg",
    );
    expect(text.startsWith(DIGEST_HEADER)).toBe(true);
    expect(text).toContain("Event 1 of 2, arrived 16:32, id e1. Triage said: Login fails.");
    expect(text).toContain('<event source="github" received="16:32">\nid: e1');
    expect(text).toContain("- ack (event e1): Thanks.");
    expect(text).toContain("from: an outsider");
    expect(text.indexOf("id e1.")).toBeLessThan(text.indexOf("id e2."));
    expect(text.match(/Standing rules that apply/g)).toHaveLength(1);
  });
});
