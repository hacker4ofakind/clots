import { beforeEach, describe, expect, it } from "vitest";
import { Composio } from "../src/composio/component.js";
import { sourcesApplier } from "../src/integrations/apply.js";
import { keyNameFor, instructionsProblem } from "../src/integrations/configurer.js";
import { composioEntryProblems, type ComposioAccount, type Config } from "../src/config.js";
import { Supervisor } from "../src/listeners.js";
import { Store } from "../src/store.js";
import { FakeComposioApi } from "./fake-composio.js";

const base = { shared: true, audience: "team" as const, triggers: [], selfIsUser: false };
const posthog: ComposioAccount = { ...base, toolkit: "posthog", account: "shared", apiKey: "phx_value", apiKeyName: "POSTHOG_SHARED_KEY", connect: { subdomain: "us" } };
const linear: ComposioAccount = { ...base, toolkit: "linear", account: "team", apiKey: "lin_value", apiKeyName: "LINEAR_TEAM_KEY" };

let api: FakeComposioApi;
let store: Store;
let composio: Composio;
let timers: { ms: number; fn: () => void; cancelled: boolean }[];
let restartNeeded: Set<string>;
let reserved: string[][];
let apply: ReturnType<typeof sourcesApplier>;

const schedule = (ms: number, fn: () => void) => {
  const timer = { ms, fn, cancelled: false };
  timers.push(timer);
  return () => void (timer.cancelled = true);
};
const settle = async () => {
  for (let i = 0; i < 60; i++) await new Promise((resolve) => setImmediate(resolve));
};
const config = (composioAccounts: ComposioAccount[], email: unknown[] = []) => ({ sources: { email, composio: composioAccounts } }) as unknown as Config;

beforeEach(() => {
  api = new FakeComposioApi();
  store = new Store(":memory:");
  timers = [];
  restartNeeded = new Set();
  reserved = [];
  composio = new Composio({
    api,
    store,
    accounts: [],
    publicUrl: "https://box.example.ts.net",
    tell: async () => undefined,
    tellHome: async () => undefined,
    now: () => Date.now(),
    schedule,
    supervisor: new Supervisor({ schedule }),
    log: () => undefined,
  });
  apply = sourcesApplier({ composio, skipped: () => [], restartNeeded, onToolkits: (accounts) => void reserved.push(accounts.map((a) => a.toolkit)), log: () => undefined });
});

describe("a Composio component with no account at start", () => {
  it("calls Composio for nothing until the first account arrives", async () => {
    composio.start();
    await settle();
    expect(api.calls).toEqual([]);
    expect(timers).toHaveLength(0);
  });

  it("brings the first generic account up with no restart: the webhook, its connection and its triggers", async () => {
    composio.start();
    const answer = apply(config([posthog]), config([]));
    expect(answer).toEqual({ restart: false });
    await settle();
    expect(api.of("setWebhook")).toEqual(["setWebhook:https://box.example.ts.net/webhooks/composio"]);
    expect(api.of("connectWithKey")).toHaveLength(1);
    expect(store.composio.account("posthog:shared")?.connectionId).toBeDefined();
    expect(composio.account("posthog:shared")).toBeDefined();
    expect(reserved).toEqual([["posthog"]]);
    expect(timers.some((t) => t.ms === 10 * 60_000)).toBe(true);
  });

  it("starts the webhook once, however many accounts are added", async () => {
    composio.start();
    apply(config([posthog]), config([]));
    await settle();
    apply(config([posthog, { ...posthog, account: "second", apiKeyName: "POSTHOG_SECOND_KEY" }]), config([posthog]));
    await settle();
    expect(api.of("setWebhook")).toHaveLength(1);
    expect(api.of("connectWithKey")).toHaveLength(2);
  });

  it("takes an account's triggers away when it is removed", async () => {
    composio.start();
    const withTrigger = { ...posthog, triggers: [{ slug: "POSTHOG_EVENT_CAPTURED", config: { project_id: 1 } }] };
    apply(config([withTrigger]), config([]));
    await settle();
    expect(store.composio.triggers("posthog:shared")).toHaveLength(1);
    expect(apply(config([]), config([withTrigger]))).toEqual({ restart: false });
    await settle();
    expect(api.of("deleteTrigger")).toHaveLength(1);
    expect(store.composio.triggers("posthog:shared")).toHaveLength(0);
    expect(store.composio.account("posthog:shared")).toBeUndefined();
    expect(composio.account("posthog:shared")).toBeUndefined();
  });

  it("reconciles a changed account again: its triggers follow the entry", async () => {
    composio.start();
    const withTrigger = { ...posthog, triggers: [{ slug: "POSTHOG_EVENT_CAPTURED", config: { project_id: 1 } }] };
    apply(config([withTrigger]), config([]));
    await settle();
    expect(store.composio.triggers("posthog:shared")).toHaveLength(1);
    const events = { ...posthog, triggers: [] };
    expect(apply(config([events]), config([withTrigger]))).toEqual({ restart: false });
    await settle();
    expect(store.composio.triggers("posthog:shared")).toHaveLength(0);
  });

  it("changes the list before start without starting anything", async () => {
    const change = composio.setAccounts([posthog]);
    expect(change).toEqual({ added: ["posthog:shared"], removed: [], changed: [] });
    await settle();
    expect(api.calls).toEqual([]);
  });
});

