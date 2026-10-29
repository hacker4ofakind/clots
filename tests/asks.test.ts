import { beforeEach, describe, expect, it } from "vitest";
import { Asks, oneLine, type AskKind } from "../src/asks.js";
import { migrateAsks } from "../src/asks-migration.js";
import type { InboundMessage } from "../src/chat/adapter.js";
import { FakeChat } from "../src/chat/fake.js";
import { makeRoom } from "../src/chat/room.js";
import { Store } from "../src/store.js";

const USER = "user-1";

let store: Store;
let chat: FakeChat;
let said: string[];
let kicked: string[];
let asks: Asks;
let replies: string[];
let category: string;
let n: number;

/** A kind that records replies, and closes on "close" handing a row over. */
const testKind: AskKind<{ what: string }> = {
  kind: "rule",
  channelName: (clot, existing) => (existing.includes(`${clot}-rule`) ? `${clot}-rule-${existing.length}` : `${clot}-rule`),
  render: (_clot, p) => `asks about ${p.what}.`,
  texts: { filed: "FILED", already: "ALREADY", full: (count) => `FULL ${count}`, notAsked: (reason) => `NOT ASKED${reason ? ` (${reason})` : ""}` },
  async onReply(ask, text, io) {
    replies.push(text);
    if (text === "close") await io.close("NOTE", "LINE", { inbox: { id: `t:${ask.id}`, text: "HANDED", kind: "message", outsider: false } });
  },
};

function reply(channelId: string, text: string, authorId = USER): InboundMessage {
  n += 1;
  return { id: `r${n}`, channelId, authorId, text, at: new Date(0) };
}

const open = (what: string, max = 3) => asks.open(testKind, "graphite", { what }, { summary: `About ${what}`, dedupe: what, max });

beforeEach(async () => {
  store = new Store(":memory:");
  chat = new FakeChat();
  said = [];
  kicked = [];
  replies = [];
  n = 0;
  category = await chat.ensureCategory("graphite");
  store.upsertClot("graphite", category);
  store.createSession({ id: "s1", clot: "graphite", channelId: await chat.createChannel(category, "graphite-1210"), seed: null });
  asks = new Asks({ store, chat, userId: USER, now: () => 0, kick: (clot) => void kicked.push(clot), say: async (_clot, text) => void said.push(text), after: () => () => undefined, kinds: [testKind], ignore: (id) => id === "waiting" });
});

describe("Asks", () => {
  it("posts the question once, with one mention, and only then takes answers", async () => {
    expect(await open("x")).toBe("FILED");
    const [ask] = store.openAsks();
    expect(ask.state).toBe("open");
    expect(chat.postsIn(ask.channelId)).toEqual(["<@user-1> graphite asks about x."]);
  });

  it("refuses a repeat of an open ask, and an ask past the limit", async () => {
    await open("x");
    expect(await open("x")).toBe("ALREADY");
    await open("y", 2);
    expect(await open("z", 2)).toBe("FULL 2");
  });

  it("closes an ask once, with its note and the row it hands over in one step, and kicks the Clot", async () => {
    await open("x");
    const [ask] = store.openAsks();
    await asks.onReply(reply(ask.channelId, "close"));
    expect(store.openAsks()).toEqual([]);
    expect(store.notes("graphite").map((note) => note.text)).toEqual(["NOTE"]);
    expect(store.nextPending("graphite")).toMatchObject({ id: `t:${ask.id}`, text: "HANDED" });
    expect(said).toEqual(["LINE"]);
    expect(kicked).toEqual(["graphite"]);
    expect(store.closeAsk(ask.id, "graphite", "AGAIN")).toBe(false);
    expect(store.notes("graphite")).toHaveLength(1);
  });

  it("rolls the close back when the row it hands over is there already", async () => {
    await open("x");
    const [ask] = store.openAsks();
    store.enqueue({ id: `t:${ask.id}`, clot: "graphite", channelId: "c", text: "old", receivedAt: 0 });
    expect(store.closeAsk(ask.id, "graphite", "NOTE", { inbox: { id: `t:${ask.id}`, clot: "graphite", channelId: "c", text: "new", receivedAt: 0 } })).toBe(false);
    expect(store.openAsks()).toHaveLength(1);
    expect(store.notes("graphite")).toEqual([]);
  });

  it("ignores anyone but the user, and answers a late message in a closed ask's channel", async () => {
    await open("x");
    const [ask] = store.openAsks();
    expect(await asks.onReply(reply(ask.channelId, "hello", "someone-else"))).toBe(true);
    expect(replies).toEqual([]);
    await asks.onReply(reply(ask.channelId, "close"));
    expect(await asks.onReply(reply(ask.channelId, "yes"))).toBe(true);
    expect(chat.postsIn(ask.channelId).at(-1)).toBe("This question is already closed.");
    expect(replies).toEqual(["close"]);
  });

  it("takes nothing from an ignored channel, and leaves other channels alone", async () => {
    expect(await asks.onReply(reply("waiting", "yes"))).toBe(true);
    expect(await asks.onReply(reply("elsewhere", "yes"))).toBe(false);
  });

  it("withdraws an ask whose channel is gone, but not one whose channel cannot be checked", async () => {
    await open("x");
    await open("y");
    const [gone, kept] = store.openAsks();
    const exists = chat.channelExists.bind(chat);
    chat.channelExists = async () => {
      throw new Error("Discord is down");
    };
    await asks.sweep(false);
    expect(store.openAsks()).toHaveLength(2);
    chat.channelExists = exists;
    chat.channels = chat.channels.filter((channel) => channel.id !== gone.channelId);
    await asks.sweep(false);
    expect(store.openAsks().map((ask) => ask.id)).toEqual([kept.id]);
    expect(store.notes("graphite")[0].text).toBe("Withdrawn: About x (its channel was removed). Ask again if it still makes sense.");
    expect(said).toEqual(["Withdrawn: About x (its channel was removed)"]);
  });

  it("never withdraws an ask that is being carried out", async () => {
    await open("x");
    const [ask] = store.openAsks();
    store.moveAsk(ask.id, "open", "busy");
    expect(await asks.withdraw(ask.id, "it changed")).toBe(false);
    chat.channels = chat.channels.filter((channel) => channel.id !== ask.channelId);
    await asks.sweep(false);
    expect(store.openAsks()).toHaveLength(1);
  });

  it("closes, at startup, an ask a stop left being carried out, before any channel check", async () => {
    await open("x");
    const [ask] = store.openAsks();
    store.moveAsk(ask.id, "open", "busy");
    chat.channels = chat.channels.filter((channel) => channel.id !== ask.channelId);
    await asks.sweep(true);
    expect(store.openAsks()).toEqual([]);
    expect(store.notes("graphite")[0].text).toContain("whether it finished is not known");
  });

  it("says why it could not ask, and leaves nothing behind when the post fails", async () => {
    const post = chat.post.bind(chat);
    chat.post = async (channelId, text) => {
      if (text.includes("asks about")) throw new Error("Discord is down");
      return post(channelId, text);
    };
    expect(await open("x")).toBe("NOT ASKED");
    expect(store.openAsks()).toEqual([]);
    expect(chat.deleted).toHaveLength(1);
  });

  it("tells clots-waiting after each open and close", async () => {
    let changes = 0;
    asks.onChange(() => void (changes += 1));
    await open("x");
    await asks.onReply(reply(store.openAsks()[0].channelId, "close"));
    expect(changes).toBe(2);
  });

  it("makes summaries one safe line", () => {
    expect(oneLine("Ping <@123> about [the page](https://x.y) @everyone\nsecond")).toBe("Ping <\\@123> about the page @​everyone");
    expect(oneLine("x".repeat(150))).toHaveLength(100);
  });
});

