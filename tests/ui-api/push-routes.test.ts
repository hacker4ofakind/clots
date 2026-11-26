import type net from "node:net";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Push, PushStore } from "../../src/push.js";
import { EventBus } from "../../src/ui-api/events.js";
import { registerPushRoutes } from "../../src/ui-api/routes/push.js";
import { UiApi } from "../../src/ui-api/server.js";

let api: UiApi;
let store: PushStore;
let push: Push;
let sent: string[];
let now: number;
let call: (method: string, path: string, body?: unknown) => Promise<Response>;

beforeEach(async () => {
  store = new PushStore(new Database(":memory:"));
  now = 1_000_000;
  sent = [];
  push = new Push({ store, now: () => now, send: async (s) => (sent.push(s.endpoint), { status: 201 }) });
  api = new UiApi({ secret: () => "s", bus: new EventBus("b") });
  registerPushRoutes(api, { push, subscriptions: store, publicKey: () => "pub", now: () => now });
  const server = await api.listen(0);
  const port = (server.address() as net.AddressInfo).port;
  call = (method, path, body) => fetch(`http://127.0.0.1:${port}/api/v1${path}`, { method, headers: { "x-clots-ui-secret": "s", "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
});
afterEach(() => api.close());

describe("the push routes", () => {
  it("take a subscription only on a known push service, and drop one on request", async () => {
    const keys = { p256dh: "p", auth: "a" };
    expect((await call("POST", "/push/subscribe", { endpoint: "https://evil.example.com/x", keys })).status).toBe(400);
    expect((await call("POST", "/push/subscribe", { endpoint: "http://web.push.apple.com/x", keys })).status).toBe(400);
    expect((await call("POST", "/push/subscribe", { endpoint: "https://web.push.apple.com/x", keys })).status).toBe(200);
    expect(await (await call("GET", "/push/status")).json()).toEqual({ subscriptions: 1 });
    await call("DELETE", `/push/subscribe?endpoint=${encodeURIComponent("https://web.push.apple.com/x")}`);
    expect(await (await call("GET", "/push/status")).json()).toEqual({ subscriptions: 0 });
  });

  it("count a tab as someone looking only while it reports being visible, for two minutes", async () => {
    await call("POST", "/push/subscribe", { endpoint: "https://web.push.apple.com/x", keys: { p256dh: "p", auth: "a" } });
    await call("POST", "/push/visibility", { clientId: "desktop-tab-1", visible: true });
    expect(await push.reply("home", "Hello")).toBe(0);
    await call("POST", "/push/visibility", { clientId: "desktop-tab-1", visible: false });
    expect(await push.reply("home", "Hello")).toBe(1);
    expect((await call("POST", "/push/visibility", { clientId: "x", visible: true })).status).toBe(400);
  });
});
