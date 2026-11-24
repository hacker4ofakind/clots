import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EmailAccount, McpServer } from "../src/config.js";
import { applyChangeLive } from "../src/config-edit.js";
import { ConfigStore } from "../src/config-store.js";
import { EmailSync } from "../src/email-sync.js";
import type { ClotEvent } from "../src/events/types.js";
import { GateTicker } from "../src/gate-ticker.js";
import type { GateConfig } from "../src/gates.js";
import { Hold } from "../src/hold.js";
import { diffClots, diffServers, registerLiveConfig, type LiveTargets } from "../src/live-config.js";
import { LiveEnv } from "../src/live-env.js";
import { McpHub, type McpSession, type Opener } from "../src/mcp/hub.js";
import { Sweeper } from "../src/sweep.js";
import { SpendLog } from "../src/spend.js";
import { Store } from "../src/store.js";
import { MailboxListener, type ImapClient } from "../src/sources/imap.js";

const ENV = "CLAUDE_CODE_OAUTH_TOKEN=c\nCLOT_GITHUB_TOKEN=gh\nGITHUB_WEBHOOK_SECRET=w\nMAIL_PW=first\n";
const base = { timeZone: "UTC", image: "clots-clot:dev", ui: { owner: "me@example.com" }, clots: [{ name: "graphite", repoUrl: "https://github.com/o/r.git" }], home: true };
const inbox = (over: Record<string, unknown> = {}) => ({ account: "main", clot: "graphite", address: "me@gmail.com", password: "MAIL_PW", mailboxes: ["INBOX"], ...over });

let dir: string;
let file: string;
let envFile: string;
let store: ConfigStore;
let calls: Record<string, unknown[][]>;

const targets = (): LiveTargets => {
  const record = (name: string) => (...args: unknown[]) => void (calls[name] = [...(calls[name] ?? []), args]);
  return {
    maxWorkers: record("maxWorkers"),
    rolloverPercent: record("rolloverPercent"),
    timeZone: record("timeZone"),
    gates: record("gates"),
    sweep: record("sweep"),
    spend: record("spend"),
    hold: record("hold"),
    email: async (...args) => void record("email")(...args),
    mcpServers: async (...args) => void record("mcpServers")(...args),
  };
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "clots-live-"));
  file = path.join(dir, "clots.config.json");
  envFile = path.join(dir, ".env");
  fs.writeFileSync(envFile, ENV);
  fs.writeFileSync(file, JSON.stringify(base));
  calls = {};
  store = new ConfigStore({ file, envFile, env: new LiveEnv(envFile, {}) });
  registerLiveConfig(store, targets());
});
afterEach(() => store.close());

describe("every key of the configuration file is either live or reported as waiting for a restart", () => {
  it("applies the keys that are live, each through its own handler, with nothing left for a restart", async () => {
    const live: [string, unknown, string | undefined][] = [
      ["maxWorkers", 2, "maxWorkers"],
      ["rolloverPercent", 70, "rolloverPercent"],
      ["timeZone", "Europe/Zurich", "timeZone"],
      ["gates", { scarce: { mon: "15:00-16:00" }, leadIn: {}, leadInPercent: 40 }, "gates"],
      ["sweep", { enabled: false, everyMinutes: 60 }, "sweep"],
      ["spend", { weeklyWarnUsd: 5 }, "spend"],
      ["hold", { quietSeconds: 5, capSeconds: 10 }, "hold"],
      ["mcpServers", { docs: { url: "https://mcp.example/sse" } }, "mcpServers"],
      ["askTimeoutMinutes", 3, undefined],
      ["maxProposals", 5, undefined],
    ];
    for (const [key, value, target] of live) {
      const result = await store.save({ [key]: value });
      expect(result, key).toEqual({ ok: true, applied: [key], needsRestart: [] });
      if (target !== undefined) expect(calls[target], key).toHaveLength(1);
    }
    expect(calls.maxWorkers![0]).toEqual([2]);
    expect(calls.timeZone![0]).toEqual(["Europe/Zurich"]);
    expect(calls.hold![0]![0]).toEqual({ quietMs: 5000, capMs: 10_000 });
    expect(calls.sweep![0]![0]).toEqual({ enabled: false, everyMinutes: 60 });
    expect(store.current.askTimeoutMinutes).toBe(3);
  });

  it("reports the keys that are read once at startup, saves them, and leaves what runs as it is", async () => {
    for (const [key, value] of [["intake", { port: 9999 }], ["image", "other:tag"], ["ui", { owner: "you@example.com" }], ["rulebookDir", "rules"], ["publicUrl", "https://x.ts.net"]] as const) {
      const result = await store.save({ [key]: value });
      expect(result, key).toEqual({ ok: true, applied: [], needsRestart: [key] });
    }
    expect(Object.keys(calls)).toEqual([]);
  });

  it("applies a mail account change once, with the accounts as they now are, and not for a change elsewhere", async () => {
    await store.save({ sources: { email: [inbox()], composio: [] } });
    expect(calls.email).toHaveLength(1);
    expect((calls.email![0]![0] as EmailAccount[]).map((a) => a.account)).toEqual(["main"]);
    await store.save({ maxWorkers: 4 });
    expect(calls.email).toHaveLength(1);
  });

  it("takes a changed .env value into an account that uses it, so a new password reconnects without a restart", async () => {
    await store.save({ sources: { email: [inbox()], composio: [] } });
    fs.writeFileSync(envFile, ENV.replace("MAIL_PW=first", "MAIL_PW=second"));
    await store.reapply();
    expect(calls.email).toHaveLength(2);
    expect((calls.email![1]![0] as EmailAccount[])[0]!.password).toBe("second");
  });

  it("applies a config change a Clot proposed, once the user said yes, and says whether it waits for a restart", async () => {
    const live = await applyChangeLive(store, {}, "maxWorkers", 2);
    expect(live).toEqual({ ok: true, text: "Saved maxWorkers. It is in force now." });
    expect(calls.maxWorkers).toHaveLength(1);
    const waits = await applyChangeLive(store, {}, "intake", { port: 9001 });
    expect(waits.ok).toBe(true);
    expect(waits.text).toContain("only when it starts");
    expect(waits.text).not.toContain("daemon_restart");
    expect((await applyChangeLive(store, {}, "ui", { owner: "x" })).ok).toBe(false);
  });
});

