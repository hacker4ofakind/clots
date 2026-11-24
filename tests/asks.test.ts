import { beforeEach, describe, expect, it } from "vitest";
import { Asks, oneLine, timerState, type AskAnswer, type AskKind } from "../src/asks.js";
import { Store } from "../src/store.js";
import type { UiEventType } from "../src/ui-api/events.js";
import { FakeConversation } from "./helpers/conversation.js";

let store: Store;
let conv: FakeConversation;
let kicked: string[];
let asks: Asks;
let answers: AskAnswer[];
let feedback: string[];
let now: number;
let events: { type: UiEventType; data: any }[];
let timers: { at: number; fn: () => void; cancelled: boolean }[];

/** A kind that records answers, and closes on "allow" handing a row over. */
const testKind: AskKind<{ what: string }> = {
  kind: "rule",
  answers: ["allow", "block"],
  view: (clot, p) => ({ heading: `Allow ${clot} about ${p.what}?`, shortHeading: `About ${p.what}`, rows: [{ label: "What", value: p.what }] }),
  texts: { filed: "FILED", already: "ALREADY", full: (count) => `FULL ${count}`, notAsked: (reason) => `NOT ASKED${reason ? ` (${reason})` : ""}` },
  async onAnswer(ask, answer, io) {
    answers.push(answer);
    if (answer.action === "allow") await io.close("NOTE", "LINE", { inbox: { id: `t:${ask.id}`, text: "HANDED", kind: "message", outsider: false } });
    if (answer.action === "block") {
      io.setBusy();
    }
  },
  async onFeedback(ask, text, io) {
    feedback.push(text);
    await io.close(null, null, { inbox: { id: `f:${ask.id}`, text, kind: "message", outsider: false } }, "You answered in chat.");
  },
  async onDeadline(ask, io) {
    await io.close("BLOCKED NOTE", "Blocked: no answer.");
  },
};

const open = (what: string, max = 3) => asks.open(testKind, "graphite", { what }, { summary: `About ${what}`, dedupe: what, max });

/** Fires every timer that is due at the current time. */
const advance = (ms: number) => {
  now += ms;
  for (const t of timers.filter((t) => !t.cancelled && t.at <= now)) {
    t.cancelled = true;
    t.fn();
  }
};

beforeEach(() => {
  store = new Store(":memory:");
  conv = new FakeConversation();
  kicked = [];
  answers = [];
  feedback = [];
  events = [];
  timers = [];
  now = 1_000_000;
  store.upsertClot("graphite");
  store.createSession({ id: "s1", clot: "graphite", seed: null });
  asks = new Asks({
    store,
    conv,
    now: () => now,
    kick: (clot) => void kicked.push(clot),
    after: (ms, fn) => {
      const timer = { at: now + ms, fn, cancelled: false };
      timers.push(timer);
      return () => void (timer.cancelled = true);
    },
    kinds: [testKind],
    emit: (type, data) => void events.push({ type, data }),
    timeoutMs: () => 10 * 60_000,
  });
});

