import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { classifyComposioError, classifyFailedResult, TimeoutError } from "../src/composio/api.js";
import { Composio } from "../src/composio/component.js";
import { Meter } from "../src/composio/meter.js";
import { LINEAR } from "../src/composio/toolkits/linear.js";
import type { ComposioAccount } from "../src/config.js";
import { Supervisor } from "../src/listeners.js";
import { Store } from "../src/store.js";
import { FakeComposioApi } from "./fake-composio.js";

const LINEAR_KEY = "lin_api_SECRETVALUE";
const NOTION_KEY = "ntn_SECRETVALUE";
const PUBLIC_URL = "https://box.example.ts.net";

const base = { shared: false, audience: "team" as const, triggers: [] };
const linear: ComposioAccount = { ...base, toolkit: "linear", account: "proton", clot: "graphite", apiKey: LINEAR_KEY, apiKeyName: "LINEAR_PROTON_KEY" };
const notion: ComposioAccount = { ...base, toolkit: "notion", account: "main", shared: true, audience: "private", apiKey: NOTION_KEY, apiKeyName: "NOTION_KEY" };
const calendar: ComposioAccount = { ...base, toolkit: "googlecalendar", account: "personal", shared: true, audience: "private", leadMinutes: [1440], pollMinutes: 5 };
const stripe: ComposioAccount = { ...base, toolkit: "stripe", account: "shop", clot: "graphite", apiKey: "rk_test_SECRETVALUE", apiKeyName: "STRIPE_KEY", checkoutCompleted: true };

let api: FakeComposioApi;
let store: Store;
let told: { account: string | "home"; text: string }[];
let logs: string[];
let timers: { ms: number; fn: () => void; cancelled: boolean }[];
let clock: number;
let composio: Composio;

/** Runs the next wait that is due and lets what it started settle. */
async function tick(ms?: number): Promise<number> {
  const timer = timers.splice(ms === undefined ? 0 : timers.findIndex((t) => t.ms === ms), 1)[0];
  if (!timer.cancelled) timer.fn();
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
  return timer.ms;
}

const schedule = (ms: number, fn: () => void) => {
  const timer = { ms, fn, cancelled: false };
  timers.push(timer);
  return () => void (timer.cancelled = true);
};

function make(accounts: ComposioAccount[]) {
  composio = new Composio({
    api,
    store,
    accounts,
    publicUrl: PUBLIC_URL,
    tell: async (a, text) => void told.push({ account: `${a.toolkit}:${a.account}`, text }),
    tellHome: async (text) => void told.push({ account: "home", text }),
    now: () => clock,
    schedule,
    supervisor: new Supervisor({ schedule }),
    log: (text) => void logs.push(text),
  });
}

beforeEach(() => {
  api = new FakeComposioApi();
  store = new Store(":memory:");
  told = [];
  logs = [];
  timers = [];
  clock = Date.UTC(2026, 10, 19, 12, 0, 0);
  api.answers.set(LINEAR.listTeams, { ok: true, data: { teams: [{ id: "team-a" }, { id: "team-b" }] } });
  api.answers.set(LINEAR.whoAmI, { ok: true, data: { data: { id: "member-1" } } });
  api.answers.set("NOTION_WHO_AM_I", { ok: true, data: { data: { id: "bot-1" } } });
});

