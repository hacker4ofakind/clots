import { beforeEach, describe, expect, it } from "vitest";
import { Asks, type AskKind } from "../src/asks.js";
import { askChoice, choiceKind, type ChoicePayload } from "../src/asks/choice.js";
import { Store } from "../src/store.js";
import { makeTools, type ToolDeps } from "../src/tools.js";
import { FakeConversation } from "./helpers/conversation.js";

const MINUTE = 60_000;
const START = Date.parse("2026-10-29T09:00:00Z");

let store: Store;
let conv: FakeConversation;
let kicked: string[];
let clock: number;
let timers: { at: number; fn: () => void; cancelled: boolean }[];
let kind: AskKind<ChoicePayload>;
let asks: Asks;
let timeoutMinutes: number;

const build = () => {
  kind = choiceKind();
  asks = new Asks({
    store,
    conv,
    now: () => clock,
    kick: (clot) => void kicked.push(clot),
    after: (ms, fn) => {
      const timer = { at: clock + ms, fn, cancelled: false };
      timers.push(timer);
      return () => void (timer.cancelled = true);
    },
    kinds: [kind],
    emit: () => undefined,
    timeoutMs: () => timeoutMinutes * MINUTE,
  });
};

/** Moves the clock on and runs the timers that came due. */
async function advance(ms: number): Promise<void> {
  clock += ms;
  for (const timer of timers.filter((t) => !t.cancelled && t.at <= clock)) {
    timer.cancelled = true;
    timer.fn();
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const choice = { question: "How to fix the login bug?", options: ["Retry the token refresh", "Log the user out and back in"] as [string, string], pick: 1 as const };
const open = (o: { question?: string; outsider?: boolean } = {}) => askChoice(asks, kind, "graphite", { ...choice, question: o.question ?? choice.question }, o.outsider ?? false);
const choices = () => store.openAsks().filter((row) => row.kind === "choice");
const pending = () => {
  const row = store.nextPending("graphite");
  if (row) store.setInboxStatus(row.id, "done");
  return row;
};

beforeEach(() => {
  store = new Store(":memory:");
  conv = new FakeConversation();
  kicked = [];
  clock = START;
  timers = [];
  timeoutMinutes = 10;
  store.upsertClot("graphite");
  store.createSession({ id: "s1", clot: "graphite", seed: null });
  build();
});

describe("ask_choice", () => {
  it("opens with the deadline from the ask timeout, and tells the Clot not to wait", async () => {
    const result = await open();
    expect(result).toContain("Do not wait for the answer");
    const [row] = choices();
    expect(row.deadline).toBe(START + 10 * MINUTE);
    expect(asks.snapshot(row)!.view).toMatchObject({ heading: "How to fix the login bug?", options: ["Retry the token refresh", "Log the user out and back in"], pick: 0 });
  });

  it("numbers the options 0 and 1 for the API and 1 and 2 in what it stores, in one place", async () => {
    await open();
    const [row] = choices();
    expect(row.payload).toMatchObject({ pick: 1 });
    expect(await asks.answer(row.id, { action: "pick", option: 1 })).toMatchObject({ status: "answered" });
    expect(pending()).toMatchObject({ kind: "message", text: '[Your choice "How to fix the login bug?": the user picked 2: Log the user out and back in.]' });
    await open({ question: "Which one?" });
    expect(choices()[0]!.payload).toMatchObject({ pick: 1 });
    await asks.answer(choices()[0]!.id, { action: "pick", option: 0 });
    expect(pending()!.text).toContain("the user picked 1: Retry the token refresh");
    expect(kicked).toEqual(["graphite", "graphite"]);
  });

  it("shows the Clot's pick as the second option when it is 2", async () => {
    await askChoice(asks, kind, "graphite", { ...choice, pick: 2 }, false);
    expect(asks.snapshot(choices()[0]!)!.view.pick).toBe(1);
  });

  it("takes only a pick, not an allow", async () => {
    await open();
    expect(await asks.answer(choices()[0]!.id, { action: "allow" })).toMatchObject({ status: "invalid" });
  });

  it("hands any text typed in the chat over with the choice, as the user's own words", async () => {
    await open({ question: "Which one?" });
    expect(await asks.onUserMessage("graphite", "go with 1 but add a test")).toBe(true);
    expect(pending()!.text).toBe('[The user answered your choice "Which one?" (1. Retry the token refresh 2. Log the user out and back in; your pick was 1):]\ngo with 1 but add a test');
    expect(choices()).toEqual([]);
    expect(store.conversation.askOutcome(1)?.result).toBe("feedback");
  });

  it("carries an outsider's taint into the answer's turn", async () => {
    await open({ outsider: true });
    await asks.answer(choices()[0]!.id, { action: "pick", option: 0 });
    expect(pending()).toMatchObject({ outsider: true });
  });

  it("with no answer by the deadline, goes with the Clot's pick: a choice row, not a block", async () => {
    await open();
    const id = choices()[0]!.id;
    await advance(10 * MINUTE - 1);
    expect(choices()).toHaveLength(1);
    await advance(1);
    expect(choices()).toEqual([]);
    expect(conv.postsFor("graphite")).toEqual(["No answer within 10 minutes: going with the Clot's pick, 1: Retry the token refresh"]);
    expect(store.conversation.askOutcome(id)!.outcome).toContain("going with the Clot's pick");
    expect(pending()).toMatchObject({
      id: `choice:${id}`,
      kind: "choice",
      text: '[The user did not answer your choice "How to fix the login bug?" within 10 minutes and appears to be busy. Go with your pick, 1: Retry the token refresh. Tell the user in one line which you took, and that a reply in this chat switches it. Carry on with the pick; do not start a second worker for the same work.]',
    });
    expect(store.conversation.askOutcome(1)?.result).toBe("timed_out");
  });

  it("makes exactly one turn when the answer and the timer race", async () => {
    await open();
    const id = choices()[0]!.id;
    clock += 10 * MINUTE;
    const due = timers.find((t) => !t.cancelled && t.at <= clock)!;
    due.cancelled = true;
    await Promise.all([asks.answer(id, { action: "pick", option: 1 }), Promise.resolve(due.fn())]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(pending()).toBeDefined();
    expect(pending()).toBeUndefined();
  });

  it("after a restart, fires at once when the deadline has passed, and at the deadline when it has not", async () => {
    await open();
    await open({ question: "Later one?" });
    const later = choices()[1]!;
    store.closeAsk(later.id, "graphite", null);
    const laterId = store.createAsk({ ...later, deadline: START + 20 * MINUTE });
    clock = START + 15 * MINUTE;
    timers = [];
    build();
    asks.startTimers();
    await advance(0);
    expect(pending()).toMatchObject({ kind: "choice" });
    expect(pending()).toBeUndefined();
    await advance(5 * MINUTE);
    expect(pending()).toMatchObject({ id: `choice:${laterId}` });
  });

  it("is fired by the hourly sweep when its timer was lost", async () => {
    await open();
    timers = [];
    clock += 11 * MINUTE;
    await asks.sweep(false);
    expect(pending()).toMatchObject({ kind: "choice" });
  });

  it("reads the timeout when it opens, so a changed setting applies to the next ask", async () => {
    timeoutMinutes = 20;
    await open();
    expect(choices()[0]!.deadline).toBe(START + 20 * MINUTE);
  });

  it("refuses a fourth open choice with the exact text", async () => {
    for (const question of ["a?", "b?", "c?"]) await open({ question });
    expect(await open({ question: "d?" })).toBe("Not asked: 3 choices already wait for the user. Decide this one yourself, or put it in your reply.");
  });

  it("is refused in the turn that carries out a timed-out choice", async () => {
    const deps = { asks: { rule: async () => "", choice: async () => "ASKED" } } as unknown as ToolDeps;
    expect(await makeTools(deps, { clot: "graphite", kind: "worker", outsider: false, fromTimeout: true }).askChoice(choice)).toContain("Go on with your pick");
    expect(await makeTools(deps, { clot: "graphite", kind: "chat", outsider: false }).askChoice(choice)).toBe("ASKED");
  });
});