describe("what still needs a restart", () => {
  it("says so for a built-in toolkit, and remembers it for the tile", async () => {
    composio.start();
    expect(apply(config([linear]), config([]))).toEqual({ restart: true });
    expect(restartNeeded.has("linear:team")).toBe(true);
    // The account is still brought up: its connection works, only its enricher and sender wait for the restart.
    await settle();
    expect(store.composio.account("linear:team")?.connectionId).toBeDefined();
    expect(apply(config([]), config([linear]))).toEqual({ restart: true });
    expect(restartNeeded.has("linear:team")).toBe(false);
  });

  it("says so for a change to the mail accounts, which the daemon sets up at start", () => {
    composio.start();
    expect(apply(config([], [{ account: "a" }]), config([]))).toEqual({ restart: true });
    expect(apply(config([], [{ account: "a" }]), config([], [{ account: "a" }]))).toEqual({ restart: false });
  });

  it("leaves a change to the mail accounts to their own handler once the daemon applies them live", () => {
    const live = sourcesApplier({ composio, skipped: () => [], restartNeeded, emailLive: true, log: () => undefined });
    composio.start();
    expect(live(config([], [{ account: "a" }]), config([]))).toEqual({ restart: false });
  });

  it("without a Composio key, a change to the composio entries is a restart", () => {
    const bare = sourcesApplier({ composio: undefined, skipped: () => [], restartNeeded });
    expect(bare(config([posthog]), config([]))).toEqual({ restart: true });
    expect(bare(config([]), config([]))).toEqual({ restart: false });
  });
});

describe("the account's status for its tile", () => {
  it("reads from the connection the daemon last saw", async () => {
    composio.setAccounts([posthog]);
    expect(composio.statusOf("posthog:shared")).toBe("unknown");
    store.composio.setAccount("posthog:shared", { status: "active" });
    expect(composio.statusOf("posthog:shared")).toBe("active");
    store.composio.setAccount("posthog:shared", { status: "initiating" });
    expect(composio.statusOf("posthog:shared")).toBe("waiting");
    store.composio.setAccount("posthog:shared", { status: "expired" });
    expect(composio.statusOf("posthog:shared")).toBe("failed");
  });
});

describe("forget", () => {
  it("deletes the connection and what the daemon stored of it, without connecting again", async () => {
    composio.setAccounts([posthog]);
    await composio.reconcile();
    const id = store.composio.account("posthog:shared")!.connectionId!;
    expect(await composio.forget(posthog)).toBeUndefined();
    expect(api.of("deleteConnection")).toEqual([`deleteConnection:${id}`]);
    expect(store.composio.account("posthog:shared")?.connectionId).toBeUndefined();
    expect(api.of("connectWithKey")).toHaveLength(1);
  });
});

describe("names and instructions", () => {
  it("makes the key name from the toolkit and account, and numbers one that is taken", () => {
    expect(keyNameFor("posthog", "my-team")).toBe("POSTHOG_MY_TEAM_KEY");
    expect(keyNameFor("google_sheets", "shared", (n) => n === "GOOGLE_SHEETS_SHARED_KEY")).toBe("GOOGLE_SHEETS_SHARED_KEY_2");
  });

  it("accepts plain numbered steps with https links, and nothing else", () => {
    expect(instructionsProblem("1. Open https://example.com/settings\n2. Copy the key.")).toBeUndefined();
    expect(instructionsProblem("see http://example.com")).toContain("https");
    expect(instructionsProblem("see ftp://example.com")).toContain("https");
    expect(instructionsProblem("javascript:alert(1)")).toContain("not https");
    expect(instructionsProblem("<img src=x>")).toContain("plain text");
    expect(instructionsProblem("a".repeat(1201))).toContain("1201");
  });
});

describe("a polled trigger's interval", () => {
  it("is accepted by the entry schema and reaches Composio as the trigger's polling interval", async () => {
    const entry = { toolkit: "posthog", account: "shared", shared: true, audience: "team", apiKey: "POSTHOG_SHARED_KEY", connect: { subdomain: "us" }, triggers: [{ slug: "POSTHOG_POLLED", config: {}, pollMinutes: 30 }] };
    expect(composioEntryProblems(entry, [])).toBeUndefined();
    expect(composioEntryProblems({ ...entry, triggers: [{ slug: "POSTHOG_POLLED", config: {}, pollMinutes: 0 }] }, [])).toBeDefined();
    composio.setAccounts([{ ...posthog, triggers: [{ slug: "POSTHOG_POLLED", config: {}, pollMinutes: 30 }] }]);
    await composio.reconcile();
    expect(api.of("upsertTrigger")[0]).toContain("every 30m");
  });
});
