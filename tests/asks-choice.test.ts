import { beforeEach, describe, expect, it } from "vitest";
import { Asks, type AskKind } from "../src/asks.js";
import { askChoice, choiceKind, type ChoicePayload } from "../src/asks/choice.js";
import type { InboundMessage } from "../src/chat/adapter.js";
import { FakeChat } from "../src/chat/fake.js";
import { matchChoice } from "../src/events/reply.js";
import { Store } from "../src/store.js";
import { makeTools, type ToolDeps } from "../src/tools.js";

const USER = "user-1";
const MINUTE = 60_000;
const START = Date.parse("2026-10-29T09:00:00Z");

let store: Store;
let chat: FakeChat;
let said: string[];
let kicked: string[];
let clock: number;
let timers: { at: number; fn: () => void; cancelled: boolean }[];
let kind: AskKind<ChoicePayload>;
let asks: Asks;
let n: number;

const build = () => {
  kind = choiceKind({ timeoutMinutes: 10 });
  asks = new Asks({
    store,
    chat,
    userId: USER,
    now: () => clock,
    kick: (clot) => void kicked.push(clot),
    say: async (_clot, text) => void said.push(text),
    after: (ms, fn) => {
      const timer = { at: clock + ms, fn, cancelled: false };
      timers.push(timer);
      return () => void (timer.cancelled = true);
    },
    kinds: [kind],
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

function reply(channelId: string, text: string, authorId = USER): InboundMessage {
  n += 1;
  return { id: `r${n}`, channelId, authorId, text, at: new Date(0) };
}

const choice = { question: "How to fix the login bug?", options: ["Retry the token refresh", "Log the user out and back in"] as [string, string], pick: 1 as const };
const open = (o: { question?: string; outsider?: boolean } = {}) => askChoice(asks, kind, { now: () => clock, timeoutMinutes: 10 }, "graphite", { ...choice, question: o.question ?? choice.question }, o.outsider ?? false);
const choices = () => store.openAsks().filter((row) => row.kind === "choice");
const pending = () => {
  const row = store.nextPending("graphite");
  if (row) store.setInboxStatus(row.id, "done");
  return row;
};

beforeEach(async () => {
  store = new Store(":memory:");
  chat = new FakeChat();
  said = [];
  kicked = [];
  clock = START;
  timers = [];
  n = 0;
  const category = await chat.ensureCategory("graphite");
  store.upsertClot("graphite", category);
  store.createSession({ id: "s1", clot: "graphite", channelId: await chat.createChannel(category, "graphite-2910"), seed: null });
  build();
});

describe("matchChoice", () => {
  it("reads 1, 2, the Clot's pick, and nothing else", () => {
    for (const text of ["1", "one", "First!"]) expect(matchChoice(text)).toBe(1);
    for (const text of ["2", "Two", "second"]) expect(matchChoice(text)).toBe(2);
    for (const text of ["Your pick!", "go ahead"]) expect(matchChoice(text)).toBe("pick");
    expect(matchChoice("go with 1 but add a test")).toBeUndefined();
  });
});

describe("ask_choice", () => {
  it("posts the exact prompt with the deadline as a Discord time, and tells the Clot not to wait", async () => {
    const result = await open();
    expect(result).toContain("Do not wait for the answer");
    const [row] = choices();
    expect(row).toMatchObject({ channelName: "graphite-choice", deadline: START + 10 * MINUTE });
    expect(chat.postsIn(row.channelId)).toEqual([
      `<@user-1> graphite asks: How to fix the login bug?\n\n**1.** Retry the token refresh\n**2.** Log the user out and back in\n\nMy pick: 1. Answer 1 or 2, "your pick", or write what you want instead. I'll go with 1 at <t:${(START + 10 * MINUTE) / 1000}:t> if I don't hear from you.`,
    ]);
  });

  it("is a turn of the user's own naming the option on an exact answer, and the channel goes", async () => {
    await open();
    const channel = choices()[0].channelId;
    await asks.onReply(reply(channel, "2"));
    expect(pending()).toMatchObject({ kind: "message", text: '[Your choice "How to fix the login bug?": the user picked 2: Log the user out and back in.]' });
    expect(chat.deleted).toContain(channel);
    expect(kicked).toEqual(["graphite"]);
    expect(choices()).toEqual([]);
  });

  it("takes the Clot's pick for your pick, and hands any other text over with the choice", async () => {
    await open();
    await asks.onReply(reply(choices()[0].channelId, "Your pick!"));
    expect(pending()!.text).toContain("the user picked 1: Retry the token refresh");

    await open({ question: "Which one?" });
    await asks.onReply(reply(choices()[0].channelId, "go with 1 but add a test"));
    expect(pending()!.text).toBe('[The user answered your choice "Which one?" (1. Retry the token refresh 2. Log the user out and back in; your pick was 1):]\ngo with 1 but add a test');
  });

  it("carries an outsider's taint into the answer's turn", async () => {
    await open({ outsider: true });
    await asks.onReply(reply(choices()[0].channelId, "1"));
    expect(pending()).toMatchObject({ outsider: true });
  });

  it("ignores anyone but the user", async () => {
    await open();
    expect(await asks.onReply(reply(choices()[0].channelId, "2", "someone-else"))).toBe(true);
    expect(choices()).toHaveLength(1);
    expect(store.nextPending("graphite")).toBeUndefined();
  });

  it("with no answer in 10 minutes, hands the Clot a choice row telling it to go with its pick", async () => {
    await open();
    const channel = choices()[0].channelId;
    const id = choices()[0].id;
    await advance(10 * MINUTE - 1);
    expect(choices()).toHaveLength(1);
    await advance(1);
    expect(choices()).toEqual([]);
    expect(chat.deleted).toContain(channel);
    expect(pending()).toMatchObject({
      id: `choice:${id}`,
      kind: "choice",
      text: '[The user did not answer your choice "How to fix the login bug?" within 10 minutes and appears to be busy. Go with your pick, 1: Retry the token refresh. Tell the user in one line which you took, and that a reply in this channel switches it. Carry on with the pick; do not start a second worker for the same work.]',
    });
  });

  it("makes exactly one turn when the answer and the timer race", async () => {
    await open();
    const channel = choices()[0].channelId;
    clock += 10 * MINUTE;
    const due = timers[0];
    due.cancelled = true;
    await Promise.all([asks.onReply(reply(channel, "2")), Promise.resolve(due.fn())]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(pending()).toBeDefined();
    expect(pending()).toBeUndefined();
  });

  it("after a restart, fires at once when the deadline has passed, and at the deadline when it has not", async () => {
    await open();
    await open({ question: "Later one?" });
    const later = choices()[1];
    store.closeAsk(later.id, "graphite", null);
    const laterId = store.createAsk({ ...later, deadline: START + 20 * MINUTE });
    store.moveAsk(laterId, "posting", "open");
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
