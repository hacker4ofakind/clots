import type net from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Asks, type AskKind } from "../../src/asks.js";
import type { Clot, UserMessage } from "../../src/clot.js";
import type { Config } from "../../src/config.js";
import { ConversationService } from "../../src/conversation/conversation.js";
import { Store } from "../../src/store.js";
import { EventBus } from "../../src/ui-api/events.js";
import { registerClotRoutes } from "../../src/ui-api/routes/clots.js";
import { UiApi } from "../../src/ui-api/server.js";

const SECRET = "s";
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const dataUrl = (bytes: Buffer, type = "image/png") => `data:${type};base64,${bytes.toString("base64")}`;

let store: Store;
let conv: ConversationService;
let asks: Asks;
let api: UiApi;
let call: (path: string, init?: RequestInit) => Promise<Response>;
let received: UserMessage[];
let now: number;
const answers: string[] = [];

const kind: AskKind<{ what: string }> = {
  kind: "rule",
  answers: ["allow", "block"],
  view: (clot, p) => ({ heading: `Allow ${clot} about ${p.what}?`, shortHeading: p.what, rows: [] }),
  texts: { filed: "FILED", already: "ALREADY", full: () => "FULL", notAsked: () => "NO" },
  async onAnswer(ask, answer, io) {
    answers.push(answer.action);
    if (answer.action === "block") return void (await io.close("declined", null, "Declined."));
    io.setBusy();
  },
  async onFeedback(_ask, text, io) {
    answers.push(`feedback:${text}`);
    await io.close("feedback", null, null, undefined, "You answered in chat.");
  },
  async onDeadline(_ask, io) {
    await io.close("timed_out", null, "Blocked.");
  },
};

const config = { ui: { owner: "me@example.com" }, publicUrl: "https://box.tail1.ts.net", clots: [{ name: "graphite", repoUrl: "https://github.com/octo/widgets.git" }], sources: { email: [{ account: "tady", address: "me@tady.ch", shared: true }], composio: [{ toolkit: "linear", account: "team", shared: false, clot: "graphite" }] } } as unknown as Config;

beforeEach(async () => {
  store = new Store(":memory:");
  for (const name of ["home", "graphite"]) {
    store.upsertClot(name);
    store.createSession({ id: `s-${name}`, clot: name, seed: null });
  }
  now = 1_000_000;
  received = [];
  answers.length = 0;
  const bus = new EventBus("b");
  let n = 0;
  conv = new ConversationService({ store, bus, now: () => now, newId: () => `id${(n += 1)}` });
  asks = new Asks({ store, conv, now: () => now, kick: () => undefined, after: () => () => undefined, kinds: [kind], emit: (type, data) => void bus.emit(type, data), timeoutMs: () => 600_000 });
  const clots = new Map<string, Clot>([["graphite", { onMessage: async (m: UserMessage) => void received.push(m) } as unknown as Clot]]);
  api = new UiApi({ secret: () => SECRET, bus });
  registerClotRoutes(api, { store, conv, asks, config: () => config, clots: () => clots, names: () => ["home", "graphite"], now: () => now });
  const server = await api.listen(0);
  const port = (server.address() as net.AddressInfo).port;
  call = (path, init = {}) => fetch(`http://127.0.0.1:${port}/api/v1${path}`, { ...init, headers: { "x-clots-ui-secret": SECRET, "content-type": "application/json", ...(init.headers as Record<string, string>) } });
});

afterEach(() => api.close());

const send = (clot: string, body: Record<string, unknown>) => call(`/clots/${clot}/messages`, { method: "POST", body: JSON.stringify(body) });

