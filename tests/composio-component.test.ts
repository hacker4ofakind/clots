import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { classifyComposioError, classifyFailedResult, TimeoutError } from "../src/composio/api.js";
import { keyHash } from "../src/composio/auth.js";
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

const base = { shared: false, audience: "team" as const, triggers: [], selfIsUser: false };
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

  it("reuses the connection a failed swap already made when it is retried, and leaves no stranded one", async () => {
    make([linear]);
    await composio.reconcile();
    const first = store.composio.account("linear:proton")!;
    make([{ ...linear, apiKey: "lin_api_NEWKEY" }]);
    api.failNext.set("upsertTrigger", new Error("down"));
    await composio.reconcile();
    expect(api.of("connectWithKey")).toHaveLength(2);
    api.calls = [];
    expect((await composio.reconcile()).failures).toEqual([]);
    expect(api.of("connectWithKey")).toEqual([]);
    expect([...api.connections.values()].map((c) => c.id)).toEqual([store.composio.account("linear:proton")!.connectionId]);
    expect(api.connections.has(first.connectionId!)).toBe(false);
    expect(store.getState("composio.staged.linear:proton")).toBeUndefined();
  });

  it("deletes a connection staged for a key that has since changed again, rather than stranding it", async () => {
    make([linear]);
    await composio.reconcile();
    make([{ ...linear, apiKey: "lin_api_SECOND" }]);
    api.failNext.set("upsertTrigger", new Error("down"));
    await composio.reconcile();
    const staged = store.getState("composio.staged.linear:proton")!.split("|")[1];
    make([{ ...linear, apiKey: "lin_api_THIRD" }]);
    expect((await composio.reconcile()).failures).toEqual([]);
    expect(api.connections.has(staged)).toBe(false);
    expect(api.connections.size).toBe(1);
  });

  it("keeps the staged marker and makes no new connection when the staged one cannot be read just now", async () => {
    make([linear]);
    await composio.reconcile();
    make([{ ...linear, apiKey: "lin_api_NEWKEY" }]);
    api.failNext.set("upsertTrigger", new Error("down"));
    await composio.reconcile();
    const marker = store.getState("composio.staged.linear:proton");
    expect(marker).toBeDefined();
    api.calls = [];
    api.failNext.set("connection", new Error("timed out"));
    const { failures } = await composio.reconcile();
    expect(failures).toHaveLength(1);
    expect(store.getState("composio.staged.linear:proton")).toBe(marker);
    expect(api.of("connectWithKey")).toEqual([]);
    expect(api.of("deleteConnection")).toEqual([]);
    expect((await composio.reconcile()).failures).toEqual([]);
    expect(api.of("connectWithKey")).toEqual([]);
  });

  it("makes a new connection when the staged one is confirmed gone, and keeps the marker when it cannot be deleted", async () => {
    make([linear]);
    await composio.reconcile();
    make([{ ...linear, apiKey: "lin_api_NEWKEY" }]);
    api.failNext.set("upsertTrigger", new Error("down"));
    await composio.reconcile();
    const [, staged] = store.getState("composio.staged.linear:proton")!.split("|");
    api.connections.get(staged)!.status = "failed";
    const marker = store.getState("composio.staged.linear:proton");
    api.failNext.set("deleteConnection", new Error("timed out"));
    expect((await composio.reconcile()).failures).toHaveLength(1);
    expect(store.getState("composio.staged.linear:proton")).toBe(marker);
    expect(api.connections.has(staged)).toBe(true);
    expect((await composio.reconcile()).failures).toEqual([]);
    expect(api.connections.has(staged)).toBe(false);
    expect(api.connections.size).toBe(1);
  });

  it("never deletes the account's own connection because a marker names it, and clears that marker", async () => {
    make([linear]);
    await composio.reconcile();
    const current = store.composio.account("linear:proton")!.connectionId!;
    store.setState("composio.staged.linear:proton", `oldhash|${current}`);
    await composio.reconcile();
    expect(store.getState("composio.staged.linear:proton")).toBeUndefined();
    expect(api.connections.has(current)).toBe(true);
    // And on a later key change the marker does not make the swap delete the connection before the new one is ready.
    store.setState("composio.staged.linear:proton", `oldhash|${current}`);
    make([{ ...linear, apiKey: "lin_api_NEWKEY" }]);
    api.calls = [];
    expect((await composio.reconcile()).failures).toEqual([]);
    const names = api.calls.map((c) => c.split(":")[0]);
    expect(names.indexOf("connectWithKey")).toBeLessThan(names.indexOf("deleteConnection"));
    expect(store.composio.triggers("linear:proton")).toHaveLength(4);
  });

  it("goes back to the established connection when the key is put back after a failed swap, deleting the staged one and restoring the triggers", async () => {
    make([linear]);
    await composio.reconcile();
    const established = store.composio.account("linear:proton")!.connectionId!;
    make([{ ...linear, apiKey: "lin_api_NEWKEY" }]);
    // The swap fails at its last step: the triggers already moved to the staged connection.
    api.failNext.set("deleteConnection", new Error("down"));
    await composio.reconcile();
    const [, staged] = store.getState("composio.staged.linear:proton")!.split("|");
    expect([...api.triggers.values()].every((t) => t.connectionId === staged)).toBe(true);

    make([linear]);
    api.calls = [];
    expect((await composio.reconcile()).failures).toEqual([]);
    expect(api.connections.has(staged)).toBe(false);
    expect(api.connections.has(established)).toBe(true);
    expect(store.getState("composio.staged.linear:proton")).toBeUndefined();
    expect(store.composio.account("linear:proton")?.connectionId).toBe(established);
    expect([...api.triggers.values()].map((t) => t.connectionId)).toEqual([established, established, established, established]);
    expect(store.composio.triggers("linear:proton")).toHaveLength(4);
    expect(store.composio.triggers("linear:proton").every((t) => api.triggers.has(t.triggerId))).toBe(true);
    const names = api.calls.map((c) => c.split(":")[0]);
    expect(names.indexOf("findConnection")).toBeGreaterThan(names.indexOf("deleteConnection"));
  });

  it("keeps trying to delete the abandoned staged connection when the key is put back and the delete fails", async () => {
    make([linear]);
    await composio.reconcile();
    make([{ ...linear, apiKey: "lin_api_NEWKEY" }]);
    api.failNext.set("deleteConnection", new Error("down"));
    await composio.reconcile();
    make([linear]);
    api.failNext.set("deleteConnection", new Error("still down"));
    expect((await composio.reconcile()).failures).toHaveLength(1);
    expect(store.getState("composio.staged.linear:proton")).toBeDefined();
    expect((await composio.reconcile()).failures).toEqual([]);
    expect(store.getState("composio.staged.linear:proton")).toBeUndefined();
  });

  it("finishes a swap whose old connection was already deleted before the crash", async () => {
    make([linear]);
    await composio.reconcile();
    const first = store.composio.account("linear:proton")!.connectionId!;
    make([{ ...linear, apiKey: "lin_api_NEWKEY" }]);
    api.failNext.set("upsertTrigger", new Error("down"));
    await composio.reconcile();
    api.connections.delete(first);
    expect((await composio.reconcile()).failures).toEqual([]);
    expect(store.composio.account("linear:proton")?.keyHash).not.toBeUndefined();
    expect(api.connections.has(store.composio.account("linear:proton")!.connectionId!)).toBe(true);
  });

  it("deletes a staged connection when its account leaves the configuration, keeping the established one, and retries when it cannot", async () => {
    make([linear, notion]);
    await composio.reconcile();
    const established = store.composio.account("linear:proton")!.connectionId!;
    make([{ ...linear, apiKey: "lin_api_NEWKEY" }, notion]);
    api.failNext.set("upsertTrigger", new Error("down"));
    await composio.reconcile();
    const [, staged] = store.getState("composio.staged.linear:proton")!.split("|");
    make([notion]);
    api.failNext.set("deleteConnection", new Error("timed out"));
    await composio.reconcileRemoved();
    expect(store.composio.account("linear:proton")).toBeDefined();
    expect(store.getState("composio.staged.linear:proton")).toBeDefined();
    await composio.reconcileRemoved();
    expect(store.composio.account("linear:proton")).toBeUndefined();
    expect(store.getState("composio.staged.linear:proton")).toBeUndefined();
    expect(api.connections.has(staged)).toBe(false);
    expect(api.connections.has(established)).toBe(true);
  });

  it("keeps the triggers and row of an account whose entry was left out as unusable, until the entry is taken out on purpose", async () => {
    make([linear, notion]);
    await composio.reconcile();
    make([notion]);
    (composio as unknown as { d: { skipped: string[] } }).d.skipped = ["linear:proton"];
    await composio.reconcileRemoved();
    expect(store.composio.account("linear:proton")).toBeDefined();
    expect(store.composio.triggers("linear:proton").length).toBeGreaterThan(0);
    (composio as unknown as { d: { skipped: string[] } }).d.skipped = [];
    await composio.reconcileRemoved();
    expect(store.composio.account("linear:proton")).toBeUndefined();
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

  it("makes Stripe's triggers, with checkout only when asked", async () => {
    make([stripe]);
    await composio.reconcile();
    const slugs = [...api.triggers.values()].map((t) => t.slug);
    expect(slugs).toContain("STRIPE_CHECKOUT_SESSION_COMPLETED");
    expect(slugs.filter((s) => s.startsWith("STRIPE_"))).toHaveLength(7);
  });

  describe("a generic entry's connect", () => {
    const posthog = { ...base, toolkit: "posthog", account: "app", clot: "graphite", apiKey: "phx_x", apiKeyName: "PH_KEY", connect: { subdomain: "eu" }, triggers: [{ slug: "POSTHOG_EVENT_CAPTURED", config: { project_id: 7, event_names: ["signup"] } }] };

    it("connects with the .env fields and the entry's connect, and makes the entry's trigger", async () => {
      make([posthog]);
      await composio.reconcile();
      expect(api.of("connectWithKey").some((c) => c.includes('"subdomain":"eu"') && c.includes("generic_api_key"))).toBe(true);
      expect([...api.triggers.values()].find((t) => t.slug === "POSTHOG_EVENT_CAPTURED")?.config).toEqual({ project_id: 7, event_names: ["signup"] });
    });

    it("keeps the connection when only connect changes, since it is not in the connection's hash, and replaces it with a reconnect", async () => {
      make([posthog]);
      await composio.reconcile();
      const first = store.composio.account("posthog:app")!.connectionId!;
      api.calls.length = 0;
      make([{ ...posthog, connect: { subdomain: "us" } }]);
      await composio.reconcile();
      expect(api.of("connectWithKey")).toEqual([]);
      expect(store.composio.account("posthog:app")!.connectionId).toBe(first);
      expect(await composio.reconnect("posthog:app")).toBe("Reconnecting posthog:app.");
      for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
      expect(api.of("connectWithKey").some((c) => c.includes('"subdomain":"us"'))).toBe(true);
      expect(store.composio.account("posthog:app")!.connectionId).not.toBe(first);
    });

    it("adopts the connection an old-shape entry made, with its 2e hash, and its trigger instance", async () => {
      make([posthog]);
      await composio.reconcile();
      const row = store.composio.account("posthog:app")!;
      expect(row.keyHash).toBe(keyHash("phx_x"));
      const trigger = [...api.triggers.keys()][0];
      api.calls.length = 0;
      make([posthog]);
      await composio.reconcile();
      expect(api.of("connectWithKey")).toEqual([]);
      expect(api.of("upsertTrigger")).toEqual([]);
      expect([...api.triggers.keys()][0]).toBe(trigger);
    });

    it("tells a name the scheme lacks and does not connect", async () => {
      make([{ ...posthog, connect: { subdomian: "eu" } }]);
      await composio.reconcile();
      expect(api.of("connectWithKey")).toEqual([]);
      expect(told.map((t) => t.text).join(String.fromCharCode(10))).toContain("API_KEY has no field subdomian");
    });
  });

  it("makes the configured triggers of any other toolkit", async () => {
    make([{ ...base, toolkit: "supabase", account: "work", shared: true, fieldKeys: { full: "SB_URL", bearer_token: "SB_KEY" }, fields: { full: "https://x.supabase.co", bearer_token: "sb-secret" }, triggers: [{ slug: "SUPABASE_ROW_ADDED", config: { table: "users" } }] }]);
    await composio.reconcile();
    expect([...api.triggers.values()].map((t) => [t.slug, t.config])).toEqual([["SUPABASE_ROW_ADDED", { table: "users" }]]);
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
    const drift = told.filter((t) => t.text.includes("does not recognise"));
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
    expect(classifyComposioError(e("Monthly usage limit exceeded for this project"))).toBe("cap");
    expect(classifyComposioError(e("429 quota exceeded for the plan", 429))).toBe("cap");
    expect(classifyComposioError(e("fetch failed"))).toBe("unreachable");
    expect(classifyComposioError(e("502 Bad Gateway", 502))).toBe("unreachable");
    expect(classifyComposioError(new TimeoutError("running X"))).toBe("unreachable");
    expect(classifyComposioError(e('400 TriggerInstance_BadRequest: Auth config does not contain an OAuth client_id', 400))).toBe("refused");
  });

  it("does not read Composio's own per-minute rate limit as the monthly cap", () => {
    expect(classifyComposioError(e("429 Too Many Requests", 429))).toBe("unreachable");
    expect(classifyComposioError(e("Rate limit exceeded, retry in 30 seconds", 429))).toBe("unreachable");
  });

  it("reads a tool that answered failed by the service's own status, and never as Composio's monthly cap", () => {
    expect(classifyFailedResult(401, "Personal API key found in request Authorization header is invalid.")).toBe("auth");
    expect(classifyFailedResult(410, "Google returned 410 Gone")).toBe("refused");
    expect(classifyFailedResult(503, "")).toBe("unreachable");
    // The service's own limits: Reddit answering 429, or saying quota, is the service rate-limiting, not Composio's cap.
    expect(classifyFailedResult(429, "Reddit API error for subreddit 'Esperanto': HTTP 429")).toBe("unreachable");
    expect(classifyFailedResult(undefined, "quota exceeded")).toBe("unreachable");
    expect(classifyFailedResult(undefined, "rate limit")).toBe("unreachable");
    // The service refusing one request says nothing about the connection.
    expect(classifyFailedResult(403, "Forbidden: private subreddit")).toBe("refused");
  });
});

