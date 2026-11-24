import type net from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { COMMAND_LIST, parseCommand } from "../../src/commands.js";
import { ConversationService } from "../../src/conversation/conversation.js";
import { Asks } from "../../src/asks.js";
import type { Config } from "../../src/config.js";
import { Store } from "../../src/store.js";
import { EventBus } from "../../src/ui-api/events.js";
import { registerClotRoutes } from "../../src/ui-api/routes/clots.js";
import { registerPrefsRoutes } from "../../src/ui-api/routes/prefs.js";
import { registerWorkerRoutes, workerView } from "../../src/ui-api/routes/workers.js";
import { UiApi } from "../../src/ui-api/server.js";

let store: Store;
let api: UiApi;
let bus: EventBus;
let events: { type: string; data: any }[];
let call: (path: string, init?: RequestInit) => Promise<Response>;

const worker = (id: string, turnId: string | null, extra: Partial<Parameters<Store["createWorker"]>[0]> = {}) =>
  store.createWorker({ id, clot: "graphite", title: `Fix ${id}`, brief: `Fix ${id} in a.ts.\nDone when npm test passes.`, model: "sonnet", effort: "high", branch: `clot/${id}`, base: null, worktree: `/w/${id}`, urgent: false, turnId, ...extra });

beforeEach(async () => {
  store = new Store(":memory:");
  store.upsertClot("graphite");
  store.createSession({ id: "s1", clot: "graphite", seed: null });
  bus = new EventBus("b");
  events = [];
  bus.subscribe((e) => events.push({ type: e.type, data: e.data }));
  let n = 0;
  const conv = new ConversationService({ store, bus, now: () => 1, newId: () => `id${(n += 1)}` });
  const asks = new Asks({ store, conv, now: () => 1, kick: () => undefined, after: () => () => undefined, kinds: [], emit: () => undefined, timeoutMs: () => 600_000 });
  api = new UiApi({ secret: () => "s", bus });
  registerClotRoutes(api, { store, conv, asks, config: () => ({ ui: {}, publicUrl: "", clots: [], sources: { email: [], composio: [] } }) as unknown as Config, clots: () => new Map(), names: () => ["graphite"], now: () => 1 });
  registerWorkerRoutes(api, { store });
  registerPrefsRoutes(api, { store, emit: (prefs) => void bus.emit("config.changed", { ui: prefs }) });
  store.onWorkerChange((w) => w.turnId !== null && bus.emit("workers.updated", { clot: w.clot, turnId: w.turnId }));
  const server = await api.listen(0);
  const port = (server.address() as net.AddressInfo).port;
  call = (path, init = {}) => fetch(`http://127.0.0.1:${port}/api/v1${path}`, { ...init, headers: { "x-clots-ui-secret": "s", "content-type": "application/json" } });
});

afterEach(() => api.close());

describe("GET /commands", () => {
  it("lists every command in plain English, and each one parses as the command it names", async () => {
    const list = (await (await call("/commands")).json()) as { name: string; options: string; description: string }[];
    expect(list).toEqual(COMMAND_LIST);
    expect(list.map((c) => c.name)).toEqual(["close", "effort", "rules", "rules undo", "memory", "memory undo", "spend", "calendar undo", "composio undo", "composio reconnect"]);
    for (const c of list) {
      expect(c.description.length).toBeGreaterThan(10);
      expect(c.description).not.toContain("—");
      const sample = c.name === "effort" ? "/effort low" : c.name === "composio reconnect" ? "/composio reconnect slack:work" : `/${c.name}`;
      expect(parseCommand(sample).kind, c.name).not.toBe("invalid");
      expect(parseCommand(sample).kind, c.name).not.toBe("none");
    }
  });
});

