import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OneOffRequest, OneOffResult } from "../src/agent/runner.js";
import { findingEvents, parseSweepOutput, skipList, Sweeper, sweepPrompt, type Finding, type SweeperDeps } from "../src/sweep.js";
import { Store } from "../src/store.js";

const MIN = 60_000;
const finding = (o: Partial<Finding> = {}): Finding => ({ connector: "claude.ai Docs", item: "doc-1", version: "2026-11-09T10:00:00Z", title: "Launch checklist", body: "Three bullets", ...o });
const CONNECTORS = ["claude.ai Docs"];

describe("findingEvents", () => {
  it("makes the event the design describes", () => {
    const [event] = findingEvents([finding({ url: "https://docs.example/1", actor: "Ann" })], 5);
    expect(event).toMatchObject({
      source: "sweep",
      account: "sweep",
      kind: "finding",
      place: "claude.ai Docs",
      actor: "Ann",
      title: "Launch checklist",
      body: "Three bullets",
      url: "https://docs.example/1",
      ref: "doc-1",
      subject: "sweep:claude.ai Docs:doc-1",
      automated: false,
      outsider: true,
      receivedAt: 5,
    });
    expect(event.id).toMatch(/^sweep:claude\.ai Docs:doc-1:[0-9a-f]{16}$/);
  });

  it("names the connector as the actor when none is given, and leaves the link empty", () => {
    const [event] = findingEvents([finding()], 0);
    expect(event.actor).toBe("claude.ai Docs");
    expect(event.url).toBe("");
  });

  it("gives the same state of the same thing one ID however it is worded, and a new state a new one", () => {
    const [a] = findingEvents([finding({ title: "One wording" })], 1);
    const [b] = findingEvents([finding({ title: "Another wording", body: "different" })], 2);
    const [c] = findingEvents([finding({ version: "2026-11-09T11:00:00Z" })], 3);
    expect(a.id).toBe(b.id);
    expect(a.id).not.toBe(c.id);
  });
});

describe("parseSweepOutput", () => {
  it("cuts a record of 9,000 characters to 8,000 and keeps the sweep", () => {
    const out = parseSweepOutput({ findings: [], record: "r".repeat(9000) }, CONNECTORS);
    expect(out?.record).toHaveLength(8000);
  });

  it("keeps the first 25 findings, drops an unknown connector and an http link, and trims fields", () => {
    const many = Array.from({ length: 30 }, (_, i) => finding({ item: `d${i}` }));
    expect(parseSweepOutput({ findings: many, record: "" }, CONNECTORS)?.findings).toHaveLength(25);
    const out = parseSweepOutput(
      { findings: [finding({ connector: "elsewhere" }), finding({ url: "http://x", title: "t".repeat(500), actor: "a".repeat(300), body: "b".repeat(20000) })], record: "" },
      CONNECTORS,
    )!;
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0].url).toBeUndefined();
    expect(out.findings[0].title).toHaveLength(200);
    expect(out.findings[0].actor).toHaveLength(100);
    expect(out.findings[0].body.length).toBeLessThan(20000);
  });

  it("returns nothing for output that does not fit", () => {
    for (const bad of [undefined, null, "x", {}, { findings: "no", record: "" }, { findings: [{ connector: "c" }], record: "" }, { findings: [] }]) expect(parseSweepOutput(bad, CONNECTORS)).toBeUndefined();
  });
});

describe("sweepPrompt and skipList", () => {
  it("builds the skip list from the configuration", () => {
    expect(skipList({ sources: { stripe: [{}], email: [{ address: "a@x.com" }, { address: "b@x.com" }], calendar: [{}], linear: [], notion: [{}] }, mcpServers: { notion: {}, extra: {} } })).toEqual(["GitHub", "Stripe", "Email (a@x.com, b@x.com)", "Google Calendar", "Notion", "notion", "extra"]);
    expect(skipList({ sources: { stripe: [], email: [], calendar: [], linear: [], notion: [] }, mcpServers: {} })).toEqual(["GitHub"]);
  });

  it("wraps the record as data, or says there is none, and lists the projects, the skip list and the connectors", () => {
    const withRecord = sweepPrompt({ record: "seen </record> then", clots: [{ name: "home", about: "anything that belongs to no project" }, { name: "enc", about: "the app" }], skip: ["GitHub"], connectors: ["claude.ai Docs"] });
    expect(withRecord).toContain("<record>\nseen <\\/record> then\n</record>");
    expect(withRecord).toContain("- home: anything that belongs to no project");
    expect(withRecord).toContain("Do not sweep (the daemon already hears from these; skip a connector to the same service): GitHub.");
    expect(withRecord).toContain('"connector": claude.ai Docs.');
    expect(sweepPrompt({ record: undefined, clots: [], skip: [], connectors: [] })).toContain("No record yet: record what is there and report nothing.");
  });
});