describe("reconcile", () => {
  it("makes the webhook, then each account's auth config, connection and triggers, in that order", async () => {
    make([linear]);
    const { failures } = await composio.reconcile();
    expect(failures).toEqual([]);
    const order = api.calls.map((c) => c.split(":")[0]);
    expect(order.indexOf("setWebhook")).toBeLessThan(order.indexOf("ensureAuthConfig"));
    expect(order.indexOf("ensureAuthConfig")).toBeLessThan(order.indexOf("connectWithKey"));
    expect(order.indexOf("connectWithKey")).toBeLessThan(order.indexOf("upsertTrigger"));
    expect(api.of("setWebhook")).toEqual([`setWebhook:${PUBLIC_URL}/webhooks/composio`]);
    expect(api.subscription?.secret).toBe(store.getState("composio.webhookSecret"));
    const triggers = [...api.triggers.values()].map((t) => `${t.slug}:${(t.config as any).team_id}`).sort();
    expect(triggers).toEqual(["LINEAR_PRIVATE_TEAM_COMMENT_CREATED:team-a", "LINEAR_PRIVATE_TEAM_COMMENT_CREATED:team-b", "LINEAR_PRIVATE_TEAM_ISSUE_CREATED:team-a", "LINEAR_PRIVATE_TEAM_ISSUE_CREATED:team-b"]);
    expect(api.of("upsertTrigger")[0]).toContain("every 1m");
    expect(composio.identity(linear)).toBe("member-1");
    expect(composio.byConnection(store.composio.account("linear:proton")!.connectionId!)).toBe(linear);
  });

  it("is a no-op the second time", async () => {
    make([linear, notion]);
    await composio.reconcile();
    const before = api.calls.length;
    api.calls = [];
    await composio.reconcile();
    for (const mutating of ["setWebhook", "connectWithKey", "upsertTrigger", "deleteTrigger", "deleteConnection", "rotateWebhookSecret", "linkManaged"]) expect(api.of(mutating)).toEqual([]);
    expect(before).toBeGreaterThan(0);
  });

  it("keeps the webhook secret it was given, and reads it from Composio when its own copy is gone", async () => {
    make([]);
    await composio.reconcile();
    const secret = store.getState("composio.webhookSecret");
    expect(secret).toMatch(/^whsec_/);
    store.deleteState("composio.webhookSecret");
    api.calls = [];
    await composio.reconcile();
    expect(store.getState("composio.webhookSecret")).toBe(secret);
    expect(api.of("setWebhook")).toEqual([]);
    expect(api.of("rotateWebhookSecret")).toEqual([]);
  });

  it("rotates the secret once when Composio has a subscription but will not say its secret", async () => {
    api.subscription = { url: `${PUBLIC_URL}/webhooks/composio` };
    make([]);
    await composio.reconcile();
    expect(api.of("rotateWebhookSecret")).toHaveLength(1);
    expect(store.getState("composio.webhookSecret")).toBe(api.subscription?.secret);
  });

  it("points the subscription at the public address when it points elsewhere", async () => {
    api.subscription = { url: "https://old.example/webhooks/composio", secret: "whsec_old" };
    make([]);
    await composio.reconcile();
    expect(api.of("setWebhook")).toEqual([`setWebhook:${PUBLIC_URL}/webhooks/composio`]);
  });

  it("adopts the connection Composio already holds instead of making another", async () => {
    make([linear]);
    api.connections.set("ca_old", { id: "ca_old", status: "active", user: "linear:proton", toolkit: "linear" });
    await composio.reconcile();
    expect(api.of("connectWithKey")).toEqual([]);
    expect(store.composio.account("linear:proton")?.connectionId).toBe("ca_old");
  });

  it("replaces the connection when the key changes, moving the triggers before deleting the old one, and not when it does not", async () => {
    make([linear]);
    await composio.reconcile();
    const first = store.composio.account("linear:proton")!;
    make([{ ...linear, apiKey: "lin_api_NEWKEY" }]);
    api.calls = [];
    await composio.reconcile();
    const now = store.composio.account("linear:proton")!;
    expect(now.connectionId).not.toBe(first.connectionId);
    expect(now.keyHash).not.toBe(first.keyHash);
    const names = api.calls.map((c) => c.split(":")[0]);
    expect(names.indexOf("connectWithKey")).toBeLessThan(names.indexOf("upsertTrigger"));
    expect(names.indexOf("upsertTrigger")).toBeLessThan(names.indexOf("deleteConnection"));
    expect(api.connections.has(first.connectionId!)).toBe(false);
    expect([...api.triggers.values()].every((t) => t.connectionId === now.connectionId)).toBe(true);
    expect(store.composio.triggers("linear:proton")).toHaveLength(4);
    api.calls = [];
    await composio.reconcile();
    expect(api.of("connectWithKey")).toEqual([]);
  });

  it("does not store the key hash when the rebind failed midway, so the next start redoes it", async () => {
    make([linear]);
    await composio.reconcile();
    const first = store.composio.account("linear:proton")!;
    make([{ ...linear, apiKey: "lin_api_NEWKEY" }]);
    api.failNext.set("upsertTrigger", new Error("down"));
    const { failures } = await composio.reconcile();
    expect(failures).toHaveLength(1);
    expect(store.composio.account("linear:proton")?.keyHash).toBe(first.keyHash);
    const again = await composio.reconcile();
    expect(again.failures).toEqual([]);
    expect(store.composio.account("linear:proton")?.keyHash).not.toBe(first.keyHash);
  });

  it("deletes the triggers of an account that left the configuration, leaving its connection", async () => {
    make([linear, notion]);
    await composio.reconcile();
    const connection = store.composio.account("linear:proton")!.connectionId!;
    make([notion]);
    await composio.reconcile();
    expect(store.composio.triggers("linear:proton")).toEqual([]);
    expect([...api.triggers.values()]).toEqual([]);
    expect(api.connections.has(connection)).toBe(true);
    expect(composio.account("linear:proton")).toBeUndefined();
  });

  it("removes a trigger the account no longer wants, such as a team the member left", async () => {
    make([linear]);
    await composio.reconcile();
    api.answers.set(LINEAR.listTeams, { ok: true, data: { teams: [{ id: "team-a" }] } });
    await composio.reconcile();
    expect([...api.triggers.values()].map((t) => (t.config as any).team_id)).toEqual(["team-a", "team-a"]);
    expect(store.composio.triggers("linear:proton")).toHaveLength(2);
  });

  it("makes Stripe's triggers, with checkout only when asked, and PostHog's with its project and events", async () => {
    make([stripe, { ...base, toolkit: "posthog", account: "app", clot: "graphite", apiKey: "phx_x", region: "us", projectId: 7, events: ["signup"] }]);
    await composio.reconcile();
    const slugs = [...api.triggers.values()].map((t) => t.slug);
    expect(slugs).toContain("STRIPE_CHECKOUT_SESSION_COMPLETED");
    expect(slugs.filter((s) => s.startsWith("STRIPE_"))).toHaveLength(7);
    expect([...api.triggers.values()].find((t) => t.slug === "POSTHOG_EVENT_CAPTURED")?.config).toEqual({ project_id: 7, event_names: ["signup"] });
    expect(api.of("connectWithKey").some((c) => c.includes('"subdomain":"us"'))).toBe(true);
  });

  it("makes the configured triggers of any other toolkit", async () => {
    make([{ ...base, toolkit: "slack", account: "work", shared: true, apiKey: "xoxb", triggers: [{ slug: "SLACK_RECEIVE_MESSAGE", config: { channel: "C1" } }] }]);
    await composio.reconcile();
    expect([...api.triggers.values()].map((t) => [t.slug, t.config])).toEqual([["SLACK_RECEIVE_MESSAGE", { channel: "C1" }]]);
  });

  it("lets one account fail without stopping the others, and Supervisor retries it", async () => {
    make([linear, notion]);
    api.failNext.set("connectWithKey", new Error("Composio is down"));
    const { failures } = await composio.reconcile();
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("linear:proton");
    expect(store.composio.account("notion:main")?.connectionId).toBeDefined();
    expect(logs.some((l) => l.includes("linear:proton") && l.includes("Composio is down"))).toBe(true);
  });

  it("does not hold the identity back from the triggers: an unreadable identity is retried with a growing wait", async () => {
    make([linear]);
    api.answers.set(LINEAR.whoAmI, { ok: false, error: "no", reason: "refused" });
    await composio.reconcile();
    expect(composio.identity(linear)).toBe("");
    expect(store.composio.triggers("linear:proton")).toHaveLength(4);
    api.answers.set(LINEAR.whoAmI, { ok: true, data: { data: { id: "member-1" } } });
    const waits: number[] = [];
    const retry = timers.find((t) => t.ms === 30_000);
    expect(retry).toBeDefined();
    waits.push(await tick());
    expect(composio.identity(linear)).toBe("member-1");
  });
});

