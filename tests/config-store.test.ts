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
const file_ = () => file;
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

  it("runs overlapping saves one after the other, each through its handler", async () => {
    const log: string[] = [];
    let releaseFirst!: () => void;
    store.onChange(["maxWorkers"], async (next) => {
      log.push(`start ${next.maxWorkers}`);
      if (next.maxWorkers === 2) await new Promise<void>((resolve) => (releaseFirst = resolve));
      log.push(`end ${next.maxWorkers}`);
    });
    const first = store.save({ maxWorkers: 2 });
    const second = store.save({ maxWorkers: 3 });
    await settle(50);
    // The second waits while the first's handler is still going.
    expect(log).toEqual(["start 2"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(log).toEqual(["start 2", "end 2", "start 3", "end 3"]);
    expect(store.current.maxWorkers).toBe(3);
    expect(JSON.parse(fs.readFileSync(file, "utf8")).maxWorkers).toBe(3);
  });

  it("plans each update against the file as the one before it left it, so two changes made at once both land", async () => {
    const add = (name: string) => store.update((raw) => ({ patch: { clots: [...(raw.clots as unknown[]), { name, repoUrl: `https://github.com/o/${name}.git` }] } }));
    const [a, b] = await Promise.all([add("one"), add("two")]);
    expect(a).toMatchObject({ saved: { ok: true } });
    expect(b).toMatchObject({ saved: { ok: true } });
    expect(JSON.parse(fs.readFileSync(file, "utf8")).clots.map((c: { name: string }) => c.name)).toEqual(["graphite", "shop", "one", "two"]);
  });

  it("undoes an update's key write when its save is refused, before the next update is planned", async () => {
    const seen: (string | undefined)[] = [];
    const refused = store.update((raw) => {
      const undo = store.keyUndo("ZED_KEY");
      store.setKey("ZED_KEY", "first-value");
      return { patch: { maxWorkers: -1 }, undo };
    });
    const next = store.update(() => {
      seen.push(store.keys().find((k) => k.name === "ZED_KEY")?.last4);
      return { patch: { maxWorkers: 2 } };
    });
    expect(await refused).toMatchObject({ saved: { ok: false } });
    expect(await next).toMatchObject({ saved: { ok: true } });
    expect(seen).toEqual(["1234"]);
    expect(fs.readFileSync(envFile, "utf8")).toContain("ZED_KEY=zzzz1234");
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
    expect(store.setKey("CLOTS_UI_SECRET", "x")).toMatchObject({ ok: false, error: expect.stringContaining("used by Clots itself") });
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
    // What the daemon registers: these keys apply live; `home` has no handler, so it waits for a restart.
    store.onChange(["maxWorkers", "rolloverPercent", "maxProposals", "askTimeoutMinutes", "timeZone", "gates", "sweep", "spend", "hold"], () => undefined);
    registerSettingsRoutes(api, { config: store, removeClot: async (n) => void removed.push(n), reorder: (o) => void order.push(o), announce: () => undefined });
    const server = await api.listen(0);
    const port = (server.address() as net.AddressInfo).port;
    call = (p, init = {}) => fetch(`http://127.0.0.1:${port}/api/v1${p}`, { ...init, headers: { "x-clots-ui-secret": "s", "content-type": "application/json" } });
  });
  afterEach(() => api.close());

  it("reads and saves the general settings, with the error beside the field when one is wrong", async () => {
    expect(await (await call("/settings/general")).json()).toMatchObject({ timeZone: "UTC", maxWorkers: 3, askTimeoutMinutes: 10 });
    const ok = await call("/settings/general", { method: "PUT", body: JSON.stringify({ maxWorkers: 2, askTimeoutMinutes: 2 }) });
    expect(await ok.json()).toMatchObject({ maxWorkers: 2, askTimeoutMinutes: 2, applied: ["maxWorkers", "askTimeoutMinutes"] });
    const bad = await call("/settings/general", { method: "PUT", body: JSON.stringify({ rolloverPercent: 300 }) });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { errors: Record<string, string> }).errors.rolloverPercent).toBeTruthy();
    expect(store.current.rolloverPercent).toBe(65);
  });

  it("shows the settings the pages gained with their defaults, and saves them", async () => {
    const got = (await (await call("/settings/general")).json()) as Record<string, unknown>;
    expect(got).toMatchObject({ home: true, hold: { quietSeconds: 60, capSeconds: 120 }, sweep: { enabled: true, everyMinutes: 180 }, spend: { weeklyWarnUsd: 50 } });
    const put = (body: unknown) => call("/settings/general", { method: "PUT", body: JSON.stringify(body) });
    const ok = await put({ hold: { quietSeconds: 30, capSeconds: 90 }, sweep: { enabled: false, everyMinutes: 60 }, spend: { weeklyWarnUsd: 120.5 }, home: false });
    expect(await ok.json()).toMatchObject({ hold: { quietSeconds: 30, capSeconds: 90 }, sweep: { enabled: false, everyMinutes: 60 }, spend: { weeklyWarnUsd: 120.5 }, home: false, needsRestart: ["home"] });
    const file = JSON.parse(fs.readFileSync(file_(), "utf8"));
    expect(file).toMatchObject({ hold: { quietSeconds: 30, capSeconds: 90 }, sweep: { enabled: false, everyMinutes: 60 }, spend: { weeklyWarnUsd: 120.5 }, home: false });
    // No warning is an explicit empty spend, and it reads back as null.
    await put({ spend: { weeklyWarnUsd: null } });
    expect(JSON.parse(fs.readFileSync(file_(), "utf8")).spend).toEqual({});
    expect(((await (await call("/settings/general")).json()) as { spend: unknown }).spend).toEqual({ weeklyWarnUsd: null });
  });

  it("says in plain words what is wrong with one of the new settings, by its path, and saves nothing", async () => {
    const put = async (body: unknown) => {
      const res = await call("/settings/general", { method: "PUT", body: JSON.stringify(body) });
      return { status: res.status, errors: ((await res.json()) as { errors: Record<string, string> }).errors };
    };
    expect(await put({ hold: { quietSeconds: 90, capSeconds: 30 } })).toEqual({ status: 400, errors: { "hold.capSeconds": "The longest wait cannot be shorter than the quiet wait." } });
    expect((await put({ sweep: { enabled: true, everyMinutes: 5 } })).errors["sweep.everyMinutes"]).toBe("That must be at least 15.");
    expect((await put({ spend: { weeklyWarnUsd: 0.5 } })).errors["spend.weeklyWarnUsd"]).toBe("That must be at least 1.");
    expect(store.current.hold).toEqual({ quietMs: 60_000, capMs: 120_000 });
  });

  it("reads and saves the schedule as a row per weekday, with the defaults for what the file leaves out", async () => {
    const got = (await (await call("/settings/schedule")).json()) as { scarce: { day: string; on: boolean; from: string; to: string }[]; leadIn: { day: string; on: boolean }[]; leadInPercent: number; timeZone: string };
    expect(got.timeZone).toBe("UTC");
    expect(got.leadInPercent).toBe(50);
    expect(got.scarce).toHaveLength(7);
    expect(got.scarce[0]).toEqual({ day: "mon", on: true, from: "15:00", to: "18:00" });
    expect(got.scarce[5]).toEqual({ day: "sat", on: false, from: "15:00", to: "18:00" });
    expect(got.leadIn[0]).toMatchObject({ day: "mon", on: true, from: "10:00", to: "15:00" });
    const scarce = got.scarce.map((r) => (r.day === "sat" ? { ...r, on: true, from: "09:00", to: "12:30" } : r.day === "mon" ? { ...r, on: false } : r));
    const res = await call("/settings/schedule", { method: "PUT", body: JSON.stringify({ scarce, leadInPercent: 70 }) });
    expect(res.status).toBe(200);
    const saved = JSON.parse(fs.readFileSync(file_(), "utf8")).gates;
    expect(saved.scarce).toEqual({ tue: "15:00-18:00", wed: "15:00-18:00", thu: "15:00-18:00", fri: "15:00-18:00", sat: "09:00-12:30" });
    expect(saved.leadIn.mon).toBe("10:00-15:00");
    expect(saved.leadInPercent).toBe(70);
    expect(store.current.gates.scarce.sat).toEqual({ start: 540, end: 750 });
    expect(store.current.gates.scarce.mon).toBeUndefined();
  });

  it("refuses a window that ends before it starts, naming the day, and writes nothing", async () => {
    const got = (await (await call("/settings/schedule")).json()) as { scarce: { day: string; from: string; to: string }[] };
    const scarce = got.scarce.map((r) => (r.day === "wed" ? { ...r, from: "18:00", to: "09:00" } : r));
    const res = await call("/settings/schedule", { method: "PUT", body: JSON.stringify({ scarce }) });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { errors: Record<string, string> }).errors).toEqual({ "scarce.wed": "Wednesday: the window must start before it ends." });
    const bad = await call("/settings/schedule", { method: "PUT", body: JSON.stringify({ leadInPercent: 500 }) });
    expect(bad.status).toBe(400);
    expect(JSON.parse(fs.readFileSync(file_(), "utf8")).gates).toBeUndefined();
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
