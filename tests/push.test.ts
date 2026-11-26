import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { allowedEndpoint, Push, PushStore, type Subscription } from "../src/push.js";

const sub = (n: number): Subscription => ({ endpoint: `https://web.push.apple.com/${n}`, keys: { p256dh: "p", auth: "a" } });

let store: PushStore;
let now: number;
let sent: { endpoint: string; payload: any }[];
let statuses: Record<string, number>;
let push: Push;

beforeEach(() => {
  store = new PushStore(new Database(":memory:"));
  now = 1_000_000;
  sent = [];
  statuses = {};
  push = new Push({
    store,
    now: () => now,
    send: async (s, payload) => {
      sent.push({ endpoint: s.endpoint, payload: JSON.parse(payload) });
      return { status: statuses[s.endpoint] ?? 201 };
    },
  });
});

const ask = { id: 4, clot: "home", summary: "Email to jane@x.com, Hi" } as any;

describe("push", () => {
  it("accepts only https addresses on the known push services", () => {
    expect(allowedEndpoint("https://web.push.apple.com/abc")).toBe(true);
    expect(allowedEndpoint("https://fcm.googleapis.com/fcm/send/x")).toBe(true);
    expect(allowedEndpoint("https://updates.push.services.mozilla.com/wpush/v2/x")).toBe(true);
    expect(allowedEndpoint("https://wns2-par02p.notify.windows.com/x")).toBe(true);
    for (const bad of ["http://web.push.apple.com/x", "https://evil.example.com/x", "https://push.apple.com.evil.com/x", "not a url", "https://127.0.0.1/x"]) expect(allowedEndpoint(bad)).toBe(false);
  });

  it("sends a new ask to every subscription, titled with the Clot's name and opening the ask", async () => {
    store.add(sub(1), now);
    store.add(sub(2), now);
    expect(await push.askOpened(ask)).toBe(2);
    expect(sent.map((s) => s.endpoint)).toEqual([sub(1).endpoint, sub(2).endpoint]);
    expect(sent[0]!.payload).toEqual({ title: "home", body: "Email to jane@x.com, Hi", url: "/c/home?ask=4", tag: "ask-4" });
  });

  it("deletes a subscription the push service says is gone (404 or 410), and keeps the others", async () => {
    store.add(sub(1), now);
    store.add(sub(2), now);
    store.add(sub(3), now);
    statuses[sub(1).endpoint] = 410;
    statuses[sub(2).endpoint] = 404;
    await push.askOpened(ask);
    expect(store.all().map((s) => s.endpoint)).toEqual([sub(3).endpoint]);
  });

  it("keeps a subscription when a send fails for another reason", async () => {
    store.add(sub(1), now);
    push = new Push({ store, now: () => now, send: async () => Promise.reject(Object.assign(new Error("down"), { statusCode: 500 })) });
    expect(await push.askOpened(ask)).toBe(0);
    expect(store.all()).toHaveLength(1);
  });

  it("says an ask is urgent once only", async () => {
    store.add(sub(1), now);
    await push.askUrgent(ask);
    await push.askUrgent(ask);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.payload.body).toContain("Less than a minute left");
  });

  it("sends a reply only when no device has been visible in the last 2 minutes", async () => {
    store.add(sub(1), now);
    push.report("desktop-tab-1", true);
    expect(await push.reply("home", "Hello there")).toBe(0);
    now += 119_000;
    expect(await push.reply("home", "Hello there")).toBe(0);
    now += 2_000;
    expect(await push.reply("home", "Hello there")).toBe(1);
    push.report("desktop-tab-1", true);
    push.report("desktop-tab-1", false);
    expect(await push.reply("home", "Again")).toBe(1);
  });

  it("puts a widget in a reply as one short line, not its code, and the first line of the reply otherwise", async () => {
    store.add(sub(1), now);
    await push.reply("home", "```claritee\nCard { x }\n```");
    await push.reply("home", "\nFirst line\nsecond");
    expect(sent.map((s) => s.payload.body)).toEqual(["Sent you a widget", "First line"]);
  });

  it("names a Clot that stopped", async () => {
    store.add(sub(1), now);
    await push.clotStopped("graphite", "paused", "usage limit");
    await push.clotStopped("graphite", "failed");
    expect(sent.map((s) => s.payload.body)).toEqual(["Paused: usage limit", "Failed"]);
  });
});