describe("Asks", () => {
  it("opens an ask with a deadline from the live timeout, puts its card in the chat and tells the UI", async () => {
    expect(await open("x")).toBe("FILED");
    const [ask] = store.openAsks();
    expect(ask.state).toBe("open");
    expect(ask.deadline).toBe(now + 10 * 60_000);
    expect(conv.asksPosted).toEqual([{ clot: "graphite", askId: ask.id }]);
    expect(events.map((e) => e.type)).toEqual(["ask.opened"]);
    expect(events[0]!.data).toMatchObject({ id: ask.id, clot: "graphite", kind: "rule", timer: "calm", view: { heading: "Allow graphite about x?" } });
  });

  it("lists open asks with their view and timer", async () => {
    await open("x");
    expect(asks.list().map((a) => [a.clot, a.summary, a.timer])).toEqual([["graphite", "About x", "calm"]]);
  });

  it("refuses a repeat of an open ask, and an ask past the limit", async () => {
    await open("x");
    expect(await open("x")).toBe("ALREADY");
    await open("y", 2);
    expect(await open("z", 2)).toBe("FULL 2");
  });

  it("closes an ask once, with its note and the row it hands over in one step, shows the line and kicks the Clot", async () => {
    await open("x");
    const [ask] = store.openAsks();
    const result = await asks.answer(ask.id, { action: "allow" });
    expect(result).toEqual({ status: "answered", outcome: "LINE" });
    expect(store.openAsks()).toEqual([]);
    expect(store.notes("graphite").map((note) => note.text)).toEqual(["NOTE"]);
    expect(store.nextPending("graphite")).toMatchObject({ id: `t:${ask.id}`, text: "HANDED" });
    expect(conv.postsFor("graphite")).toEqual(["LINE"]);
    expect(kicked).toEqual(["graphite"]);
    expect(events.at(-1)).toMatchObject({ type: "ask.closed", data: { id: ask.id, outcome: "LINE" } });
    expect(store.closeAsk(ask.id, "graphite", "AGAIN")).toBe(false);
    expect(store.notes("graphite")).toHaveLength(1);
  });

  it("answers a second time with how the first ended, not by acting again", async () => {
    await open("x");
    const [ask] = store.openAsks();
    await asks.answer(ask.id, { action: "allow" }, "k1");
    expect(await asks.answer(ask.id, { action: "block" })).toEqual({ status: "closed", outcome: "LINE" });
    // The same answer retried with its key is the first one, not a conflict.
    expect(await asks.answer(ask.id, { action: "allow" }, "k1")).toEqual({ status: "answered", outcome: "LINE" });
    expect(answers).toHaveLength(1);
    expect(await asks.answer(999, { action: "allow" })).toEqual({ status: "missing" });
  });

  it("says an ask being carried out is in progress, and refuses an answer its kind does not take", async () => {
    await open("x");
    const [ask] = store.openAsks();
    expect(await asks.answer(ask.id, { action: "pick", option: 0 })).toMatchObject({ status: "invalid" });
    await asks.answer(ask.id, { action: "block" });
    expect(await asks.answer(ask.id, { action: "allow" })).toEqual({ status: "busy", outcome: "in progress" });
  });

  it("rolls the close back when the row it hands over is there already", async () => {
    await open("x");
    const [ask] = store.openAsks();
    store.enqueue({ id: `t:${ask.id}`, clot: "graphite", text: "old", receivedAt: 0 });
    expect(store.closeAsk(ask.id, "graphite", "NOTE", { inbox: { id: `t:${ask.id}`, clot: "graphite", text: "new", receivedAt: 0 } })).toBe(false);
    expect(store.openAsks()).toHaveLength(1);
    expect(store.notes("graphite")).toEqual([]);
  });

  it("hands a message typed in the Clot's chat to the newest open ask that takes feedback, and says nothing else does", async () => {
    expect(await asks.onUserMessage("graphite", "hello")).toBe(false);
    await open("x");
    expect(await asks.onUserMessage("graphite", "hello")).toBe(true);
    expect(feedback).toEqual(["hello"]);
    expect(store.openAsks()).toEqual([]);
    expect(store.nextPending("graphite")?.text).toBe("hello");
    expect(await asks.onUserMessage("graphite", "again")).toBe(false);
  });

  it("leaves a message to the Clot when the open ask's kind takes no feedback", async () => {
    const quiet: AskKind<{ what: string }> = { ...testKind, onFeedback: undefined };
    asks = new Asks({ store, conv, now: () => now, kick: () => undefined, after: () => () => undefined, kinds: [quiet], emit: () => undefined, timeoutMs: () => 60_000 });
    await asks.open(quiet, "graphite", { what: "x" }, { summary: "About x", dedupe: "x", max: 3 });
    expect(await asks.onUserMessage("graphite", "hello")).toBe(false);
    expect(store.openAsks()).toHaveLength(1);
  });

  it("withdraws an ask a kind says is stale, when the user types or answers", async () => {
    const stale: AskKind<{ what: string }> = { ...testKind, stale: () => "it is old" };
    asks = new Asks({ store, conv, now: () => now, kick: () => undefined, after: () => () => undefined, kinds: [stale], emit: () => undefined, timeoutMs: () => 60_000 });
    await asks.open(stale, "graphite", { what: "x" }, { summary: "About x", dedupe: "x", max: 3 });
    const [ask] = store.openAsks();
    expect(await asks.answer(ask.id, { action: "allow" })).toMatchObject({ status: "closed" });
    expect(store.openAsks()).toEqual([]);
    expect(conv.postsFor("graphite")).toEqual(["Withdrawn: About x (it is old)"]);
  });

  it("never withdraws an ask that is being carried out", async () => {
    await open("x");
    const [ask] = store.openAsks();
    store.moveAsk(ask.id, "open", "busy");
    expect(await asks.withdraw(ask.id, "it changed")).toBe(false);
    await asks.sweep(false);
    expect(store.openAsks()).toHaveLength(1);
  });

  it("closes, at startup, an ask a stop left being carried out", async () => {
    await open("x");
    const [ask] = store.openAsks();
    store.moveAsk(ask.id, "open", "busy");
    await asks.sweep(true);
    expect(store.openAsks()).toEqual([]);
    expect(store.notes("graphite")[0]!.text).toContain("whether it finished is not known");
  });

  it("says why it could not ask, and leaves nothing behind when the post fails", async () => {
    conv.postAsk = async () => {
      throw new Error("down");
    };
    expect(await open("x")).toBe("NOT ASKED");
    expect(store.openAsks()).toEqual([]);
  });

  it("tells listeners after each open and close", async () => {
    let changes = 0;
    asks.onChange(() => void (changes += 1));
    await open("x");
    await asks.answer(store.openAsks()[0]!.id, { action: "allow" });
    expect(changes).toBe(2);
  });

  it("makes summaries one line", () => {
    expect(oneLine("Ping about [the page](https://x.y)\nsecond")).toBe("Ping about the page");
    expect(oneLine("x".repeat(150))).toHaveLength(100);
  });
});

