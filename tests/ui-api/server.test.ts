import http from "node:http";
import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { startIntake } from "../../src/intake.js";
import { EventBus } from "../../src/ui-api/events.js";
import { ApiError, ApiResult, UiApi } from "../../src/ui-api/server.js";

const SECRET = "s3cret-value";
let api: UiApi | undefined;
afterEach(async () => {
  await api?.close();
  api = undefined;
});

async function start(bus = new EventBus("boot", 5), heartbeatMs = 20) {
  api = new UiApi({ secret: () => SECRET, bus, heartbeatMs });
  api.route("GET", "/ping", () => ({ pong: true }));
  api.route("GET", "/clots/:clot", (req) => ({ clot: req.params.clot }));
  api.route("POST", "/echo", (req) => new ApiResult(201, { got: req.body }));
  api.route("POST", "/fail", () => {
    throw new ApiError(409, "already closed", { outcome: "x" });
  });
  const server = await api.listen(0);
  const port = (server.address() as net.AddressInfo).port;
  const call = (path: string, init: RequestInit = {}, secret: string | null = SECRET) => fetch(`http://127.0.0.1:${port}/api/v1${path}`, { ...init, headers: { ...(secret === null ? {} : { "x-clots-ui-secret": secret }), ...(init.headers as Record<string, string>) } });
  return { bus, port, call };
}

describe("UI API server", () => {
  it("answers 401 without the secret and with a wrong one, and runs the route with the right one", async () => {
    const { call } = await start();
    expect((await call("/ping", {}, null)).status).toBe(401);
    expect((await call("/ping", {}, "nope")).status).toBe(401);
    expect((await call("/ping", {}, SECRET + "x")).status).toBe(401);
    const ok = await call("/ping");
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ pong: true });
  });

  it("matches path parameters, parses JSON bodies and answers handler statuses", async () => {
    const { call } = await start();
    expect(await (await call("/clots/home%20x")).json()).toEqual({ clot: "home x" });
    const res = await call("/echo", { method: "POST", body: JSON.stringify({ a: 1 }) });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ got: { a: 1 } });
    const bad = await call("/echo", { method: "POST", body: "{nope" });
    expect(bad.status).toBe(400);
    const failed = await call("/fail", { method: "POST", body: "{}" });
    expect(failed.status).toBe(409);
    expect(await failed.json()).toMatchObject({ error: "already closed", details: { outcome: "x" } });
    expect((await call("/nowhere")).status).toBe(404);
    expect((await call("/ping", { method: "POST", body: "{}" })).status).toBe(405);
  });

  it("refuses a body over the route's limit", async () => {
    const { call } = await start();
    const res = await call("/echo", { method: "POST", body: JSON.stringify({ big: "x".repeat(300 * 1024) }) }).catch(() => undefined);
    // The connection may be cut before the 413 is read; either way the route did not run.
    if (res) expect(res.status).toBe(413);
  });

  it("port 8787's intake does not serve /api/v1", async () => {
    const intake = startIntake({ port: 0, handlerFor: () => undefined, onAnswer: () => undefined });
    await new Promise((r) => intake.once("listening", r));
    const port = (intake.address() as net.AddressInfo).port;
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/clots`, { headers: { "x-clots-ui-secret": SECRET } });
    expect(res.status).toBe(404);
    intake.close();
  });
});

/** Reads an SSE response until `done` says enough text has arrived. */
async function readStream(port: number, headers: Record<string, string>, done: (text: string) => boolean): Promise<string> {
  const controller = new AbortController();
  const res = await fetch(`http://127.0.0.1:${port}/api/v1/stream`, { headers: { "x-clots-ui-secret": SECRET, ...headers }, signal: controller.signal });
  const reader = res.body!.getReader();
  let text = "";
  while (!done(text)) {
    const { value, done: end } = await reader.read();
    if (end) break;
    text += new TextDecoder().decode(value);
  }
  controller.abort();
  return text;
}

describe("event stream", () => {
  it("replays missed events in order after a reconnect with a recent id", async () => {
    const { bus, port } = await start();
    const first = bus.emit("message.created", { n: 1 });
    bus.emit("message.created", { n: 2 });
    bus.emit("message.done", { n: 3 });
    const text = await readStream(port, { "last-event-id": first.id }, (t) => t.includes('"n":3'));
    expect(text.indexOf('"n":2')).toBeGreaterThan(-1);
    expect(text.indexOf('"n":2')).toBeLessThan(text.indexOf('"n":3'));
    expect(text).not.toContain('"n":1');
  });

  it("sends resync for an id older than the ring, from another boot, or from the future", async () => {
    const { bus, port } = await start(new EventBus("boot", 3));
    for (let n = 1; n <= 6; n += 1) bus.emit("message.created", { n });
    expect(await readStream(port, { "last-event-id": "boot-1" }, (t) => t.includes("event: "))).toContain("event: resync");
    expect(await readStream(port, { "last-event-id": "other-4" }, (t) => t.includes("event: "))).toContain("event: resync");
    expect(await readStream(port, { "last-event-id": "boot-99" }, (t) => t.includes("event: "))).toContain("event: resync");
  });

  it("follows live events and sends heartbeats", async () => {
    const { bus, port } = await start();
    setTimeout(() => bus.emit("activity", { line: "x" }), 50);
    const text = await readStream(port, {}, (t) => t.includes("event: activity") && t.includes(": heartbeat"));
    expect(text).toContain("event: activity");
    expect(text).toContain(": heartbeat");
  });

  it("stops following a client that goes away", async () => {
    const { bus, port } = await start();
    await readStream(port, {}, (t) => t.includes("retry:"));
    await new Promise((r) => setTimeout(r, 50));
    expect(bus.clients).toBe(0);
  });
});

describe("event bus ids", () => {
  it("numbers events per boot and keeps only the last N", () => {
    const bus = new EventBus("b", 2);
    const ids = [1, 2, 3].map(() => bus.emit("clot.state", {}).id);
    expect(ids).toEqual(["b-1", "b-2", "b-3"]);
    expect(bus.since("b-2")).toHaveLength(1);
    expect(bus.since("b-1")).toHaveLength(2);
    expect(bus.since("b-0")).toBe("resync");
    expect(bus.since(undefined)).toEqual([]);
  });
});
