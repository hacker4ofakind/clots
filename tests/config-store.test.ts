import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type net from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigStore } from "../src/config-store.js";
import { LiveEnv } from "../src/live-env.js";
import { EventBus } from "../src/ui-api/events.js";
import { registerSettingsRoutes } from "../src/ui-api/routes/settings.js";
import { UiApi } from "../src/ui-api/server.js";

const base = { timeZone: "UTC", image: "clots-clot:dev", ui: { owner: "me@example.com" }, clots: [{ name: "graphite", repoUrl: "https://github.com/o/r.git" }, { name: "shop", repoUrl: "https://github.com/o/s.git" }], home: true };
const ENV = "CLAUDE_CODE_OAUTH_TOKEN=c\nCLOT_GITHUB_TOKEN=gh\nGITHUB_WEBHOOK_SECRET=w\n# my notes\nZED_KEY=zzzz1234\n";

let dir: string;
let file: string;
let envFile: string;
let store: ConfigStore;
let changed: { keys: string[]; needsRestart: string[]; fromFile: boolean; error?: string }[];

const write = (json: unknown) => fs.writeFileSync(file, typeof json === "string" ? json : JSON.stringify(json, null, 2));
const settle = (ms = 700) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "clots-cfg-"));
  file = path.join(dir, "clots.config.json");
  envFile = path.join(dir, ".env");
  fs.writeFileSync(envFile, ENV);
  write(base);
  changed = [];
  store = new ConfigStore({ file, envFile, env: new LiveEnv(envFile, {}), onChanged: (e) => void changed.push(e) });
});
afterEach(() => store.close());

describe("the config store", () => {
  it("saves a change atomically, keeps the old file as a backup, and applies it at once", async () => {
    const applied: number[] = [];
    store.onChange(["maxWorkers"], (next) => void applied.push(next.maxWorkers));
    const result = await store.save({ maxWorkers: 2 });
    expect(result).toEqual({ ok: true, applied: ["maxWorkers"], needsRestart: [] });
    expect(applied).toEqual([2]);
    expect(store.current.maxWorkers).toBe(2);
    expect(JSON.parse(fs.readFileSync(file, "utf8")).maxWorkers).toBe(2);
    expect(JSON.parse(fs.readFileSync(`${file}.bak`, "utf8")).maxWorkers).toBeUndefined();
    expect(fs.existsSync(`${file}.tmp`)).toBe(false);
  });

  it("carries a file's choiceTimeoutMinutes over as askTimeoutMinutes, and renames it in the file when it saves", async () => {
    store.close();
    write({ ...base, choiceTimeoutMinutes: 7 });
    store = new ConfigStore({ file, envFile, env: new LiveEnv(envFile, {}) });
    expect(store.current.askTimeoutMinutes).toBe(7);
    await store.save({ maxWorkers: 2 });
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(saved.askTimeoutMinutes).toBe(7);
    expect(saved).not.toHaveProperty("choiceTimeoutMinutes");
    expect(store.current.askTimeoutMinutes).toBe(7);
  });

  it("writes nothing when a change would not load, and says which field", async () => {
    const result = await store.save({ maxWorkers: 99 });
    expect(result).toMatchObject({ ok: false, errors: { maxWorkers: expect.any(String) } });
    expect(JSON.parse(fs.readFileSync(file, "utf8")).maxWorkers).toBeUndefined();
    expect(store.current.maxWorkers).toBe(3);
  });

  it("reports a key nothing applies live as needing a restart, and leaves what is running as it is", async () => {
    const result = await store.save({ intake: { port: 9999 } });
    expect(result).toEqual({ ok: true, applied: [], needsRestart: ["intake"] });
    const other = await store.save({ rulebookDir: "elsewhere" });
    expect(other).toMatchObject({ needsRestart: ["rulebookDir"] });
  });

  it("applies a hand edit without a restart, and ignores a file that does not load, keeping the last good one in force", async () => {
    store.watch();
    const applied: number[] = [];
    store.onChange(["rolloverPercent"], (next) => void applied.push(next.rolloverPercent));
    write({ ...base, rolloverPercent: 70 });
    await settle();
    expect(applied).toEqual([70]);
    expect(changed.at(-1)).toMatchObject({ fromFile: true, keys: ["rolloverPercent"] });
    write("{ not json");
    await settle();
    expect(store.current.rolloverPercent).toBe(70);
    expect(store.error).toBeTruthy();
    expect(changed.at(-1)).toMatchObject({ fromFile: true, keys: [], error: expect.any(String) });
    write({ ...base, rolloverPercent: 80 });
    await settle();
    expect(store.error).toBeUndefined();
    expect(store.current.rolloverPercent).toBe(80);
  });

  it("does not take its own write for a hand edit", async () => {
    store.watch();
    await store.save({ maxWorkers: 4 });
    const count = changed.length;
    await settle();
    expect(changed).toHaveLength(count);
  });

  it("returns key names with the last four characters, never a value", () => {
    const keys = store.keys();
    expect(keys.find((k) => k.name === "ZED_KEY")).toEqual({ name: "ZED_KEY", last4: "1234", protected: false });
    expect(JSON.stringify(keys)).not.toContain("zzzz");
    expect(keys.find((k) => k.name === "CLAUDE_CODE_OAUTH_TOKEN")!.protected).toBe(true);
  });

  it("writes a key by name, keeping comments and order, and shows the new last four", () => {
    expect(store.setKey("TEST_UI_KEY", "abcd1234")).toEqual({ ok: true });
    expect(store.keys().find((k) => k.name === "TEST_UI_KEY")).toMatchObject({ last4: "1234" });
    expect(fs.readFileSync(envFile, "utf8")).toBe(`${ENV}TEST_UI_KEY=abcd1234\n`);
    expect(store.setKey("ZED_KEY", "new-value-9999")).toEqual({ ok: true });
    expect(fs.readFileSync(envFile, "utf8")).toContain("# my notes\nZED_KEY=new-value-9999\n");
  });

  it("refuses bad names, protected keys and values with a line break", () => {
    expect(store.setKey("lower", "x")).toMatchObject({ ok: false });
    expect(store.setKey("A".repeat(65), "x")).toMatchObject({ ok: false });
    expect(store.setKey("CLOTS_UI_SECRET", "x")).toMatchObject({ ok: false, error: expect.stringContaining("daemon's own") });
    expect(store.setKey("VAPID_PRIVATE_KEY", "x")).toMatchObject({ ok: false });
    expect(store.setKey("OK_KEY", "a\nb")).toMatchObject({ ok: false });
    expect(store.removeKey("CLAUDE_CODE_OAUTH_TOKEN")).toMatchObject({ ok: false });
  });

  it("refuses to remove a key the configuration still names, and says where", async () => {
    store.setKey("LINEAR_TEAM_KEY", "lin_1234");
    await store.save({ sources: { composio: [{ toolkit: "linear", account: "team", shared: true, audience: "team", apiKey: "LINEAR_TEAM_KEY" }] } });
    const res = store.removeKey("LINEAR_TEAM_KEY");
    expect(res).toMatchObject({ ok: false, error: expect.stringContaining("sources.composio[0].apiKey") });
    expect(store.keys().some((k) => k.name === "LINEAR_TEAM_KEY")).toBe(true);
    expect(store.removeKey("ZED_KEY")).toEqual({ ok: true });
    expect(fs.readFileSync(envFile, "utf8")).not.toContain("ZED_KEY");
  });

  it("reads a key written while it ran, though the process never had it in its environment", async () => {
    store.setKey("COMPOSIO_API_KEY_NEW", "k-1234");
    store.setKey("LATE_KEY", "late-5678");
    const result = await store.save({ mcpServers: { x: { url: "https://example.com/mcp", headers: { Authorization: "LATE_KEY" }, oauth: false } } });
    expect(result.ok).toBe(true);
    expect((store.current.mcpServers.x as { headers: Record<string, string> }).headers.Authorization).toBe("late-5678");
  });
});