describe("makeRoom", () => {
  it("deletes the oldest closed session channels until the category is under 45", async () => {
    for (let i = 0; i < 45; i += 1) await chat.createChannel(category, `c${i}`);
    for (const name of ["c0", "c1", "c2"]) store.createSession({ id: name, clot: "graphite", channelId: chat.channels.find((c) => c.name === name)!.id, seed: null });
    store.createSession({ id: "live", clot: "graphite", channelId: await chat.createChannel(category, "live"), seed: null });
    expect(await makeRoom(chat, store, "graphite", category)).toBeUndefined();
    expect(chat.channels.length).toBeLessThan(45);
  });

  it("says why when nothing is left to delete", async () => {
    for (let i = 0; i < 45; i += 1) await chat.createChannel(category, `c${i}`);
    expect(await makeRoom(chat, store, "graphite", category)).toContain("no closed session channel");
  });
});

describe("migrateAsks", () => {
  it("withdraws an earlier version's proposals and send reviews with a note, deletes their channels, and runs once", async () => {
    const db = (store as any).db;
    const ruleChannel = await chat.createChannel(category, "graphite-rule");
    const mailChannel = await chat.createChannel(category, "graphite-mail");
    const memoryChannel = await chat.createChannel(category, "home-memory");
    db.prepare("INSERT INTO proposals (clot, channel_id, channel_name, scope, edit, summary) VALUES (?, ?, ?, ?, ?, ?)").run("graphite", ruleChannel, "graphite-rule", "own", "{}", "Drop events where actor is `x`\nmore");
    db.prepare("INSERT INTO send_reviews (clot, channel_id, account, mail, opened_at) VALUES (?, ?, ?, ?, ?)").run("graphite", mailChannel, "tady", JSON.stringify({ to: ["jane@x.com"], subject: "Hi" }), 0);
    db.prepare("INSERT INTO memory_questions (file, text, channel_id, channel_name) VALUES (?, ?, ?, ?)").run("global-clot-a.md", "x", memoryChannel, "home-memory");

    await migrateAsks({ store, chat });
    expect(chat.deleted).toEqual([ruleChannel, mailChannel, memoryChannel]);
    expect(store.notes("graphite").map((note) => note.text)).toEqual([
      "Withdrawn when the daemon was updated: the rule change Drop events where actor is `x`. Ask again if it still makes sense.",
      'Withdrawn when the daemon was updated: the email to jane@x.com, "Hi" (tady). Ask again if it still makes sense.',
    ]);
    expect(store.legacyAsks()).toEqual([]);

    db.prepare("INSERT INTO proposals (clot, channel_id, channel_name, scope, edit, summary) VALUES (?, ?, ?, ?, ?, ?)").run("graphite", "later", "x", "own", "{}", "s");
    await migrateAsks({ store, chat });
    expect(store.legacyAsks()).toHaveLength(1);
  });
});
