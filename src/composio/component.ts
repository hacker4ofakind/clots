import type { ZodType } from "zod";
import type { ComposioAccount } from "../config.js";
import { retryWait, type Supervisor } from "../listeners.js";
import type { Store } from "../store.js";
import { configKey, keyHash, type ComposioApi, type ExecResult, type ToolInfo } from "./api.js";
import type { Meter } from "./meter.js";
import { defFor, userOf, type ToolkitHost, type TriggerWant } from "./toolkits/index.js";

const DAY_MS = 86_400_000;
/** The first daily check comes this long after startup. */
const FIRST_CHECK_MS = 10 * 60_000;
/** How often a calendar sign-in is looked for, and for how long. */
const SIGN_IN_POLL_MS = 30_000;
const SIGN_IN_WAIT_MS = 15 * 60_000;
export const WEBHOOK_SECRET_KEY = "composio.webhookSecret";
const CAP_MONTH_KEY = "composio.capMonth";

export interface ComposioDeps {
  api: ComposioApi;
  store: Store;
  accounts: ComposioAccount[];
  /** The tunnel's address, without a trailing slash. Without it no webhook subscription is made. */
  publicUrl: string;
  /** Posts in the channel of the Clot the account is bound to (the home Clot's, for a shared account). Never throws. */
  tell(account: ComposioAccount, text: string): Promise<void>;
  /** Posts in the home Clot's channel. Never throws. */
  tellHome(text: string): Promise<void>;
  now(): number;
  schedule(ms: number, fn: () => void): () => void;
  supervisor: Supervisor;
  log?: (text: string) => void;
  /** Counts each tool call against the month's allowance. */
  meter?: Meter;
}

/**
 * Keeps Composio in step with the configuration: the webhook subscription, each account's auth config,
 * connection, identity and trigger instances. Runs tools on an account's own session, and checks daily
 * that triggers and connections still work. The service keys it is given go to `connectWithKey` and
 * nowhere else: not into a log line, not into anything it tells the user.
 */
export class Composio implements ToolkitHost {
  private told = new Set<string>();
  private signingIn = new Set<string>();
  private tools = new Map<string, ToolInfo | undefined>();
  /** The fixed-purpose calls whose answers did not have the shape they rely on, since the daemon started. */
  private drift = new Map<string, { account: ComposioAccount; slug: string; where: string }>();

  constructor(private d: ComposioDeps) {}

  private log(text: string): void {
    (this.d.log ?? console.log)(`[composio] ${text}`);
  }

  userOf(a: ComposioAccount): string {
    return userOf(a);
  }

  /** Every configured account. */
  accounts(): ComposioAccount[] {
    return this.d.accounts;
  }

  /** An account by `<toolkit>:<account>`, or by its name alone when only one toolkit has it. */
  account(name: string, toolkit?: string): ComposioAccount | undefined {
    if (name.includes(":")) {
      const [t, ...rest] = name.split(":");
      return this.d.accounts.find((a) => a.toolkit === t && a.account === rest.join(":"));
    }
    const found = this.d.accounts.filter((a) => a.account === name && (toolkit === undefined || a.toolkit === toolkit));
    return found.length === 1 ? found[0] : undefined;
  }

  /** The account whose connection a delivery names. */
  byConnection(connectionId: string): ComposioAccount | undefined {
    const user = this.d.store.composio.userByConnection(connectionId);
    return user === undefined ? undefined : this.d.accounts.find((a) => userOf(a) === user);
  }

  /** The connection's own user ID at the service, or "" until it has been read. */
  identity(a: ComposioAccount): string {
    return this.d.store.composio.account(userOf(a))?.identity ?? "";
  }

  /** Runs a tool as the account's own user. Tells the user, once, when it learns of a cap or a rejected connection. */
  async run(a: ComposioAccount, slug: string, args: Record<string, unknown>): Promise<ExecResult> {
    const result = await this.d.api.execute(userOf(a), a.toolkit, slug, args);
    await this.d.meter?.count("call", userOf(a), a.apiKey === undefined);
    if (!result.ok) {
      if (result.reason === "cap") await this.noteCap();
      else if (result.reason === "auth") await this.tellOnce(`auth:${userOf(a)}`, a, this.connectionText(a));
    }
    return result;
  }