describe("the settings routes", () => {
  let api: UiApi;
  let call: (p: string, init?: RequestInit) => Promise<Response>;
  let removed: string[];
  let order: string[][];

  beforeEach(async () => {
    removed = [];
    order = [];
    api = new UiApi({ secret: () => "s", bus: new EventBus("b") });
    registerSettingsRoutes(api, { config: store, removeClot: async (n) => void removed.push(n), reorder: (o) => void order.push(o), announce: () => undefined });
    const server = await api.listen(0);
    const port = (server.address() as net.AddressInfo).port;
    call = (p, init = {}) => fetch(`http://127.0.0.1:${port}/api/v1${p}`, { ...init, headers: { "x-clots-ui-secret": "s", "content-type": "application/json" } });
  });
  afterEach(() => api.close());

  it("reads and saves the general settings, with the error beside the field when one is wrong", async () => {
    expect(await (await call("/settings/general")).json()).toMatchObject({ timeZone: "UTC", maxWorkers: 3, askTimeoutMinutes: 10 });
    const ok = await call("/settings/general", { method: "PUT", body: JSON.stringify({ maxWorkers: 2, askTimeoutMinutes: 2 }) });
    expect(await ok.json()).toMatchObject({ maxWorkers: 2, askTimeoutMinutes: 2, applied: [] });
    const bad = await call("/settings/general", { method: "PUT", body: JSON.stringify({ rolloverPercent: 300 }) });
    expect(bad.status).toBe(400);
    expect(store.current.rolloverPercent).toBe(65);
  });

  it("never returns a key's value, and a PUT then a GET shows the new last four", async () => {
    await call("/keys/TEST_UI_KEY", { method: "PUT", body: JSON.stringify({ value: "abcd1234" }) });
    const text = await (await call("/keys")).text();
    expect(text).toContain('"last4":"1234"');
    expect(text).not.toContain("abcd1234");
    expect((await call("/keys/CLOTS_UI_SECRET", { method: "PUT", body: JSON.stringify({ value: "x" }) })).status).toBe(400);
  });

  it("refuses to delete the home Clot, wants the name typed, and stops another Clot while keeping its volumes", async () => {
    expect((await call("/clots/home?confirm=home", { method: "DELETE" })).status).toBe(409);
    expect((await call("/clots/shop", { method: "DELETE" })).status).toBe(400);
    const ok = await call("/clots/shop?confirm=shop", { method: "DELETE" });
    expect(ok.status).toBe(200);
    expect(removed).toEqual(["shop"]);
    expect(store.current.clots.map((c) => c.name)).toEqual(["graphite"]);
  });

  it("will not delete a Clot an account still names", async () => {
    await store.save({ sources: { email: [{ account: "tady", clot: "shop", address: "me@tady.ch", password: "ZED_KEY", imap: { host: "i", port: 993 }, smtp: { host: "s", port: 465 }, mailboxes: ["INBOX"] }] } });
    const res = await call("/clots/shop?confirm=shop", { method: "DELETE" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain("the inbox tady");
    expect(removed).toEqual([]);
  });

  it("saves the order the rail dragged the Clots into", async () => {
    await call("/clots/order", { method: "POST", body: JSON.stringify({ order: ["home", "shop", "graphite"] }) });
    expect(store.current.clots.map((c) => c.name)).toEqual(["shop", "graphite"]);
    expect(order.at(-1)).toEqual(["home", "shop", "graphite"]);
  });
});