describe("start", () => {
  it("runs the webhook and each account as jobs of their own, so nothing waits for Composio", async () => {
    make([linear, notion]);
    composio.start();
    for (let i = 0; i < 40; i++) await new Promise((resolve) => setImmediate(resolve));
    expect(store.getState("composio.webhookSecret")).toBeDefined();
    expect(store.composio.account("linear:proton")?.connectionId).toBeDefined();
    expect(store.composio.account("notion:main")?.connectionId).toBeDefined();
  });

  it("retries a failing account while the others carry on", async () => {
    make([linear, notion]);
    api.failNext.set("connectWithKey", new Error("down"));
    composio.start();
    for (let i = 0; i < 40; i++) await new Promise((resolve) => setImmediate(resolve));
    expect(store.composio.account("notion:main")?.connectionId).toBeDefined();
    expect(store.composio.account("linear:proton")?.connectionId).toBeUndefined();
    expect(timers.find((t) => t.ms === 30_000)).toBeDefined();
    await tick(30_000);
    expect(store.composio.account("linear:proton")?.connectionId).toBeDefined();
  });
});

describe("the calendar's sign-in", () => {
  it("posts one sign-in link, then sees the connection become active by polling", async () => {
    make([calendar]);
    await composio.reconcile();
    const links = told.filter((t) => t.text.startsWith("Sign in to Google Calendar for the Clots: https://"));
    expect(links).toHaveLength(1);
    expect(links[0].account).toBe("googlecalendar:personal");
    const id = store.composio.account("googlecalendar:personal")!.connectionId!;
    expect(api.of("linkManaged")).toHaveLength(1);
    // Not yet signed in: the next poll, 30 seconds on, finds it inactive and waits again.
    const first = timers.find((t) => t.ms === 30_000)!;
    expect(first).toBeDefined();
    await tick();
    expect(store.composio.account("googlecalendar:personal")?.status).not.toBe("active");
    api.connections.get(id)!.status = "active";
    await tick();
    expect(store.composio.account("googlecalendar:personal")?.status).toBe("active");
    expect(logs.some((l) => l.includes("Google Calendar") && l.includes("connected"))).toBe(true);
    expect(told.filter((t) => t.text.startsWith("Sign in"))).toHaveLength(1);
  });

  it("stops polling after 15 minutes", async () => {
    make([calendar]);
    await composio.reconcile();
    for (let i = 0; i < 40 && timers.length > 0; i++) {
      clock += 30_000;
      await tick();
    }
    expect(timers).toEqual([]);
  });

  it("does not link again on a later reconcile while the connection is still waiting", async () => {
    make([calendar]);
    await composio.reconcile();
    await composio.reconcile();
    expect(api.of("linkManaged")).toHaveLength(1);
    expect(told.filter((t) => t.text.startsWith("Sign in"))).toHaveLength(1);
  });
});