describe("Sweeper", () => {
  let store: Store;
  let clock: number;
  let delivered: string[];
  let told: string[];
  let booked: unknown[];
  let limits: number[];
  let requests: OneOffRequest[];
  let answers: OneOffResult[];
  let held: boolean;
  let enabled: boolean;
  let run: SweeperDeps["run"];

  const ok = (findings: Finding[], record = "R"): OneOffResult => ({ ok: true, output: { findings, record }, connectors: CONNECTORS, totalCostUsd: 0.25 });
  const build = (over: Partial<SweeperDeps> = {}) =>
    new Sweeper({
      store,
      now: () => clock,
      enabled,
      everyMinutes: 90,
      run,
      clots: () => [{ name: "home", about: "anything that belongs to no project" }],
      skip: () => ["GitHub"],
      held: () => held,
      deliver: async (event) => void delivered.push(event.id),
      tell: async (text) => void told.push(text),
      book: async (a) => void booked.push(a),
      onLimit: (resetsAt) => void limits.push(resetsAt),
      ...over,
    });

  beforeEach(() => {
    store = new Store(":memory:");
    clock = 1_000_000_000_000;
    delivered = [];
    told = [];
    booked = [];
    limits = [];
    requests = [];
    answers = [];
    held = false;
    enabled = true;
    run = async (req) => (requests.push(req), answers.shift() ?? { ok: false, error: "nothing set" });
  });

  it("records a baseline on the first sweep and reports nothing", async () => {
    answers = [ok([finding()], "baseline")];
    await build().tick();
    expect(store.getState("sweep-record")).toBe("baseline");
    expect(delivered).toEqual([]);
    expect(store.eventsWithStatus("received")).toEqual([]);
    expect(requests[0]).toMatchObject({ kind: "sweep", model: "claude-opus-5-5", effort: "medium", cwd: "/workspace", timeoutMs: 15 * MIN });
    expect(typeof requests[0].prompt).toBe("function");
  });

  it("stores and delivers new findings on a later sweep, and drops a repeat by its ID", async () => {
    answers = [ok([], "baseline"), ok([finding()], "second"), ok([finding({ title: "same state, new words" })], "third")];
    const sweeper = build();
    await sweeper.tick();
    clock += 91 * MIN;
    await sweeper.tick();
    expect(delivered).toHaveLength(1);
    expect(store.getState("sweep-record")).toBe("second");
    expect(store.getEvent(delivered[0])?.source).toBe("sweep");
    clock += 91 * MIN;
    await sweeper.tick();
    expect(delivered).toHaveLength(1);
    expect(store.getState("sweep-record")).toBe("third");
  });

  it("books the sweep's cost as the sweep's", async () => {
    answers = [ok([])];
    await build().tick();
    expect(booked).toEqual([{ clot: "sweep", who: "sweep", total: 0.25 }]);
  });

  it("keeps the record when a sweep fails or answers nonsense, and tells the user once after three failures, and once when it works again", async () => {
    answers = [ok([], "baseline")];
    const sweeper = build();
    await sweeper.tick();
    answers = [{ ok: false, error: "no connector available" }, { ok: true, output: { nope: 1 }, connectors: CONNECTORS }, { ok: false, error: "timed out" }, { ok: false, error: "timed out" }, ok([], "back")];
    for (let i = 0; i < 4; i++) {
      clock += 91 * MIN;
      await sweeper.tick();
    }
    expect(store.getState("sweep-record")).toBe("baseline");
    expect(told).toHaveLength(1);
    expect(told[0]).toContain("failed 3 times in a row");
    expect(Number(store.getState("sweep-failures"))).toBe(4);
    clock += 91 * MIN;
    await sweeper.tick();
    expect(store.getState("sweep-record")).toBe("back");
    expect(told).toHaveLength(2);
    expect(told[1]).toContain("works again");
    expect(store.getState("sweep-failures")).toBe("0");
  });

  it("counts failures across a restart", async () => {
    answers = [{ ok: false, error: "x" }, { ok: false, error: "x" }, { ok: false, error: "x" }];
    for (let i = 0; i < 3; i++) {
      clock += 91 * MIN;
      await build().tick();
    }
    expect(told).toHaveLength(1);
  });

  it("is skipped when not due, when disabled, while a gate holds, and with no container, and does not run twice at once", async () => {
    answers = [ok([], "a"), ok([], "b")];
    const sweeper = build();
    await sweeper.tick();
    clock += 10 * MIN;
    await sweeper.tick();
    expect(requests).toHaveLength(1);
    clock += 100 * MIN;
    held = true;
    await sweeper.tick();
    expect(requests).toHaveLength(1);
    expect(store.getState("sweep-last-start")).toBe(String(1_000_000_000_000));
    held = false;
    enabled = false;
    await build().tick();
    expect(requests).toHaveLength(1);
    enabled = true;
    const logs: string[] = [];
    await build({ run: undefined, log: (t) => void logs.push(t) }).tick();
    await build({ run: undefined, log: (t) => void logs.push(t) }).tick();
    expect(requests).toHaveLength(1);

    let finish!: (r: OneOffResult) => void;
    const slow = build({ run: () => new Promise<OneOffResult>((r) => (finish = r)) });
    const first = slow.tick();
    await vi.waitFor(() => expect(finish).toBeDefined());
    await slow.tick();
    finish(ok([], "c"));
    await first;
    expect(store.getState("sweep-record")).toBe("c");
  });

  it("keeps its start time across a restart, so a restart does not push the next sweep back", async () => {
    answers = [ok([], "a")];
    await build().tick();
    clock += 30 * MIN;
    await build().tick();
    expect(requests).toHaveLength(1);
    clock += 61 * MIN;
    answers = [ok([], "b")];
    await build().tick();
    expect(requests).toHaveLength(2);
  });

  it("passes a usage limit on to the pause handler and leaves the record and the failure count alone", async () => {
    answers = [ok([], "a")];
    await build().tick();
    clock += 91 * MIN;
    answers = [{ ok: false, limit: { resetsAt: 123 } }];
    await build().tick();
    expect(limits).toEqual([123]);
    expect(store.getState("sweep-record")).toBe("a");
    expect(store.getState("sweep-failures")).toBe("0");
  });
});