  /**
   * `run` for the daemon's own fixed-purpose calls: the answer is checked against the shape the call relies
   * on (`check`, else the toolkit def's check for this slug). A mismatch fails closed, as a refused result
   * the callers already handle ("could not be read"; a calendar change is refused), and is noted so that the
   * daily check tells the user once.
   */
  async runChecked(a: ComposioAccount, slug: string, args: Record<string, unknown>, check?: ZodType): Promise<ExecResult> {
    const result = await this.run(a, slug, args);
    if (!result.ok) return result;
    const schema = check ?? defFor(a.toolkit).responseChecks?.[slug];
    if (schema === undefined) return result;
    const parsed = schema.safeParse(result.data);
    if (parsed.success) return result;
    const issue = parsed.error.issues[0];
    const where = issue === undefined ? "" : ` at ${issue.path.length > 0 ? issue.path.join(".") : "the top"}: ${issue.message}`;
    const key = `${userOf(a)}|${slug}`;
    if (!this.drift.has(key)) {
      this.drift.set(key, { account: a, slug, where });
      this.log(`${slug} answered in an unexpected shape for ${userOf(a)}${where}`);
    }
    return { ok: false, reason: "refused", drift: true, error: `${slug} answered in an unexpected shape${where}` };
  }

  /** Whether a write of the Clots in this account touched the object since a time (Unix milliseconds). */
  touchedByClot(a: ComposioAccount, objectId: string, since: number): boolean {
    return this.d.store.composio.touchedSince(userOf(a), objectId, since);
  }

  /** A tool's description, kept for the daemon's life. An unknown slug is undefined. */
  async tool(slug: string): Promise<ToolInfo | undefined> {
    if (!this.tools.has(slug)) this.tools.set(slug, await this.d.api.tool(slug));
    return this.tools.get(slug);
  }

  find(a: ComposioAccount, query: string): Promise<ToolInfo[]> {
    return this.d.api.search(a.toolkit, query);
  }

  /**
   * Every step, once, in order; a step that fails is reported in the result and does not stop the rest.
   * The daemon uses `start`, which gives each step a job of its own with its own retries.
   */
  async reconcile(): Promise<{ failures: string[] }> {
    const failures: string[] = [];
    const attempt = async (what: string, step: () => Promise<void>) => {
      try {
        await step();
      } catch (e) {
        const why = e instanceof Error ? e.message : String(e);
        this.log(`${what} failed: ${why}`);
        failures.push(`${what}: ${why}`);
      }
    };
    await attempt("webhook", () => this.reconcileWebhook());
    await attempt("removed accounts", () => this.reconcileRemoved());
    for (const a of this.d.accounts) await attempt(userOf(a), () => this.reconcileAccount(a));
    return { failures };
  }

  /** Starts the webhook, each account and the daily check as jobs of their own. Nothing here waits for Composio. */
  start(): void {
    const { supervisor } = this.d;
    supervisor.start({ name: "Composio's webhook", everyMs: DAY_MS, tell: (t) => this.d.tellHome(t), run: () => this.reconcileWebhook() });
    void this.reconcileRemoved().catch((e) => this.log(`removing accounts failed: ${e instanceof Error ? e.message : String(e)}`));
    for (const a of this.d.accounts) {
      supervisor.start({ name: `Composio ${userOf(a)}`, everyMs: DAY_MS, tell: (t) => this.d.tell(a, t), run: () => this.reconcileAccount(a) });
    }
    this.d.schedule(FIRST_CHECK_MS, () => supervisor.start({ name: "Composio's daily check", everyMs: DAY_MS, tell: (t) => this.d.tellHome(t), run: () => this.checkDaily() }));
  }

  /** Sets the project's webhook subscription to this daemon, and keeps its secret. */
  async reconcileWebhook(): Promise<void> {
    if (this.d.publicUrl === "") {
      this.log("publicUrl is not set: no webhook subscription is made");
      return;
    }
    const url = `${this.d.publicUrl}/webhooks/composio`;
    const { api, store } = this.d;
    const have = await api.webhook();
    if (have === undefined || have.url !== url) {
      const set = await api.setWebhook(url);
      if (set.secret !== undefined) store.setState(WEBHOOK_SECRET_KEY, set.secret);
    }
    // Composio is the truth: its listing names the secret, so a lost copy is read back instead of rotated.
    const live = await api.webhook();
    const secret = live?.secret ?? store.getState(WEBHOOK_SECRET_KEY) ?? (await api.rotateWebhookSecret()).secret;
    store.setState(WEBHOOK_SECRET_KEY, secret);
    this.log(`webhook subscription at ${url}`);
  }