describe("the daily check", () => {
  it("recreates a disabled trigger, and one Composio has lost", async () => {
    make([linear]);
    await composio.reconcile();
    const rows = store.composio.triggers("linear:proton");
    api.disabled.add(rows[0].triggerId);
    api.triggers.delete(rows[1].triggerId);
    api.calls = [];
    await composio.checkDaily();
    expect(api.of("upsertTrigger")).toHaveLength(2);
    const after = store.composio.triggers("linear:proton");
    expect(after).toHaveLength(4);
    expect(after.map((r) => r.triggerId)).not.toContain(rows[1].triggerId);
    expect(told).toEqual([]);
  });

  it("tells once when it cannot recreate a trigger", async () => {
    make([linear]);
    await composio.reconcile();
    const rows = store.composio.triggers("linear:proton");
    api.triggers.delete(rows[0].triggerId);
    api.failNext.set("upsertTrigger", new Error("Linear says no"));
    await composio.checkDaily();
    api.triggers.delete(rows[0].triggerId);
    api.failNext.set("upsertTrigger", new Error("Linear says no"));
    await composio.checkDaily();
    const messages = told.filter((t) => t.account === "linear:proton");
    expect(messages).toHaveLength(1);
    expect(messages[0].text).toContain("Linear says no");
  });

  it("tells once about an expired key connection, naming the .env key to replace", async () => {
    make([linear]);
    await composio.reconcile();
    api.connections.get(store.composio.account("linear:proton")!.connectionId!)!.status = "expired";
    await composio.checkDaily();
    await composio.checkDaily();
    const messages = told.filter((t) => t.account === "linear:proton");
    expect(messages).toHaveLength(1);
    expect(messages[0].text).toContain("LINEAR_PROTON_KEY");
    expect(messages[0].text).toContain("restart");
    expect(api.of("upsertTrigger")).toHaveLength(4);
  });

  it("posts a new sign-in link for an expired calendar, once a day while it is not active", async () => {
    make([calendar]);
    await composio.reconcile();
    const id = store.composio.account("googlecalendar:personal")!.connectionId!;
    api.connections.get(id)!.status = "expired";
    await composio.checkDaily();
    expect(told.filter((t) => t.text.startsWith("Sign in"))).toHaveLength(2);
    expect(api.of("linkManaged")).toHaveLength(2);
  });

  it("adds a trigger for a team the member joined since", async () => {
    make([linear]);
    await composio.reconcile();
    api.answers.set(LINEAR.listTeams, { ok: true, data: { teams: [{ id: "team-a" }, { id: "team-b" }, { id: "team-c" }] } });
    await composio.checkDaily();
    expect(store.composio.triggers("linear:proton")).toHaveLength(6);
  });
});