describe("the workers of a turn", () => {
  it("lists them with their model and effort, one line of brief each, and the status the card shows", async () => {
    worker("a1", "turn-1");
    worker("a2", "turn-1");
    worker("other", "turn-2");
    const body = (await (await call("/turns/turn-1/workers")).json()) as any;
    expect(body).toMatchObject({ turnId: "turn-1", clot: "graphite" });
    expect(body.workers).toEqual([
      { id: "a1", title: "Fix a1", brief: "Fix a1 in a.ts.", model: "Sonnet 5.5", effort: "high", status: "queued" },
      { id: "a2", title: "Fix a2", brief: "Fix a2 in a.ts.", model: "Sonnet 5.5", effort: "high", status: "queued" },
    ]);
    expect((await call("/turns/nope/workers")).status).toBe(404);
  });

  it("moves a worker from queued to running to pr-open, telling the UI each time", () => {
    worker("a1", "turn-1");
    store.queueWorker("a1");
    store.setWorker("a1", { status: "running" });
    store.setWorker("a1", { prUrl: "https://github.com/o/r/pull/9", prNumber: 9, prRepo: "o/r" });
    expect(workerView(store.getWorker("a1")!).status).toBe("running");
    store.setWorker("a1", { status: "idle" });
    expect(workerView(store.getWorker("a1")!)).toMatchObject({ status: "pr-open", pr: "https://github.com/o/r/pull/9" });
    expect(events.every((e) => e.type === "workers.updated" && e.data.turnId === "turn-1" && e.data.clot === "graphite")).toBe(true);
    expect(events.length).toBeGreaterThanOrEqual(4);
  });

  it("shows a finished worker with no pull request as done, and a failed one as failed", () => {
    worker("a1", "turn-1");
    worker("a2", "turn-1");
    store.setWorker("a1", { status: "idle" });
    store.setWorker("a2", { status: "failed", failure: "its worktree is gone" });
    expect(workerView(store.getWorker("a1")!).status).toBe("done");
    expect(workerView(store.getWorker("a2")!).status).toBe("failed");
  });

  it("gives a worker's card to the chat message that points at its turn", async () => {
    worker("a1", "turn-1");
    store.conversation.add({ id: "workers:turn-1", clot: "graphite", sessionId: "s1", kind: "workers", text: "", ref: "turn-1", createdAt: 1 });
    const page = (await (await call("/clots/graphite/messages")).json()) as any;
    expect(page.messages[0]).toMatchObject({ kind: "workers", workers: [{ id: "a1", status: "queued" }] });
  });
});

describe("the UI's preferences", () => {
  it("has defaults, changes one thing at a time, and keeps each Clot's pane width", async () => {
    expect(await (await call("/settings/ui")).json()).toEqual({ theme: "system", contentWidth: "wide", paneWidths: {}, notificationsDismissed: false });
    await call("/settings/ui", { method: "PUT", body: JSON.stringify({ theme: "dark" }) });
    await call("/settings/ui", { method: "PUT", body: JSON.stringify({ paneWidths: { graphite: 0.4 } }) });
    const next = await call("/settings/ui", { method: "PUT", body: JSON.stringify({ paneWidths: { home: 0.5 }, contentWidth: "narrow" }) });
    expect(await next.json()).toEqual({ theme: "dark", contentWidth: "narrow", paneWidths: { graphite: 0.4, home: 0.5 }, notificationsDismissed: false });
    expect(events.filter((e) => e.type === "config.changed")).toHaveLength(3);
  });

  it("refuses a value that is not one of the choices", async () => {
    expect((await call("/settings/ui", { method: "PUT", body: JSON.stringify({ theme: "purple" }) })).status).toBe(400);
    expect((await call("/settings/ui", { method: "PUT", body: JSON.stringify({ paneWidths: { graphite: 7 } }) })).status).toBe(400);
  });

  it("persists across a restart", () => {
    const file = `${process.env.TEMP ?? "/tmp"}/clots-prefs-${Date.now()}.db`;
    const first = new Store(file);
    first.conversation.setPref("ui", { theme: "dark" });
    first.close();
    const second = new Store(file);
    expect(second.conversation.pref("ui")).toEqual({ theme: "dark" });
    second.close();
  });
});
