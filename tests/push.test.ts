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

  it("tracks a device as looking only while it reports being visible, for two minutes", () => {
    push.report("desktop-tab-1", true);
    expect(push.attended()).toBe(true);
    now += 119_000;
    expect(push.attended()).toBe(true);
    now += 2_000;
    expect(push.attended()).toBe(false);
    push.report("desktop-tab-1", true);
    push.report("desktop-tab-1", false);
    expect(push.attended()).toBe(false);
  });

  describe("onEvent: the phone hears only what waits on the user", () => {
    beforeEach(() => store.add(sub(1), now));
    const fire = async (type: string, data: unknown) => {
      const p = push.onEvent({ type, data });
      return p === null ? null : await p;
    };

    it("pushes a new ask (permission, rule, merge, email, choice)", async () => {
      for (const kind of ["rule", "email", "merge", "choice", "composio"]) expect(await fire("ask.opened", { ...ask, kind })).toBe(1);
      expect(sent).toHaveLength(5);
    });

    it("pushes an ask in its last minute, and a choice the timeout decided", async () => {
      expect(await fire("ask.updated", { ...ask, timer: "urgent" })).toBe(1);
      expect(await fire("ask.closed", { id: 4, clot: "home", kind: "choice", result: "timed_out", outcome: "Went with A" })).toBe(1);
      expect(sent.map((s) => s.payload.body)).toEqual(["Less than a minute left: Email to jane@x.com, Hi", "Went with A"]);
    });

    it("stays quiet for a Clot's reply, a finished turn, and a Clot pausing or failing", async () => {
      expect(await fire("message.created", { clot: "home", text: "All done!" })).toBeNull();
      expect(await fire("clot.reply", { clot: "home", text: "Done" })).toBeNull();
      expect(await fire("clot.state", { clot: "home", state: "idle" })).toBeNull();
      expect(await fire("clot.state", { clot: "home", state: "paused", reason: "usage limit" })).toBeNull();
      expect(await fire("clot.state", { clot: "home", state: "failed" })).toBeNull();
      expect(sent).toEqual([]);
    });

    it("stays quiet for ask changes that are not a reason to look", async () => {
      expect(await fire("ask.updated", { ...ask, timer: "normal" })).toBeNull();
      expect(await fire("ask.closed", { id: 4, clot: "home", kind: "choice", result: "answered", outcome: "A" })).toBeNull();
      expect(await fire("ask.closed", { id: 4, clot: "home", kind: "email", result: "timed_out", outcome: "x" })).toBeNull();
      expect(sent).toEqual([]);
    });
  });
});