describe("lifecycle deliveries", () => {
  it("does nothing for a trigger disabled because the connection expired, and recreates it for any other reason", async () => {
    make([linear]);
    await composio.reconcile();
    const row = store.composio.triggers("linear:proton")[0];
    api.calls = [];
    await composio.triggerDisabled(row.triggerId, "connection_expired");
    await composio.triggerDisabled(row.triggerId, "Connected account authentication expired.");
    expect(api.of("upsertTrigger")).toEqual([]);
    api.triggers.delete(row.triggerId);
    await composio.triggerDisabled(row.triggerId, "other");
    expect(api.of("upsertTrigger")).toHaveLength(1);
    expect(store.composio.triggers("linear:proton")).toHaveLength(4);
  });

  it("tells once when an expired connection is reported", async () => {
    make([notion]);
    await composio.reconcile();
    const id = store.composio.account("notion:main")!.connectionId!;
    await composio.connectionExpired(id);
    await composio.connectionExpired(id);
    expect(told.filter((t) => t.account === "notion:main")).toHaveLength(1);
  });
});

describe("run", () => {
  it("runs the tool as the account's own Composio user", async () => {
    make([linear]);
    await composio.run(linear, "LINEAR_GET_LINEAR_ISSUE", { issue_id: "x" });
    expect(api.of("execute")).toEqual(['execute:linear:proton LINEAR_GET_LINEAR_ISSUE {"issue_id":"x"}']);
  });

  it("counts each call against the month's allowance, a calendar's as a managed one", async () => {
    const meter = new Meter({ store, now: () => clock, tellHome: async () => {} });
    composio = new Composio({ api, store, accounts: [linear, calendar], publicUrl: PUBLIC_URL, tell: async () => {}, tellHome: async () => {}, now: () => clock, schedule, supervisor: new Supervisor({ schedule }), meter });
    await composio.run(linear, "LINEAR_GET_LINEAR_ISSUE", {});
    await composio.run(calendar, "GOOGLECALENDAR_EVENTS_LIST", {});
    expect(meter.usage().calls).toEqual({ own: 1, managed: 1 });
  });

  it("says once a month that the limit is reached, in the home channel, and not again", async () => {
    make([linear]);
    api.answers.set("LINEAR_X", { ok: false, error: "quota", reason: "cap" });
    await composio.run(linear, "LINEAR_X", {});
    await composio.run(linear, "LINEAR_X", {});
    const notices = told.filter((t) => t.account === "home");
    expect(notices).toHaveLength(1);
    expect(notices[0].text).toContain("free monthly limit");
    expect(notices[0].text).toContain("2026-12-01");
    clock = Date.UTC(2026, 11, 3);
    await composio.run(linear, "LINEAR_X", {});
    expect(told.filter((t) => t.account === "home")).toHaveLength(2);
  });

  it("tells once per start when a connection stops being accepted", async () => {
    make([linear]);
    api.answers.set("LINEAR_X", { ok: false, error: "401", reason: "auth" });
    await composio.run(linear, "LINEAR_X", {});
    await composio.run(linear, "LINEAR_X", {});
    expect(told.filter((t) => t.account === "linear:proton")).toHaveLength(1);
  });

  it("finds an account by its toolkit:account name, and its connection from a delivery's ID", async () => {
    make([linear, notion]);
    expect(composio.account("linear:proton")).toBe(linear);
    expect(composio.account("main", "notion")).toBe(notion);
    expect(composio.account("proton")).toBe(linear);
    expect(composio.account("nobody")).toBeUndefined();
    expect(composio.userOf(linear)).toBe("linear:proton");
  });

  it("caches a tool's description for the daemon's life, and finds tools by query", async () => {
    make([linear]);
    api.tools.set("LINEAR_ARCHIVE_ISSUE", { slug: "LINEAR_ARCHIVE_ISSUE", toolkit: "linear", name: "Archive issue", description: "Archives an issue.", inputSchema: {}, tags: ["updateHint"] });
    expect((await composio.tool("LINEAR_ARCHIVE_ISSUE"))?.name).toBe("Archive issue");
    await composio.tool("LINEAR_ARCHIVE_ISSUE");
    expect(api.of("tool")).toHaveLength(1);
    expect((await composio.find(linear, "archive")).map((t) => t.slug)).toEqual(["LINEAR_ARCHIVE_ISSUE"]);
  });
});

