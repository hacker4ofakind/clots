import { beforeEach, describe, expect, it } from "vitest";
import { ConversationService } from "../src/conversation/conversation.js";
import { Store } from "../src/store.js";
import { EventBus } from "../src/ui-api/events.js";

let store: Store;
let bus: EventBus;
let events: { type: string; data: any }[];
let conv: ConversationService;
let n: number;
let replies: string[];

beforeEach(() => {
  store = new Store(":memory:");
  store.upsertClot("graphite");
  store.createSession({ id: "s1", clot: "graphite", seed: null });
  bus = new EventBus("b");
  events = [];
  bus.subscribe((e) => events.push({ type: e.type, data: e.data }));
  n = 0;
  replies = [];
  conv = new ConversationService({ store, bus, now: () => 1000 + n, newId: () => `id${(n += 1)}`, onReply: (_clot, m) => void replies.push(m.text) });
});

describe("the conversation", () => {
  it("stores what the Clot says under the active session and tells the UI", async () => {
    const id = await conv.post("graphite", "Hello.");
    expect(store.conversation.get(id)).toMatchObject({ kind: "clot", text: "Hello.", sessionId: "s1", clot: "graphite" });
    expect(events.map((e) => e.type)).toEqual(["message.created"]);
    expect(events[0]!.data.message).toMatchObject({ id, kind: "clot", text: "Hello." });
    expect(replies).toEqual(["Hello."]);
  });

  it("sends deltas first and a message.done with the final text, for a reply that was streamed", async () => {
    conv.delta("graphite", "m-1", "Hel");
    conv.delta("graphite", "m-1", "lo");
    await conv.post("graphite", "Hello.", { id: "m-1" });
    expect(events.map((e) => e.type)).toEqual(["message.delta", "message.delta", "message.done"]);
    expect(events.at(-1)!.data.message).toMatchObject({ id: "m-1", text: "Hello." });
    expect(store.conversation.get("m-1")!.text).toBe("Hello.");
  });

  it("marks notes, and a recap, and keeps them out of reply notifications", async () => {
    const note = await conv.post("graphite", "Context limit reached.", { kind: "note" });
    const recap = await conv.post("graphite", "The recap.", { kind: "note", recap: true });
    expect(store.conversation.get(note)).toMatchObject({ kind: "note", data: null });
    expect(store.conversation.get(recap)).toMatchObject({ kind: "note", data: { recap: true } });
    expect(replies).toEqual([]);
  });

  it("stores a user message once: a retry with the same ID is not a second message", () => {
    const first = conv.addUser("graphite", { id: "u-1", text: "hi", at: 5 });
    const again = conv.addUser("graphite", { id: "u-1", text: "hi", at: 6 });
    expect(first.created).toBe(true);
    expect(again.created).toBe(false);
    expect(store.conversation.list("graphite")).toHaveLength(1);
    expect(events.filter((e) => e.type === "message.created")).toHaveLength(1);
  });

  it("keeps images with a message, and reads them back", () => {
    conv.addUser("graphite", { id: "u-2", text: "see", at: 5, images: [{ mediaType: "image/png", data: Buffer.from([1, 2, 3]) }] });
    expect(store.conversation.get("u-2")!.images).toBe(1);
    expect(store.conversation.image("u-2", 0)).toEqual({ mediaType: "image/png", data: Buffer.from([1, 2, 3]) });
    expect(store.conversation.imagesOf("u-2")).toHaveLength(1);
  });

  it("pages newest first by cursor, across a rollover", async () => {
    for (let i = 1; i <= 7; i += 1) await conv.post("graphite", `m${i}`);
    store.createSession({ id: "s2", clot: "graphite", seed: "recap" });
    await conv.post("graphite", "after");
    const first = store.conversation.list("graphite", undefined, 3);
    expect(first.map((m) => m.text)).toEqual(["after", "m7", "m6"]);
    expect(first[0]!.sessionId).toBe("s2");
    const next = store.conversation.list("graphite", first.at(-1)!.id, 3);
    expect(next.map((m) => m.text)).toEqual(["m5", "m4", "m3"]);
    expect(store.conversation.list("graphite", next.at(-1)!.id, 10).map((m) => m.text)).toEqual(["m2", "m1"]);
  });

  it("stores an activity line, a turn summary, an ask and a workers message, and sends one workers message per turn", async () => {
    conv.activityLine("graphite", { icon: "FileText", text: "Read x.ts" });
    await conv.postActivity("graphite", { files: [{ path: "a.ts", added: 1, removed: 0 }], commands: ["npm test"] });
    await conv.postAsk("graphite", 7);
    await conv.postWorkers("graphite", "turn-1");
    await conv.postWorkers("graphite", "turn-1");
    const rows = store.conversation.list("graphite").reverse();
    expect(rows.map((r) => r.kind)).toEqual(["activity", "activity", "ask", "workers"]);
    expect(rows[0]).toMatchObject({ text: "Read x.ts", data: { type: "line", icon: "FileText" } });
    expect(rows[1]).toMatchObject({ data: { type: "summary", commands: ["npm test"] } });
    expect(rows[2]).toMatchObject({ ref: "7" });
    expect(events.map((e) => e.type)).toEqual(["activity", "message.created", "message.created", "message.created"]);
  });

  it("tracks the Clot's state and says so only when it changes", () => {
    expect(conv.stateOf("graphite")).toEqual({ state: "idle" });
    conv.setState("graphite", "working");
    conv.setState("graphite", "working");
    conv.setState("graphite", "failed", "The last turn ended with an error");
    expect(events.filter((e) => e.type === "clot.state").map((e) => e.data)).toEqual([{ clot: "graphite", state: "working" }, { clot: "graphite", state: "failed", reason: "The last turn ended with an error" }]);
    store.setPausedUntil("graphite", Math.floor(Date.now() / 1000) + 3600);
    const paused = new ConversationService({ store, bus, now: () => Date.now(), newId: () => "x" });
    expect(paused.stateOf("graphite")).toEqual({ state: "paused", reason: "usage limit" });
  });

  it("counts the replies the user has not read, and forgets them once read", async () => {
    await conv.post("graphite", "a");
    await conv.post("graphite", "b");
    await conv.post("graphite", "n", { kind: "note" });
    expect(store.conversation.unread("graphite")).toBe(2);
    store.conversation.markRead("graphite");
    expect(store.conversation.unread("graphite")).toBe(0);
    await conv.post("graphite", "c");
    expect(store.conversation.unread("graphite")).toBe(1);
  });

  it("remembers how a closed ask ended, and only the newest 500", () => {
    for (let id = 1; id <= 503; id += 1) store.conversation.recordAskOutcome({ id, clot: "graphite", kind: "rule", summary: "s", view: { heading: "h" }, outcome: `o${id}`, result: "approved", closedAt: id, answerKey: null });
    expect(store.conversation.askOutcome(1)).toBeUndefined();
    expect(store.conversation.askOutcome(503)).toMatchObject({ outcome: "o503", view: { heading: "h" } });
  });

  it("reads a row closed before results were kept with no result", () => {
    (store.conversation as any).db.prepare("INSERT INTO ask_history (id, clot, kind, summary, view, outcome, closed_at) VALUES (7, 'graphite', 'rule', 's', '{}', 'old', 1)").run();
    expect(store.conversation.askOutcome(7)).toMatchObject({ outcome: "old", result: null });
  });
});