describe("what changed", () => {
  it("tells which Clots were added, removed, or had their test command or repository changed", () => {
    const a = { name: "a", repoUrl: "https://github.com/o/a.git", testCommand: "npm test" };
    const b = { name: "b", repoUrl: "https://github.com/o/b.git" };
    const c = { name: "c", repoUrl: "https://github.com/o/c.git" };
    expect(diffClots([a, b], [{ ...a, testCommand: "npm run t" }, { ...b, repoUrl: "https://github.com/o/b2.git" }, c])).toEqual({ added: ["c"], removed: [], testCommandChanged: ["a"], repoChanged: ["b"] });
    expect(diffClots([a, b], [a])).toMatchObject({ removed: ["b"] });
  });

  it("tells which MCP servers are new, gone or changed", () => {
    const http = (url: string): McpServer => ({ kind: "http", url, headers: {}, oauth: false });
    expect(diffServers({ a: http("https://a"), b: http("https://b") }, { b: http("https://b2"), c: http("https://c") })).toEqual({ added: ["c"], removed: ["a"], changed: ["b"] });
  });
});

describe("the parts that apply a change", () => {
  const days = ["mon", "tue", "wed", "thu", "fri"] as const;
  const windows = (start: number, end: number) => Object.fromEntries(days.map((d) => [d, { start, end }]));
  const GATES: GateConfig = { scarce: windows(660, 780), leadIn: windows(600, 660), leadInPercent: 50 };

  it("the gate ticker reads new windows at once and wakes what waits when the gate moved", () => {
    // 2026-11-09 is a Monday: 12:00 UTC is inside 09:00-18:00 only for the new windows.
    const noon = Date.UTC(2026, 10, 9, 12, 0, 0);
    const d = { meter: { refresh: async () => undefined, snapshot: () => ({}) }, gates: { scarce: {}, leadIn: {}, leadInPercent: 50 } as GateConfig, timeZone: "UTC", now: () => noon, kickAll: vi.fn(), wakeWorkers: vi.fn(), sweep: async () => undefined };
    const ticker = new GateTicker(d);
    ticker.recheck();
    expect(d.kickAll).toHaveBeenCalledTimes(1);
    ticker.configure({ gates: GATES });
    expect(ticker.gate().holds).not.toBeNull();
    expect(d.kickAll).toHaveBeenCalledTimes(2);
  });

  it("the sweeper reads its on/off and its interval at the next tick", async () => {
    const db = new Store(":memory:");
    let now = 10 * 3_600_000;
    const run = vi.fn(async () => ({ ok: true }) as never);
    const sweeper = new Sweeper({ store: db, now: () => now, enabled: false, everyMinutes: 180, run, clots: () => [], skip: () => [], held: () => false, deliver: async () => undefined, tell: async () => undefined, book: async () => undefined, onLimit: () => undefined });
    await sweeper.tick();
    expect(run).not.toHaveBeenCalled();
    sweeper.configure({ enabled: true, everyMinutes: 15 });
    await sweeper.tick().catch(() => undefined);
    expect(run).toHaveBeenCalledTimes(1);
    now += 10 * 60_000;
    await sweeper.tick().catch(() => undefined);
    expect(run).toHaveBeenCalledTimes(1);
    now += 10 * 60_000;
    await sweeper.tick().catch(() => undefined);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("the hold waits the new time for the groups that start after the change", () => {
    const waits: number[] = [];
    const hold = new Hold({ quietMs: 60_000, capMs: 120_000, now: () => 0, schedule: (ms) => (waits.push(ms), () => undefined), onRelease: () => undefined });
    const event = (id: string): ClotEvent => ({ id, source: "github", kind: "ci_failed", account: "github", place: "p", actor: "a", title: "t", body: "", url: "u", ref: "r", subject: id, automated: true, outsider: false, receivedAt: 0 });
    hold.add("graphite", event("1"));
    hold.configure({ quietMs: 5_000, capMs: 8_000 });
    hold.add("graphite", event("2"));
    expect(waits).toEqual([60_000, 5_000]);
  });

  it("the spend log reads a new weekly warning and zone", async () => {
    const db = new Store(":memory:");
    const posted: string[] = [];
    const log = new SpendLog({ store: db, now: () => Date.UTC(2026, 10, 11, 12), timeZone: "UTC", weeklyWarnUsd: undefined, post: async (_c, text) => void posted.push(text), gate: () => ({ holds: null }) as never, meter: { refresh: async () => undefined, fiveHour: () => undefined, sevenDay: () => undefined } });
    await log.book({ clot: "graphite", who: "main", total: 8 });
    expect(posted).toEqual([]);
    log.configure({ weeklyWarnUsd: 5 });
    await log.book({ clot: "graphite", who: "main", sessionId: "s2", total: 9 });
    expect(posted).toHaveLength(1);
  });
});

describe("mail accounts follow the configuration", () => {
  const account = (name: string, over: Partial<EmailAccount> = {}): EmailAccount => ({ account: name, shared: true, address: `${name}@gmail.com`, addresses: [], password: "pw", imap: { host: "i", port: 993 }, smtp: { host: "s", port: 465 }, mailboxes: ["INBOX", "Sent"], tellAddress: true, ...over });

  it("connects a new account, leaves an unchanged one alone, reconnects a changed one and disconnects a removed one", async () => {
    const started: string[] = [];
    const stopped: string[] = [];
    const sync = new EmailSync({ start: (a, mailbox) => (started.push(`${a.account}/${mailbox}/${a.password}`), { stop: () => void stopped.push(`${a.account}/${mailbox}`) }) });
    expect(await sync.apply([account("one")])).toEqual({ started: ["one"], stopped: [] });
    expect(started).toEqual(["one/INBOX/pw", "one/Sent/pw"]);
    expect(await sync.apply([account("one"), account("two")])).toEqual({ started: ["two"], stopped: [] });
    expect(await sync.apply([account("one", { password: "new" }), account("two")])).toEqual({ started: ["one"], stopped: ["one"] });
    expect(stopped).toEqual(["one/INBOX", "one/Sent"]);
    expect(started.slice(-2)).toEqual(["one/INBOX/new", "one/Sent/new"]);
    expect(await sync.apply([account("one", { password: "new" })])).toEqual({ started: [], stopped: ["two"] });
    expect(sync.connected()).toEqual(["one"]);
  });

  it("a stopped mailbox listener closes its connection and does not open another", async () => {
    let closed!: () => void;
    const client = {
      connect: vi.fn(async () => undefined),
      open: vi.fn(async () => ({ uidValidity: "1", uidNext: 1 })),
      fetchAfter: async function* () {},
      onNewMail: () => undefined,
      closed: () => new Promise<void>((resolve) => (closed = resolve)),
      logout: vi.fn(async () => closed()),
    } as unknown as ImapClient;
    const listener = new MailboxListener({ account: account("one"), mailbox: "INBOX", client: () => client, store: new Store(":memory:"), deliver: () => undefined, now: () => 0 });
    const ran = listener.run(() => undefined);
    await vi.waitFor(() => expect(client.open).toHaveBeenCalled());
    await vi.waitFor(() => expect(closed).toBeTypeOf("function"));
    await listener.stop();
    await ran;
    expect(client.logout).toHaveBeenCalled();
    await listener.run(() => undefined);
    expect(client.connect).toHaveBeenCalledTimes(1);
  });
});

describe("MCP servers follow the configuration", () => {
  it("closes a removed or changed server's session, and connects a new or changed one", async () => {
    const opened: string[] = [];
    const closedSessions: string[] = [];
    const opener: Opener = {
      open: async (name) => {
        opened.push(name);
        return { listTools: async () => [], callTool: async () => ({ text: "", isError: false }), close: async () => void closedSessions.push(name) } satisfies McpSession;
      },
      finishLogin: async () => undefined,
    };
    const hub = new McpHub({ names: ["a", "b"], opener, tell: async () => undefined });
    await hub.start();
    expect(opened).toEqual(["a", "b"]);
    hub.setServers(["b", "c"], ["b"]);
    await vi.waitFor(() => expect(opened).toEqual(["a", "b", "c", "b"]));
    expect(closedSessions.sort()).toEqual(["a", "b"]);
    expect(hub.status("a")).toEqual({ status: "not connected" });
    expect(hub.status("c")).toEqual({ status: "connected" });
  });
});