describe("response checks", () => {
  const goodIssue = { issue: { id: "i-1", creator: { name: "Ann" } } };

  it("passes an answer of the shape the call relies on through unchanged", async () => {
    make([linear]);
    api.answers.set(LINEAR.getIssue, { ok: true, data: goodIssue });
    expect(await composio.runChecked(linear, LINEAR.getIssue, { issue_id: "x" })).toEqual({ ok: true, data: goodIssue });
    await composio.checkDaily();
    expect(told).toEqual([]);
  });

  it("fails closed, as a refused result, when the answer has another shape, and says where", async () => {
    make([linear]);
    api.answers.set(LINEAR.getIssue, { ok: true, data: { data: { issue: { id: "i-1" } } } });
    const result = await composio.runChecked(linear, LINEAR.getIssue, { issue_id: "x" });
    expect(result).toMatchObject({ ok: false, reason: "refused", drift: true });
    expect(result.ok === false && result.error).toContain("LINEAR_GET_LINEAR_ISSUE answered in an unexpected shape at issue");
    expect(logs.some((l) => l.includes("answered in an unexpected shape"))).toBe(true);
  });

  it("leaves a failure as it was, and a tool with no check unchecked", async () => {
    make([linear]);
    api.answers.set(LINEAR.getIssue, { ok: false, error: "down", reason: "unreachable" });
    expect(await composio.runChecked(linear, LINEAR.getIssue, {})).toEqual({ ok: false, error: "down", reason: "unreachable" });
    api.answers.set("LINEAR_SOMETHING_ELSE", { ok: true, data: "anything" });
    expect(await composio.runChecked(linear, "LINEAR_SOMETHING_ELSE", {})).toEqual({ ok: true, data: "anything" });
  });

  it("takes the caller's own check over the toolkit's", async () => {
    make([linear]);
    api.answers.set(LINEAR.getIssue, { ok: true, data: { odd: true } });
    expect((await composio.runChecked(linear, LINEAR.getIssue, {}, z.object({ odd: z.boolean() }))).ok).toBe(true);
    expect((await composio.runChecked(linear, LINEAR.getIssue, {}, z.object({ odd: z.string() }))).ok).toBe(false);
  });

  it("makes a changed identity answer an unreadable identity, retried, not a crash", async () => {
    make([linear]);
    api.answers.set(LINEAR.whoAmI, { ok: true, data: { id: "member-1" } });
    const { failures } = await composio.reconcile();
    expect(failures).toEqual([]);
    expect(composio.identity(linear)).toBe("");
    expect(logs.some((l) => l.includes("LINEAR_WHO_AM_I answered in an unexpected shape"))).toBe(true);
  });

  it("is reported by the daily check once per tool and account per start, in the account's channel, naming the tool", async () => {
    make([linear, notion]);
    api.answers.set(LINEAR.getIssue, { ok: true, data: {} });
    api.answers.set("NOTION_RETRIEVE_PAGE", { ok: true, data: {} });
    await composio.runChecked(linear, LINEAR.getIssue, {});
    await composio.runChecked(linear, LINEAR.getIssue, {});
    await composio.runChecked(notion, "NOTION_RETRIEVE_PAGE", {});
    expect(told).toEqual([]);
    await composio.checkDaily();
    await composio.checkDaily();
    const drift = told.filter((t) => t.text.includes("unexpected shape"));
    expect(drift.map((t) => t.account)).toEqual(["linear:proton", "notion:main"]);
    expect(drift[0].text).toContain("LINEAR_GET_LINEAR_ISSUE");
    expect(drift[1].text).toContain("NOTION_RETRIEVE_PAGE");
  });
});