describe("any toolkit's auth", () => {
  const slack: ComposioAccount = { ...base, toolkit: "slack", account: "work", shared: true, triggers: [{ slug: "SLACK_CHANNEL_MESSAGE_RECEIVED", config: {} }] };
  const supabase: ComposioAccount = { ...base, toolkit: "supabase", account: "shop", clot: "graphite", fieldKeys: { full: "SB_URL", bearer_token: "SB_KEY" }, fields: { full: "https://x.supabase.co", bearer_token: "sb-secret-1" } };
  const reddit: ComposioAccount = { ...base, toolkit: "reddit", account: "me", shared: true };

  it("posts the managed sign-in once, naming the toolkit, with the line about the Clots' own account", async () => {
    make([slack]);
    await composio.reconcile();
    await composio.reconcile();
    const links = told.filter((t) => t.text.startsWith("Sign in to Slack for the Clots: https://"));
    expect(links).toHaveLength(1);
    expect(links[0].text).toContain(`Sign in with the Clots' own Slack account, not yours, unless the entry has "selfIsUser": true.`);
    expect(api.of("ensureAuthConfig")).toEqual(["ensureAuthConfig:slack/MANAGED"]);
  });

  it("leaves out the own-account line for selfIsUser, and for the calendar, which is the user's own by design", async () => {
    make([{ ...slack, selfIsUser: true }, calendar]);
    await composio.reconcile();
    expect(told.find((t) => t.text.startsWith("Sign in to Slack"))!.text).not.toContain("own Slack account");
    expect(told.find((t) => t.text.startsWith("Sign in to Google Calendar"))!.text).not.toContain("own Google Calendar account");
  });

  it("brings the account up at once when the sign-in completes: identity and triggers, not at the next daily check", async () => {
    api.answers.set("SLACK_AUTH_TEST", { ok: true, data: { user_id: "U1" } });
    make([slack]);
    await composio.reconcile();
    expect(api.triggers.size).toBe(0);
    api.connections.get(store.composio.account("slack:work")!.connectionId!)!.status = "active";
    await tick();
    expect(logs.some((l) => l.includes("Slack (work) connected"))).toBe(true);
    expect([...api.triggers.values()].map((t) => t.slug)).toEqual(["SLACK_CHANNEL_MESSAGE_RECEIVED"]);
    expect(store.composio.account("slack:work")?.status).toBe("active");
  });

  it("never reads a selfIsUser account's identity", async () => {
    make([{ ...slack, selfIsUser: true }]);
    await composio.reconcile();
    api.connections.get(store.composio.account("slack:work")!.connectionId!)!.status = "active";
    await tick();
    expect(api.of("execute")).toEqual([]);
  });

  it("connects Supabase with its two-field key, no sign-in link", async () => {
    make([supabase]);
    await composio.reconcile();
    expect(told).toEqual([]);
    expect(api.of("linkManaged")).toEqual([]);
    expect(api.of("ensureAuthConfig")).toEqual(["ensureAuthConfig:supabase/API_KEY"]);
    const made = [...api.connections.values()][0];
    expect(made).toMatchObject({ user: "supabase:shop", status: "active" });
    expect(JSON.parse(made.key!)).toEqual({ full: "https://x.supabase.co", bearer_token: "sb-secret-1" });
  });

  it("connects Reddit through the managed sign-in", async () => {
    make([reddit]);
    await composio.reconcile();
    expect(told.filter((t) => t.text.startsWith("Sign in to Reddit for the Clots: https://"))).toHaveLength(1);
  });

  it("replaces the connection when one of two fields changes, through the staged swap, moving the triggers first", async () => {
    const withTrigger = { ...supabase, triggers: [{ slug: "SUPABASE_ROW_ADDED", config: { t: 1 } }] };
    make([withTrigger]);
    await composio.reconcile();
    const first = store.composio.account("supabase:shop")!.connectionId!;
    make([{ ...withTrigger, fields: { ...supabase.fields!, bearer_token: "sb-secret-2" } }]);
    api.calls.length = 0;
    await composio.reconcile();
    const second = store.composio.account("supabase:shop")!.connectionId!;
    expect(second).not.toBe(first);
    const order = api.calls.map((c) => c.split(":")[0]);
    expect(order.indexOf("connectWithKey")).toBeLessThan(order.indexOf("deleteConnection"));
    expect(api.connections.has(first)).toBe(false);
    expect([...api.triggers.values()].every((t) => t.connectionId === second)).toBe(true);
    // Unchanged again: nothing is replaced.
    api.calls.length = 0;
    await composio.reconcile();
    expect(api.of("connectWithKey")).toEqual([]);
  });

  it("makes a new auth config and a new sign-in when an OAuth app's secret changes, keeping the old connection until the new one is active", async () => {
    const own = (secret: string): ComposioAccount => ({ ...slack, oauthApp: { clientId: "SLACK_ID", clientSecret: "SLACK_SECRET" }, oauthValues: { clientId: "id-1", clientSecret: secret } });
    make([own("s1")]);
    await composio.reconcile();
    const first = store.composio.account("slack:work")!;
    api.connections.get(first.connectionId!)!.status = "active";
    await tick();
    expect(told.filter((t) => t.text.startsWith("Sign in")).length).toBe(1);

    make([own("s2")]);
    await composio.reconcile();
    const links = told.filter((t) => t.text.startsWith("Sign in"));
    expect(links).toHaveLength(2);
    // The old connection stays the account's, with its trigger, until the new sign-in completes.
    expect(store.composio.account("slack:work")!.connectionId).toBe(first.connectionId);
    expect(api.connections.has(first.connectionId!)).toBe(true);
    const staged = store.getState("composio.staged.slack:work")!.split("|");
    api.connections.get(staged[1])!.status = "active";
    await tick();
    const done = store.composio.account("slack:work")!;
    expect(done.connectionId).toBe(staged[1]);
    expect(done.authConfigId).not.toBe(first.authConfigId);
    expect(api.connections.has(first.connectionId!)).toBe(false);
    expect(api.deletedAuthConfigs).toEqual([first.authConfigId]);
    expect(store.getState("composio.staged.slack:work")).toBeUndefined();
  });

  it("tells a mismatch once per start, in the account's channel, and connects the other accounts", async () => {
    const bad: ComposioAccount = { ...base, toolkit: "slack", account: "bad", shared: true, apiKey: "xoxb-SECRET", apiKeyName: "SLACK_BAD_KEY" };
    make([bad, linear]);
    await composio.reconcile();
    await composio.reconcile();
    const said = told.filter((t) => t.account === "slack:bad");
    expect(said).toHaveLength(1);
    expect(said[0].text).toBe("slack:bad cannot connect: Slack has no key scheme, only Composio's sign-in, so apiKey and fields do not apply. Slack accepts: OAUTH2 (Composio's sign-in).");
    expect(api.of("connectWithKey").length).toBe(1);
    expect(store.composio.account("linear:proton")?.connectionId).toBeDefined();
    expect(store.composio.account("slack:bad")).toBeUndefined();
    expect(JSON.stringify([told, logs])).not.toContain("xoxb-SECRET");
  });

  it("tells the mismatch again after a restart, and not after the entry is fixed", async () => {
    const bad: ComposioAccount = { ...base, toolkit: "slack", account: "bad", shared: true, apiKey: "k", apiKeyName: "SLACK_BAD_KEY" };
    make([bad]);
    await composio.reconcile();
    make([bad]);
    await composio.reconcile();
    expect(told.filter((t) => t.account === "slack:bad")).toHaveLength(2);
    make([{ ...bad, apiKey: undefined, apiKeyName: undefined }]);
    await composio.reconcile();
    expect(told.filter((t) => t.account === "slack:bad")).toHaveLength(3);
    expect(told[2].text).toContain("Sign in to Slack");
  });

  it("reads Composio's metadata once per account, and never again for a working one", async () => {
    make([linear, slack]);
    await composio.reconcile();
    expect(api.of("toolkitInfo").sort()).toEqual(["toolkitInfo:linear", "toolkitInfo:slack"]);
    make([linear, slack]);
    api.calls.length = 0;
    await composio.reconcile();
    expect(api.of("toolkitInfo")).toEqual([]);
  });

  it("retries an account whose metadata cannot be read, with the account's job", async () => {
    api.failNext.set("toolkitInfo", new Error("503 down"));
    make([linear]);
    const { failures } = await composio.reconcile();
    expect(failures[0]).toContain("503 down");
    expect(store.composio.account("linear:proton")).toBeUndefined();
    await composio.reconcile();
    expect(store.composio.account("linear:proton")?.connectionId).toBeDefined();
  });

  it("counts an OAuth-app or key account against its own allowance and a managed one against Composio's", () => {
    make([slack]);
    expect(composio.managed(slack)).toBe(true);
    expect(composio.managed({ ...slack, oauthApp: { clientId: "A", clientSecret: "B" } })).toBe(false);
    expect(composio.managed(linear)).toBe(false);
    expect(composio.managed(supabase)).toBe(false);
  });

  it("tells an expired fields account which .env keys to replace, never a sign-in link", async () => {
    make([supabase]);
    await composio.reconcile();
    api.connections.get(store.composio.account("supabase:shop")!.connectionId!)!.status = "expired";
    await composio.checkDaily();
    const said = told.filter((t) => t.account === "supabase:shop");
    expect(said).toHaveLength(1);
    expect(said[0].text).toContain("Replace SB_URL, SB_KEY under Keys");
    expect(api.of("linkManaged")).toEqual([]);
  });

  it("never puts a field's value or an OAuth app's secret in anything it tells or logs", async () => {
    make([supabase, { ...slack, account: "own", oauthApp: { clientId: "SLACK_ID", clientSecret: "SLACK_SECRET" }, oauthValues: { clientId: "client-id-val", clientSecret: "client-secret-val" } }]);
    await composio.reconcile();
    await composio.checkDaily();
    const everything = JSON.stringify([told, logs]);
    for (const secret of ["sb-secret-1", "https://x.supabase.co", "client-secret-val", "client-id-val"]) expect(everything).not.toContain(secret);
  });

  it("does not hold a toolkit that needs no connection to one: no connection, no sign-in", async () => {
    make([{ ...base, toolkit: "hackernews", account: "news", shared: true }]);
    await composio.reconcile();
    expect(told).toEqual([]);
    expect(api.of("linkManaged")).toEqual([]);
    expect(store.composio.account("hackernews:news")?.status).toBe("active");
  });
});