describe("identity and Clots", () => {
  it("tells the web app who may use it and the host it is served on", async () => {
    expect(await (await call("/identity")).json()).toEqual({ owner: "me@example.com", serveHost: "box.tail1.ts.net" });
  });

  it("lists the Clots in order with their state, unread replies and waiting asks", async () => {
    await conv.post("home", "hello");
    await asks.open(kind, "graphite", { what: "x" }, { summary: "s", dedupe: "x", max: 3 });
    conv.setState("graphite", "working");
    const list = (await (await call("/clots")).json()) as { name: string; state: string; unread: number; waiting: number; home: boolean }[];
    expect(list).toEqual([
      { name: "home", state: "idle", unread: 1, waiting: 0, home: true, repository: null, preview: "hello", resumesAt: null },
      { name: "graphite", state: "working", unread: 0, waiting: 1, home: false, repository: "octo/widgets", preview: null, resumesAt: null },
    ]);
  });

  it("describes a Clot: its repository and the accounts that apply to it", async () => {
    const info = (await (await call("/clots/graphite")).json()) as any;
    expect(info.repository).toBe("octo/widgets");
    expect(info.connections.map((c: any) => [c.kind, c.account])).toEqual([["email", "tady"], ["composio", "team"]]);
    expect((await call("/clots/nobody")).status).toBe(404);
  });
});

describe("messages", () => {
  it("stores a sent message, hands it to the Clot once, and answers with it", async () => {
    const res = await send("graphite", { id: "client-uuid-1", text: "hello there" });
    expect(res.status).toBe(201);
    expect(((await res.json()) as any).message).toMatchObject({ id: "client-uuid-1", kind: "user", text: "hello there", sessionId: "s-graphite" });
    expect(received).toMatchObject([{ id: "client-uuid-1", text: "hello there", images: 0 }]);
  });

  it("treats a retry with the same ID as the same send", async () => {
    await send("graphite", { id: "client-uuid-2", text: "once" });
    const again = await send("graphite", { id: "client-uuid-2", text: "once" });
    expect(again.status).toBe(200);
    expect(((await again.json()) as any).duplicate).toBe(true);
    expect(received).toHaveLength(1);
    expect(store.conversation.list("graphite")).toHaveLength(1);
  });

  it("refuses an empty message, a bad body, an unknown Clot and an image that is not one", async () => {
    expect((await send("graphite", { id: "client-uuid-3", text: "  " })).status).toBe(400);
    expect((await send("graphite", { text: "no id" })).status).toBe(400);
    expect((await send("nobody", { id: "client-uuid-4", text: "x" })).status).toBe(404);
    const bad = await send("graphite", { id: "client-uuid-5", text: "x", images: [dataUrl(Buffer.from("<svg onload=alert(1)>"), "image/png")] });
    expect(bad.status).toBe(400);
    expect(received).toEqual([]);
  });

  it("takes an image by its own bytes, not by the type it claims, and serves it back with nosniff", async () => {
    const res = await send("graphite", { id: "client-uuid-6", text: "", images: [dataUrl(PNG, "image/jpeg")] });
    expect(res.status).toBe(201);
    expect(received[0]).toMatchObject({ images: 1 });
    const image = await call("/clots/graphite/messages/client-uuid-6/images/0");
    expect(image.headers.get("content-type")).toBe("image/png");
    expect(image.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await image.arrayBuffer())).toEqual(PNG);
    expect((await call("/clots/graphite/messages/client-uuid-6/images/3")).status).toBe(404);
    expect((await call("/clots/home/messages/client-uuid-6/images/0")).status).toBe(404);
  });

  it("pages a chat newest first, with the cursor, and shows an ask message as its card", async () => {
    for (let i = 1; i <= 52; i += 1) await conv.post("graphite", `m${i}`);
    await asks.open(kind, "graphite", { what: "x" }, { summary: "About x", dedupe: "x", max: 3 });
    const first = (await (await call("/clots/graphite/messages")).json()) as { messages: any[]; hasMore: boolean };
    expect(first.messages).toHaveLength(50);
    expect(first.hasMore).toBe(true);
    expect(first.messages[0]).toMatchObject({ kind: "ask", ask: { state: "open", snapshot: { clot: "graphite", timer: "calm", view: { heading: "Allow graphite about x?" } } } });
    expect(first.messages[0].ask.snapshot.messageId).toBe(first.messages[0].id);
    const next = (await (await call(`/clots/graphite/messages?before=${first.messages.at(-1).id}`)).json()) as { messages: any[]; hasMore: boolean };
    expect(next.messages.map((m) => m.text)).toEqual(["m3", "m2", "m1"]);
    expect(next.hasMore).toBe(false);
  });

  it("shows a closed ask's card with how it ended", async () => {
    await asks.open(kind, "graphite", { what: "x" }, { summary: "About x", dedupe: "x", max: 3 });
    await asks.answer(store.openAsks()[0]!.id, { action: "block" });
    const page = (await (await call("/clots/graphite/messages")).json()) as { messages: any[] };
    const card = page.messages.find((m) => m.kind === "ask").ask;
    expect(card).toMatchObject({ state: "closed", outcome: "Declined.", result: "declined", summary: "About x", view: { heading: "Allow graphite about x?" } });
  });

  it("hands text typed while an ask is open to the ask as feedback, not to the Clot, but not a command or an image", async () => {
    await asks.open(kind, "graphite", { what: "x" }, { summary: "About x", dedupe: "x", max: 3 });
    await send("graphite", { id: "client-uuid-7", text: "/spend" });
    await send("graphite", { id: "client-uuid-8", text: "", images: [dataUrl(PNG)] });
    expect(answers).toEqual([]);
    expect(received).toHaveLength(2);
    const res = await send("graphite", { id: "client-uuid-9", text: "please wait" });
    expect(res.status).toBe(200);
    expect(answers).toEqual(["feedback:please wait"]);
    expect(received).toHaveLength(2);
    expect(store.conversation.get("client-uuid-9")).toMatchObject({ kind: "user", text: "please wait" });
  });

  it("marks a chat read", async () => {
    await conv.post("home", "hi");
    await call("/clots/home/read", { method: "POST", body: "{}" });
    expect(store.conversation.unread("home")).toBe(0);
  });
});