describe("keys", () => {
  it("never puts a service key in anything it tells or logs", async () => {
    make([linear, notion, stripe]);
    api.failNext.set("connectWithKey", new Error("Composio is down"));
    await composio.reconcile();
    api.connections.forEach((c) => (c.status = "expired"));
    await composio.checkDaily();
    api.answers.set("LINEAR_X", { ok: false, error: "401", reason: "auth" });
    await composio.run(linear, "LINEAR_X", {});
    const everything = JSON.stringify([told, logs]);
    for (const key of [LINEAR_KEY, NOTION_KEY, "rk_test_SECRETVALUE"]) expect(everything).not.toContain(key);
  });
});

describe("classifyComposioError", () => {
  const e = (message: string, status?: number) => Object.assign(new Error(message), status === undefined ? {} : { status });
  it("reads the errors Composio gave while probing", () => {
    expect(classifyComposioError(e('401 {"error":{"message":"Invalid API key: ck_**x","slug":"APIKey_InvalidAPIKey","status":401}}', 401))).toBe("auth");
    expect(classifyComposioError(e("400 No active connection found for toolkit(s) 'linear' in this session. ToolRouterV2_NoActiveConnection", 400))).toBe("auth");
    expect(classifyComposioError(e("429 Too Many Requests", 429))).toBe("cap");
    expect(classifyComposioError(e("Monthly usage limit exceeded for this project"))).toBe("cap");
    expect(classifyComposioError(e("fetch failed"))).toBe("unreachable");
    expect(classifyComposioError(e("502 Bad Gateway", 502))).toBe("unreachable");
    expect(classifyComposioError(new TimeoutError("running X"))).toBe("unreachable");
    expect(classifyComposioError(e('400 TriggerInstance_BadRequest: Auth config does not contain an OAuth client_id', 400))).toBe("refused");
  });

  it("reads a tool that answered failed by the service's own status", () => {
    expect(classifyFailedResult(401, "Personal API key found in request Authorization header is invalid.")).toBe("auth");
    expect(classifyFailedResult(410, "Google returned 410 Gone")).toBe("refused");
    expect(classifyFailedResult(503, "")).toBe("unreachable");
    expect(classifyFailedResult(undefined, "quota exceeded")).toBe("cap");
  });
});