  /** Deletes the trigger instances of an account that left the configuration. Its connection stays: it is cheap, and reconnecting stays instant. */
  async reconcileRemoved(): Promise<void> {
    const wanted = new Set(this.d.accounts.map(userOf));
    for (const row of this.d.store.composio.accounts()) {
      if (wanted.has(row.user)) continue;
      for (const t of this.d.store.composio.triggers(row.user)) {
        try {
          await this.d.api.deleteTrigger(t.triggerId);
        } catch (e) {
          this.log(`deleting a trigger of ${row.user} failed: ${e instanceof Error ? e.message : String(e)}`);
        }
        this.d.store.composio.deleteTrigger(row.user, t.slug, t.key);
      }
      this.d.store.composio.deleteAccount(row.user);
    }
  }

  /** Brings one account up: auth config, connection, identity, triggers. Idempotent. */
  async reconcileAccount(a: ComposioAccount): Promise<void> {
    const { api, store } = this.d;
    const user = userOf(a);
    const row = store.composio.account(user);
    const managed = a.apiKey === undefined;
    const authConfigId = row?.authConfigId ?? (await api.ensureAuthConfig(a.toolkit, managed ? "MANAGED" : "API_KEY"));
    store.composio.setAccount(user, { authConfigId });

    const connectionId = managed ? await this.ensureManaged(a, authConfigId) : await this.ensureKeyConnection(a, authConfigId);
    if (connectionId === undefined) return;

    await this.learnIdentity(a);
    await this.syncTriggers(a, connectionId, { verify: false });
    const held = store.composio.triggers(user);
    this.log(`${user} connected${held.length > 0 ? `, holding ${held.length} trigger${held.length === 1 ? "" : "s"}: ${[...new Set(held.map((t) => t.slug))].join(", ")}` : ""}`);
  }