describe("/composio reconnect", () => {
  const slack: ComposioAccount = { ...base, toolkit: "slack", account: "work", shared: true };

  it("deletes the connection and the stored identity and posts one new sign-in link", async () => {
    make([slack]);
    await composio.reconcile();
    const first = store.composio.account("slack:work")!.connectionId!;
    api.connections.get(first)!.status = "active";
    store.composio.setAccount("slack:work", { identity: "U-wrong", status: "active" });
    told.length = 0;
    expect(await composio.reconnect("slack:work")).toBe("Reconnecting slack:work.");
    for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
    expect(api.connections.has(first)).toBe(false);
    expect(store.composio.account("slack:work")!.identity).toBeUndefined();
    expect(told.filter((t) => t.text.startsWith("Sign in to Slack"))).toHaveLength(1);
    expect(store.composio.account("slack:work")!.connectionId).not.toBe(first);
  });

  it("reconnects a key account from its .env values with a new connection", async () => {
    make([linear]);
    await composio.reconcile();
    const first = store.composio.account("linear:proton")!.connectionId!;
    expect(await composio.reconnect("linear:proton")).toBe("Reconnecting linear:proton.");
    for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
    expect(api.connections.has(first)).toBe(false);
    expect(store.composio.account("linear:proton")!.connectionId).not.toBe(first);
    expect(told).toEqual([]);
  });

  it("answers an unknown name, and a name without its toolkit, plainly", async () => {
    make([slack]);
    expect(await composio.reconnect("slack:nope")).toBe("No Composio account slack:nope.");
    expect(await composio.reconnect("work")).toBe("No Composio account work.");
  });
});