describe("asks", () => {
  it("lists what is waiting, with its message, and answers it once", async () => {
    await asks.open(kind, "graphite", { what: "x" }, { summary: "About x", dedupe: "x", max: 3 });
    const list = (await (await call("/asks")).json()) as any[];
    expect(list).toMatchObject([{ clot: "graphite", kind: "rule", summary: "About x", timer: "calm", state: "open" }]);
    expect(list[0].messageId).toBeTruthy();
    const answered = await call(`/asks/${list[0].id}/answer`, { method: "POST", body: JSON.stringify({ answer: { action: "block" } }) });
    expect(answered.status).toBe(200);
    expect(await answered.json()).toEqual({ outcome: "Declined.", result: "declined" });
    const late = await call(`/asks/${list[0].id}/answer`, { method: "POST", body: JSON.stringify({ answer: { action: "allow" } }) });
    expect(late.status).toBe(409);
    expect(await late.json()).toEqual({ outcome: "Declined.", result: "declined" });
    expect(answers).toEqual(["block"]);
  });

  it("says an ask being carried out is in progress, refuses an answer its kind does not take, and an unknown ask", async () => {
    await asks.open(kind, "graphite", { what: "x" }, { summary: "About x", dedupe: "x", max: 3 });
    const id = store.openAsks()[0]!.id;
    expect((await call(`/asks/${id}/answer`, { method: "POST", body: JSON.stringify({ answer: { action: "pick", option: 0 } }) })).status).toBe(400);
    expect((await call(`/asks/${id}/answer`, { method: "POST", body: JSON.stringify({ answer: { action: "allow" } }) })).status).toBe(200);
    const busy = await call(`/asks/${id}/answer`, { method: "POST", body: JSON.stringify({ answer: { action: "allow" } }) });
    expect(busy.status).toBe(202);
    expect(await busy.json()).toEqual({ outcome: "in progress" });
    expect((await call("/asks/999/answer", { method: "POST", body: JSON.stringify({ answer: { action: "allow" } }) })).status).toBe(404);
    expect((await call(`/asks/${id}/answer`, { method: "POST", body: JSON.stringify({ answer: { action: "frobnicate" } }) })).status).toBe(400);
  });

  it("takes a retry of the same answer, by its key, as the first one", async () => {
    await asks.open(kind, "graphite", { what: "x" }, { summary: "About x", dedupe: "x", max: 3 });
    const id = store.openAsks()[0]!.id;
    const body = JSON.stringify({ answer: { action: "block" }, key: "retry-key-1" });
    expect((await call(`/asks/${id}/answer`, { method: "POST", body })).status).toBe(200);
    const again = await call(`/asks/${id}/answer`, { method: "POST", body });
    expect(again.status).toBe(200);
    expect(answers).toEqual(["block"]);
  });
});