describe("deadlines and the timer", () => {
  it("closes an ask at its deadline through its kind, and cancels its timers", async () => {
    await open("x");
    const [ask] = store.openAsks();
    advance(10 * 60_000);
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    expect(store.openAsks()).toEqual([]);
    expect(store.notes("graphite").map((n) => n.text)).toEqual(["BLOCKED NOTE"]);
    expect(conv.postsFor("graphite")).toEqual(["Blocked: no answer."]);
    expect(events.at(-1)).toMatchObject({ type: "ask.closed", data: { id: ask.id, outcome: "Blocked: no answer." } });
  });

  it("sends the timer's states at the 5 minute and 1 minute marks, once each", async () => {
    await open("x");
    advance(5 * 60_000);
    advance(4 * 60_000);
    const updates = events.filter((e) => e.type === "ask.updated").map((e) => e.data.timer);
    expect(updates).toEqual(["calling", "urgent"]);
  });

  it("names the state from the time left", () => {
    expect(timerState(10 * 60_000, 0)).toBe("calm");
    expect(timerState(5 * 60_000, 0)).toBe("calling");
    expect(timerState(61_000, 0)).toBe("calling");
    expect(timerState(59_000, 0)).toBe("urgent");
    expect(timerState(-5000, 0)).toBe("urgent");
  });

  it("at startup closes an ask whose deadline passed while the daemon was down, and gives an old ask without one a deadline", async () => {
    await open("x");
    await open("y");
    const [first, second] = store.openAsks();
    (store as any).db.prepare("UPDATE user_asks SET deadline = ? WHERE id = ?").run(now - 1000, first.id);
    (store as any).db.prepare("UPDATE user_asks SET deadline = NULL WHERE id = ?").run(second.id);
    await asks.sweep(true);
    expect(store.openAsks().map((a) => a.id)).toEqual([second.id]);
    asks.startTimers();
    expect(store.askById(second.id)!.deadline).toBe(now + 10 * 60_000);
  });
});