  /** The connection of a key account: adopted, made, or replaced when the key changed. */
  private async ensureKeyConnection(a: ComposioAccount, authConfigId: string): Promise<string> {
    const { api, store } = this.d;
    const user = userOf(a);
    const hash = keyHash(a.apiKey!);
    const row = store.composio.account(user);
    if (row?.connectionId !== undefined && row.keyHash === hash) return row.connectionId;

    const extra = defFor(a.toolkit).connectExtra?.(a);
    if (row?.connectionId === undefined) {
      const found = await api.findConnection(user, a.toolkit);
      if (found?.status === "active") {
        store.composio.setAccount(user, { connectionId: found.id, keyHash: hash, status: "active" });
        return found.id;
      }
      const made = await api.connectWithKey(user, authConfigId, a.apiKey!, extra);
      store.composio.setAccount(user, { connectionId: made.id, keyHash: hash, status: made.status });
      return made.id;
    }

    // The key changed: connect the new one first, move the triggers onto it, and only then delete the old one,
    // so a crash midway leaves the old connection working and the next start redoes it.
    const oldConnection = row.connectionId;
    const oldTriggers = store.composio.triggers(user).map((t) => t.triggerId);
    const made = await this.stagedConnection(a, authConfigId, hash, extra);
    await this.syncTriggers(a, made.id, { verify: false, force: true });
    const fresh = new Set(store.composio.triggers(user).map((t) => t.triggerId));
    for (const id of oldTriggers.filter((t) => !fresh.has(t))) {
      try {
        await api.deleteTrigger(id);
      } catch (e) {
        this.log(`deleting an old trigger of ${user} failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    await api.deleteConnection(oldConnection);
    store.composio.setAccount(user, { connectionId: made.id, keyHash: hash, status: made.status });
    store.deleteState(this.stagedKey(user));
    return made.id;
  }

  private stagedKey(user: string): string {
    return `composio.staged.${user}`;
  }

  /**
   * The connection a changed key is moving to. It is remembered (by the key's hash) until the swap is complete, so
   * a swap that fails midway and is retried reuses it instead of making another and stranding this one. One staged
   * for a key that has since changed again is deleted.
   */
  private async stagedConnection(a: ComposioAccount, authConfigId: string, hash: string, extra?: Record<string, string>): Promise<{ id: string; status: "active" | "initiating" | "expired" | "failed" }> {
    const { api, store } = this.d;
    const user = userOf(a);
    const staged = store.getState(this.stagedKey(user));
    if (staged !== undefined) {
      const [stagedHash, id] = staged.split("|");
      if (stagedHash === hash && id) {
        try {
          const found = await api.connection(id);
          if (found.status === "active") return found;
        } catch {
          // It is gone, so a new one is made.
        }
      }
      if (id) {
        try {
          await api.deleteConnection(id);
        } catch (e) {
          this.log(`deleting an abandoned connection of ${user} failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
    const made = await api.connectWithKey(user, authConfigId, a.apiKey!, extra);
    store.setState(this.stagedKey(user), `${hash}|${made.id}`);
    return made;
  }

  /** The calendar's connection: adopted when active, else a sign-in link is posted once per start and its answer awaited. */
  private async ensureManaged(a: ComposioAccount, authConfigId: string): Promise<string | undefined> {
    const { api, store } = this.d;
    const user = userOf(a);
    let id = store.composio.account(user)?.connectionId;
    if (id === undefined) {
      const found = await api.findConnection(user, a.toolkit);
      if (found) {
        id = found.id;
        store.composio.setAccount(user, { connectionId: id, status: found.status });
      }
    }
    if (id !== undefined) {
      const status = (await api.connection(id)).status;
      store.composio.setAccount(user, { status });
      if (status === "active") return id;
    }
    if (!this.signingIn.has(user)) await this.signIn(a, authConfigId);
    return undefined;
  }

  /** Makes a sign-in link, posts it, and waits for the connection to become active. */
  private async signIn(a: ComposioAccount, authConfigId?: string): Promise<void> {
    const { api, store } = this.d;
    const user = userOf(a);
    const config = authConfigId ?? store.composio.account(user)?.authConfigId ?? (await api.ensureAuthConfig(a.toolkit, "MANAGED"));
    const link = await api.linkManaged(user, config);
    store.composio.setAccount(user, { authConfigId: config, connectionId: link.connectionId, status: "initiating" });
    this.signingIn.add(user);
    await this.d.tell(a, `Sign in to Google Calendar for the Clots: ${link.redirectUrl}`);
    this.watchSignIn(a, link.connectionId, this.d.now() + SIGN_IN_WAIT_MS);
  }

  private watchSignIn(a: ComposioAccount, connectionId: string, deadline: number): void {
    this.d.schedule(SIGN_IN_POLL_MS, () => {
      void (async () => {
        try {
          const status = (await this.d.api.connection(connectionId)).status;
          if (status === "active") {
            this.d.store.composio.setAccount(userOf(a), { status });
            this.log(`Google Calendar (${a.account}) connected`);
            return;
          }
        } catch (e) {
          this.log(`checking the Google Calendar sign-in of ${a.account} failed: ${e instanceof Error ? e.message : String(e)}`);
        }
        if (this.d.now() < deadline) this.watchSignIn(a, connectionId, deadline);
      })();
    });
  }

  /** Reads who the connection is, once. A failure is retried with a growing wait and does not hold back anything else. */
  private async learnIdentity(a: ComposioAccount, failures = 0): Promise<void> {
    const def = defFor(a.toolkit);
    const user = userOf(a);
    if (def.identity === undefined || this.d.store.composio.account(user)?.identity) return;
    try {
      this.d.store.composio.setAccount(user, { identity: await def.identity(a, this) });
    } catch (e) {
      this.log(`${user}: could not tell who the connection is yet (${e instanceof Error ? e.message : String(e)}); trying again`);
      this.d.schedule(Math.min(retryWait(failures + 1), 3_600_000), () => void this.learnIdentity(a, failures + 1));
    }
  }

  /**
   * Makes the trigger instances an account should have and removes the ones it should not. With `verify`,
   * each stored instance is read and one that is disabled or gone is made again. With `force`, every instance
   * is made on this connection whatever the store says (a key was replaced).
   */
  private async syncTriggers(a: ComposioAccount, connectionId: string, o: { verify: boolean; force?: boolean }): Promise<void> {
    const { api, store } = this.d;
    const user = userOf(a);
    const wants = await defFor(a.toolkit).triggers(a, this);
    const wanted = new Set<string>();
    for (const want of wants) {
      const key = configKey(want.config);
      wanted.add(`${want.slug}|${key}`);
      const have = o.force ? undefined : store.composio.trigger(user, want.slug, key);
      if (have !== undefined && !(o.verify && (await api.triggerState(have)) !== "active")) continue;
      try {
        await this.makeTrigger(a, connectionId, want, key);
      } catch (e) {
        if (!o.verify) throw e;
        await this.tellOnce(`trigger:${user}|${want.slug}|${key}`, a, `Composio's trigger ${want.slug} for ${user} stopped and could not be made again (${e instanceof Error ? e.message : String(e)}).`);
      }
    }
    for (const row of store.composio.triggers(user)) {
      if (wanted.has(`${row.slug}|${row.key}`)) continue;
      try {
        await api.deleteTrigger(row.triggerId);
      } catch (e) {
        this.log(`deleting a trigger of ${user} failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      store.composio.deleteTrigger(user, row.slug, row.key);
    }
  }

  private async makeTrigger(a: ComposioAccount, connectionId: string, want: TriggerWant, key: string): Promise<void> {
    const id = await this.d.api.upsertTrigger(userOf(a), connectionId, want.slug, want.config, want.pollingMinutes);
    this.d.store.composio.setTrigger(userOf(a), want.slug, key, id);
  }

  /** Once a day: reads each connection, tells of one that stopped, and makes any trigger that is disabled, gone or new. */
  async checkDaily(): Promise<void> {
    for (const a of this.d.accounts) {
      const user = userOf(a);
      try {
        const id = this.d.store.composio.account(user)?.connectionId;
        if (id === undefined) continue;
        const status = (await this.d.api.connection(id)).status;
        this.d.store.composio.setAccount(user, { status });
        if (status !== "active") {
          await this.connectionProblem(a);
          continue;
        }
        await this.syncTriggers(a, id, { verify: true });
      } catch (e) {
        this.log(`the daily check of ${user} failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    await this.reportDrift();
  }

  /** Tells, once per tool and account per start, in the account's Clot channel, of a call whose answer changed shape. */
  private async reportDrift(): Promise<void> {
    for (const [key, d] of this.drift) {
      await this.tellOnce(`drift:${key}`, d.account, `Composio's ${d.slug} answered in an unexpected shape${d.where}. What the daemon reads through it for ${userOf(d.account)} is treated as unreadable until it is fixed; Composio or ${d.account.toolkit} may have changed it.`);
    }
  }

  /**
   * A trigger Composio reports it disabled. One disabled because the connection expired comes back by itself
   * (Composio words that `connection_expired` or "Connected account authentication expired."); any other is made again once.
   */
  async triggerDisabled(triggerId: string, reason?: string): Promise<void> {
    if (reason !== undefined && /connection_expired|expired/i.test(reason)) return;
    const row = this.d.store.composio.allTriggers().find((t) => t.triggerId === triggerId);
    const a = row && this.d.accounts.find((x) => userOf(x) === row.user);
    const connectionId = row && this.d.store.composio.account(row.user)?.connectionId;
    if (!row || !a || !connectionId) return;
    try {
      const want = (await defFor(a.toolkit).triggers(a, this)).find((w) => w.slug === row.slug && configKey(w.config) === row.key);
      if (want) await this.makeTrigger(a, connectionId, want, row.key);
    } catch (e) {
      await this.tellOnce(`trigger:${row.user}|${row.slug}|${row.key}`, a, `Composio disabled its trigger ${row.slug} for ${row.user} and it could not be made again (${e instanceof Error ? e.message : String(e)}).`);
    }
  }

  /** A connection Composio reports expired. */
  async connectionExpired(connectionId: string): Promise<void> {
    const a = this.byConnection(connectionId);
    if (a) await this.connectionProblem(a);
  }

  /** Tells, once, that a connection stopped: the calendar gets a new sign-in link, a key account the .env key to replace. */
  private async connectionProblem(a: ComposioAccount): Promise<void> {
    if (a.apiKey === undefined) {
      // Once a day, never more: the daily check is what asks again.
      if (this.told.has(`signin:${userOf(a)}:${Math.floor(this.d.now() / DAY_MS)}`)) return;
      this.told.add(`signin:${userOf(a)}:${Math.floor(this.d.now() / DAY_MS)}`);
      await this.signIn(a);
      return;
    }
    await this.tellOnce(`expired:${userOf(a)}`, a, this.connectionText(a));
  }

  private connectionText(a: ComposioAccount): string {
    return `Composio is no longer accepting the connection for ${userOf(a)}. Replace ${a.apiKeyName ?? "its key"} in .env and restart the daemon.`;
  }

  private async tellOnce(key: string, a: ComposioAccount, text: string): Promise<void> {
    if (this.told.has(key)) return;
    this.told.add(key);
    await this.d.tell(a, text);
  }

  /** Says once a month, in the home Clot's channel, that Composio's free monthly limit is reached. */
  private async noteCap(): Promise<void> {
    const now = new Date(this.d.now());
    const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
    if (this.d.store.getState(CAP_MONTH_KEY) === month) return;
    this.d.store.setState(CAP_MONTH_KEY, month);
    const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);
    await this.d.tellHome(`Composio's free monthly limit is reached: tools and events from Composio pause until ${next}.`);
  }
}
