import { beforeEach, describe, expect, it } from "vitest";
import { Asks, type AskKind } from "../src/asks.js";
import type { InboundMessage } from "../src/chat/adapter.js";
import { FakeChat } from "../src/chat/fake.js";
import { Store } from "../src/store.js";
import { renderWaiting, Waiting } from "../src/waiting.js";

const USER = "user-1";

let store: Store;
let chat: FakeChat;
let clock: number;
let timers: { at: number; fn: () => void; cancelled: boolean }[];
let waiting: Waiting;
let asks: Asks;

const after = (ms: number, fn: () => void) => {
  const timer = { at: clock + ms, fn, cancelled: false };
  timers.push(timer);
  return () => void (timer.cancelled = true);
};

/** Moves the clock on, runs the timers that came due, and lets their work finish. */
async function advance(ms: number): Promise<void> {
  clock += ms;
  for (const timer of timers.filter((t) => !t.cancelled && t.at <= clock)) {
    timer.cancelled = true;
    timer.fn();
  }
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

const kindOf = (kind: "rule" | "choice"): AskKind<{ what: string }> => ({
  kind,
  channelName: (clot, existing) => `${clot}-${kind}-${existing.length}`,
  render: (_clot, p) => `asks about ${p.what}.`,
  texts: { filed: "FILED", already: "ALREADY", full: () => "FULL", notAsked: () => "NOT ASKED" },
  onReply: async (_ask, _text, io) => void (await io.close(null, null)),
});
const rule = kindOf("rule");
const choice = kindOf("choice");

const pinnedText = () => chat.messages.get(store.getState("waiting.message")!)!.text;

beforeEach(async () => {
  store = new Store(":memory:");
  chat = new FakeChat();
  clock = Date.parse("2026-10-29T09:00:00Z");
  timers = [];
  store.upsertClot("graphite", await chat.ensureCategory("graphite"));
  waiting = new Waiting({ store, chat, after });
  asks = new Asks({ store, chat, userId: USER, now: () => clock, kick: () => undefined, say: async () => undefined, after, kinds: [rule, choice], ignore: (id) => waiting.isChannel(id) });
  asks.onChange(() => waiting.refresh());
  await waiting.init();
});

describe("clots-waiting", () => {
  it("is a channel at the top of the server with one pinned message saying nothing waits", () => {
    expect(chat.top.map((c) => c.name)).toEqual(["clots-waiting"]);
    expect(pinnedText()).toBe("Nothing is waiting for you.");
    expect(chat.pinned).toEqual([store.getState("waiting.message")]);
  });

  it("lists a rule ask and a choice, the choice with its deadline, and drops one once it closes", async () => {
    await asks.open(rule, "graphite", { what: "a rule" }, { summary: "Rule change: drop Dependabot", dedupe: "r", max: 3 });
    await asks.open(choice, "graphite", { what: "a choice" }, { summary: "Choice: how to fix it?", dedupe: "c", max: 3, deadline: clock + 600_000 });
    await advance(2_000);
    const [ruleAsk, choiceAsk] = store.openAsks();
    expect(pinnedText()).toBe(
      ["**Waiting for you**", `• graphite: Rule change: drop Dependabot → <#${ruleAsk.channelId}>`, `• graphite: Choice: how to fix it? → <#${choiceAsk.channelId}> (decides at <t:${(clock - 2_000 + 600_000) / 1000}:t>)`].join("\n"),
    );
    await asks.withdraw(ruleAsk.id, "it changed");
    await advance(2_000);
    expect(pinnedText().split("\n")).toHaveLength(2);
  });

  it("makes one edit for three opens close together, and none for the same list", async () => {
    for (const what of ["a", "b", "c"]) await asks.open(rule, "graphite", { what }, { summary: what, dedupe: what, max: 5 });
    await advance(2_000);
    expect(chat.edits).toHaveLength(1);
    waiting.refresh();
    await advance(2_000);
    expect(chat.edits).toHaveLength(1);
  });

  it("posts and pins a new message when the old one is gone, and stores where it is", async () => {
    const old = store.getState("waiting.message")!;
    chat.messages.delete(old);
    await asks.open(rule, "graphite", { what: "a" }, { summary: "a", dedupe: "a", max: 3 });
    await advance(2_000);
    const now = store.getState("waiting.message")!;
    expect(now).not.toBe(old);
    expect(chat.pinned).toContain(now);
    expect(pinnedText()).toContain("• graphite: a");
  });

  it("tries an edit again on other errors, and posts nothing new", async () => {
    const old = store.getState("waiting.message")!;
    chat.editFails = new Error("Discord is down");
    await asks.open(rule, "graphite", { what: "a" }, { summary: "a", dedupe: "a", max: 3 });
    await advance(2_000);
    expect(chat.edits).toEqual([]);
    await advance(5_000);
    expect(store.getState("waiting.message")).toBe(old);
    expect(pinnedText()).toContain("• graphite: a");
  });

  it("pins the stored message at the next start, and after a change, when an earlier pin failed", async () => {
    const message = store.getState("waiting.message")!;
    chat.pinned = [];
    chat.pinFails = true;
    waiting = new Waiting({ store, chat, after });
    await waiting.init();
    expect(chat.pinned).toEqual([]);
    chat.pinFails = false;
    waiting.refresh();
    await advance(2_000);
    expect(chat.pinned).toEqual([message]);
    // Known to be pinned: nothing is pinned twice, and a restart only checks.
    waiting = new Waiting({ store, chat, after });
    await waiting.init();
    expect(chat.pinned).toEqual([message]);
    expect(store.getState("waiting.message")).toBe(message);
  });

  it("does not list an ask still being shown", () => {
    const row = { id: 1, kind: "rule", clot: "graphite", channelId: "c", channelName: "n", payload: {}, summary: "s", state: "posting" as const, openedAt: 0, deadline: null, dedupe: "d", outsider: false };
    expect(renderWaiting([row], (id) => `<#${id}>`)).toBe("Nothing is waiting for you.");
  });

  it("ends a long list with how many more, under 2,000 characters", () => {
    const rows = Array.from({ length: 60 }, (_, i) => ({ id: i, kind: "rule", clot: "graphite", channelId: `ch-${i}`, channelName: "n", payload: {}, summary: "x".repeat(90), state: "open" as const, openedAt: 0, deadline: null, dedupe: `${i}`, outsider: false }));
    const text = renderWaiting(rows, (id) => `<#${id}>`);
    expect(text.length).toBeLessThanOrEqual(2_000);
    expect(text).toMatch(/\n…and \d+ more$/);
    const shown = text.split("\n").filter((line) => line.startsWith("•")).length;
    expect(text.endsWith(`…and ${60 - shown} more`)).toBe(true);
  });

  it("takes a message posted in it to no Clot and no ask", async () => {
    const m: InboundMessage = { id: "m1", channelId: store.getState("waiting.channel")!, authorId: USER, text: "yes", at: new Date(0) };
    expect(await asks.onReply(m)).toBe(true);
  });
});
