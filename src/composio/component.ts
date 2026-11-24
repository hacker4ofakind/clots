import type { ZodType } from "zod";
import type { ComposioAccount } from "../config.js";
import { retryWait, type Supervisor } from "../listeners.js";
import type { ComposioRecipe } from "../rulebook.js";
import type { Store } from "../store.js";
import { configKey, type ComposioApi, type Connection, type ExecResult, type ToolInfo } from "./api.js";
import { authHash, chooseAuth, entryAuthKey, fieldValues, secretsOf, type AuthChoice, type ToolkitInfo } from "./auth.js";
import type { Meter } from "./meter.js";
import { defFor, userOf, type ToolkitHost, type TriggerWant } from "./toolkits/index.js";

/** Whether an error says the thing is not there (Composio answers 404), as opposed to a failure to ask. */
const isNotFound = (e: unknown): boolean => Number((e as { status?: unknown } | null)?.status) === 404 || /404|not found/i.test(e instanceof Error ? e.message : String(e));

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
  /** `<toolkit>:<account>` of entries the loader left out as unusable: not removed from the configuration, so their triggers and rows are kept until the entry is mended or taken out on purpose. */
  skipped?: string[];
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
  /** The Composio recipe in force for a toolkit: the generic def reads its identity from it. */
  recipe?: (toolkit: string) => ComposioRecipe | undefined;
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
  private infos = new Map<string, ToolkitInfo>();
  /** The accounts whose identity is being learned, so a retry chain is never started twice. */
  private learning = new Set<string>();
  /** The identity each toolkit's recipe named when last looked at, to tell a change. */
  private identityOf = new Map<string, string>();
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

  /** The Composio recipe in force for a toolkit. */
  recipe(toolkit: string): ComposioRecipe | undefined {
    return this.d.recipe?.(toolkit);
  }

  /**
   * Called when the rulebook has been read: when a toolkit's recipe names another `identity` than the one the
   * stored identities were learned with, they are cleared and learned again.
   */
  recipeChanged(toolkit: string): void {
    const now = JSON.stringify(this.recipe(toolkit)?.identity ?? null);
    const before = this.identityOf.get(toolkit);
    this.identityOf.set(toolkit, now);
    if (before === undefined || before === now) return;
    for (const a of this.d.accounts.filter((x) => x.toolkit === toolkit)) {
      const row = this.d.store.composio.account(userOf(a));
      if (row === undefined) continue;
      this.d.store.composio.setAccount(userOf(a), { identity: undefined });
      this.learning.delete(userOf(a));
      if (row.connectionId !== undefined && row.status === "active") void this.learnIdentity(a);
    }
  }

  /** The account's established connection, or "" before it has one: what a cached read is scoped to. */
  connectionId(a: ComposioAccount): string {
    return this.d.store.composio.account(userOf(a))?.connectionId ?? "";
  }

  /** The connection's own user ID at the service, or "" until it has been read. */
  identity(a: ComposioAccount): string {
    return this.d.store.composio.account(userOf(a))?.identity ?? "";
  }

  /** Runs a tool as the account's own user. Tells the user, once, when it learns of a cap or a rejected connection. */
  async run(a: ComposioAccount, slug: string, args: Record<string, unknown>): Promise<ExecResult> {
    const result = await this.d.api.execute(userOf(a), a.toolkit, slug, args);
    await this.d.meter?.count("call", userOf(a), this.managed(a));
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
    const wanted = new Set([...this.d.accounts.map(userOf), ...(this.d.skipped ?? [])]);
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
      // A connection a failed key swap staged has no account left to retry or clear it, so it goes too. The account's
      // established connection stays. When it cannot be deleted now, the account's row stays and the next start tries again.
      if (!(await this.dropStaged(row.user, row.connectionId))) continue;
      this.d.store.composio.deleteAccount(row.user);
      this.d.store.deleteState(this.authKey(row.user));
    }
  }

  /** Deletes the connection a failed key swap staged for a user, and its marker. False when that could not be done yet. */
  private async dropStaged(user: string, current: string | undefined): Promise<boolean> {
    const staged = this.d.store.getState(this.stagedKey(user));
    if (staged === undefined) return true;
    const id = staged.split("|")[1];
    try {
      // Never the account's own connection: a crash can leave a marker that names it.
      if (id && id !== current) await this.d.api.deleteConnection(id);
    } catch (e) {
      if (!isNotFound(e)) {
        this.log(`deleting an abandoned connection of ${user} failed: ${e instanceof Error ? e.message : String(e)}`);
        return false;
      }
    }
    this.d.store.deleteState(this.stagedKey(user));
    return true;
  }

  /** What the account's entry connects with, resolved once from Composio's metadata and kept in `state` until the entry's auth fields change. */
  private authKey(user: string): string {
    return `composio.auth.${user}`;
  }

  /**
   * The way to connect an account (`chooseAuth`), read from Composio's metadata only when nothing is stored for the
   * entry's auth fields, so a working account never re-reads it and a later change in Composio's metadata cannot
   * disconnect it. A mismatch is told once per start in the account's channel and leaves the account unconnected;
   * unreadable metadata throws, and the account's job tries again.
   */
  private async resolveAuth(a: ComposioAccount): Promise<{ choice: AuthChoice; name: string } | undefined> {
    const { api, store } = this.d;
    const user = userOf(a);
    const entry = entryAuthKey(a);
    const kept = store.getState(this.authKey(user));
    if (kept !== undefined) {
      try {
        const stored = JSON.parse(kept) as { entry: string; choice: AuthChoice; name: string };
        if (stored.entry === entry) return { choice: stored.choice, name: stored.name };
      } catch {
        // An unreadable record is read again from Composio.
      }
    }
    const info = await this.toolkitInfo(a.toolkit);
    const chosen = chooseAuth(a, info);
    if ("error" in chosen) {
      this.log(chosen.error);
      await this.tellOnce(`auth:${user}`, a, chosen.error);
      return undefined;
    }
    store.setState(this.authKey(user), JSON.stringify({ entry, choice: chosen, name: info.name }));
    return { choice: chosen, name: info.name };
  }

  /** What Composio says of a toolkit, read once per toolkit per daemon life. A failed read is not kept: the caller's retry reads it again. */
  async toolkitInfo(slug: string): Promise<ToolkitInfo> {
    let info = this.infos.get(slug);
    if (info === undefined) {
      info = await this.d.api.toolkitInfo(slug);
      this.infos.set(slug, info);
    }
    return info;
  }

  /** Whether the account counts against Composio's managed allowance: no key, no fields and no OAuth app of its own. */
  managed(a: ComposioAccount): boolean {
    return a.apiKeyName === undefined && a.fieldKeys === undefined && a.oauthApp === undefined;
  }

  /** Brings one account up: auth choice, connection, identity, triggers. Idempotent. */
  async reconcileAccount(a: ComposioAccount): Promise<void> {
    const { store } = this.d;
    const user = userOf(a);
    const auth = await this.resolveAuth(a);
    if (auth === undefined) return;
    const { choice, name } = auth;
    const secrets = secretsOf(a);
    const hash = authHash(choice, secrets);

    if (choice.kind === "none") {
      store.composio.setAccount(user, { keyHash: hash, status: "active" });
      this.log(`${name} (${a.account}) needs no connection`);
      return;
    }
    const connectionId = choice.kind === "key" ? await this.ensureKeyConnection(a, choice, secrets, hash) : await this.ensureSignIn(a, choice, secrets, hash, name);
    if (connectionId === undefined) return;

    await this.afterConnected(a, connectionId, name);
  }

  /** Identity and triggers, and the line that says the account is up. Runs when a sign-in completes as well as at reconcile. */
  private async afterConnected(a: ComposioAccount, connectionId: string, name: string): Promise<void> {
    const user = userOf(a);
    await this.learnIdentity(a);
    await this.syncTriggers(a, connectionId, { verify: false });
    const held = this.d.store.composio.triggers(user);
    this.log(`${name} (${a.account}) connected${held.length > 0 ? `, holding ${held.length} trigger${held.length === 1 ? "" : "s"}: ${[...new Set(held.map((t) => t.slug))].join(", ")}` : ""}`);
  }

  /** What a key connection is made with: the `.env` fields, then the entry's `connect` (PostHog's region). */
  private keyFields(a: ComposioAccount, choice: Extract<AuthChoice, { kind: "key" }>, secrets: Record<string, string>): Record<string, string> {
    return { ...fieldValues(choice, secrets), ...(a.connect ?? {}) };
  }

  /** The connection of a key account: adopted, made, or replaced when a field changed. */
  private async ensureKeyConnection(a: ComposioAccount, choice: Extract<AuthChoice, { kind: "key" }>, secrets: Record<string, string>, hash: string): Promise<string> {
    const { api, store } = this.d;
    const user = userOf(a);
    const row = store.composio.account(user);
    const connect = async () => {
      const authConfigId = await api.ensureAuthConfig(a.toolkit, choice, secrets);
      const made = await api.connectWithKey(user, authConfigId, choice.scheme, this.keyFields(a, choice, secrets));
      return { made, authConfigId };
    };
    if (row?.connectionId !== undefined && row.keyHash === hash) {
      const staged = store.getState(this.stagedKey(user))?.split("|")[1];
      // A swap that finished but crashed before clearing its marker.
      if (staged === row.connectionId) store.deleteState(this.stagedKey(user));
      else if (staged !== undefined) {
        // The key went back to the established one after a swap failed: the staged connection is abandoned. Delete it
        // (throwing so the next try repeats this when it cannot), make the established one the tool target again, and
        // put the triggers back on it, since the failed swap had moved their rows to the staged connection.
        if (!(await this.dropStaged(user, row.connectionId))) throw new Error(`could not delete the abandoned connection of ${user} yet`);
        await api.findConnection(user, a.toolkit);
        await this.syncTriggers(a, row.connectionId, { verify: false, force: true });
      }
      return row.connectionId;
    }

    if (row?.connectionId === undefined) {
      const found = await api.findConnection(user, a.toolkit);
      if (found?.status === "active") {
        store.composio.setAccount(user, { connectionId: found.id, keyHash: hash, status: "active" });
        return found.id;
      }
      const { made, authConfigId } = await connect();
      store.composio.setAccount(user, { connectionId: made.id, authConfigId, keyHash: hash, status: made.status });
      return made.id;
    }

    // A value changed: connect the new one first, move the triggers onto it, and only then delete the old one,
    // so a crash midway leaves the old connection working and the next start redoes it.
    const made = await this.stagedConnection(a, hash, async () => (await connect()).made);
    await this.completeSwap(a, made.id, hash, made.status);
    return made.id;
  }

  /**
   * Moves an account from its established connection to a new one that is active: its triggers are made on the new
   * connection and the old ones deleted, then the old connection is, and only then is the account's row changed.
   * A crash midway leaves the old connection working; the next start redoes it.
   */
  private async completeSwap(a: ComposioAccount, newId: string, hash: string, status: Connection["status"], authConfigId?: string): Promise<void> {
    const { api, store } = this.d;
    const user = userOf(a);
    const old = store.composio.account(user);
    const oldTriggers = store.composio.triggers(user).map((t) => t.triggerId);
    await this.syncTriggers(a, newId, { verify: false, force: true });
    const fresh = new Set(store.composio.triggers(user).map((t) => t.triggerId));
    for (const id of oldTriggers.filter((t) => !fresh.has(t))) {
      try {
        await api.deleteTrigger(id);
      } catch (e) {
        this.log(`deleting an old trigger of ${user} failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (old?.connectionId !== undefined && old.connectionId !== newId) {
      try {
        await api.deleteConnection(old.connectionId);
      } catch (e) {
        // Gone already, such as after a crash between this and storing the account: the swap is still done.
        if (!isNotFound(e)) throw e;
      }
    }
    // An OAuth app's auth config belongs to its one account: it goes with the connection that used it.
    if (old?.keyHash?.startsWith("oauth:") && old.authConfigId !== undefined && old.authConfigId !== authConfigId) {
      await api.deleteAuthConfig(old.authConfigId).catch((e) => this.log(`deleting the old auth config of ${user} failed: ${e instanceof Error ? e.message : String(e)}`));
    }
    store.composio.setAccount(user, { connectionId: newId, keyHash: hash, status, ...(authConfigId === undefined ? {} : { authConfigId }) });
    store.deleteState(this.stagedKey(user));
  }

  private stagedKey(user: string): string {
    return `composio.staged.${user}`;
  }

  /**
   * The connection a changed key is moving to. It is remembered (by the key's hash) until the swap is complete, so
   * a swap that fails midway and is retried reuses it instead of making another and stranding this one. A staged
   * connection that is unusable, or made for a key that has since changed again, is deleted first. A failure to read
   * or delete it that is not "it is not there" is thrown with the marker kept, so the next try looks again; a new
   * connection is made only once the staged one is confirmed gone. A marker that names the account's own connection
   * (a crash after the swap) is just cleared, never acted on.
   */
  private async stagedConnection(a: ComposioAccount, hash: string, make: () => Promise<Connection>): Promise<Connection> {
    const { api, store } = this.d;
    const user = userOf(a);
    const marker = this.stagedKey(user);
    const staged = store.getState(marker);
    if (staged !== undefined) {
      const [stagedHash, id] = staged.split("|");
      if (!id || id === store.composio.account(user)?.connectionId) {
        store.deleteState(marker);
      } else {
        let found: Connection | undefined;
        try {
          found = await api.connection(id);
        } catch (e) {
          if (!isNotFound(e)) throw e;
        }
        if (found !== undefined && stagedHash === hash && found.status === "active") return found;
        if (found !== undefined) {
          try {
            await api.deleteConnection(id);
          } catch (e) {
            if (!isNotFound(e)) throw e;
          }
        }
        store.deleteState(marker);
      }
    }
    const made = await make();
    store.setState(marker, `${hash}|${made.id}`);
    return made;
  }

  /**
   * The connection of an account that signs in (Composio's managed app, or the user's own OAuth app): adopted when
   * active, else a sign-in link is posted once per start and its answer awaited. A changed choice (the OAuth app's
   * values, or key to sign-in) signs in anew while the old connection stays the account's, until the new one is active.
   */
  private async ensureSignIn(a: ComposioAccount, choice: AuthChoice, secrets: Record<string, string>, hash: string, name: string): Promise<string | undefined> {
    const { api, store } = this.d;
    const user = userOf(a);
    let row = store.composio.account(user);
    if (row?.connectionId === undefined) {
      const found = await api.findConnection(user, a.toolkit);
      if (found) store.composio.setAccount(user, { connectionId: found.id, status: found.status });
      row = store.composio.account(user);
    }
    const current = row?.connectionId;
    if (current === undefined) {
      if (!this.signingIn.has(user)) await this.signIn(a, choice, secrets, hash, name, {});
      return undefined;
    }
    // A row from before the choice was kept (the calendar's) has no hash yet: what is connected is adopted.
    if (row?.keyHash === hash || row?.keyHash === undefined) {
      const status = (await api.connection(current)).status;
      store.composio.setAccount(user, { status, keyHash: hash });
      if (status === "active") {
        const staged = store.getState(this.stagedKey(user))?.split("|")[1];
        if (staged === current) store.deleteState(this.stagedKey(user));
        return current;
      }
      if (!this.signingIn.has(user)) await this.signIn(a, choice, secrets, hash, name, { reuse: true });
      return undefined;
    }

    // The choice changed while a connection exists: sign in anew, and keep the old connection until the new one is active.
    const staged = store.getState(this.stagedKey(user))?.split("|");
    if (staged !== undefined && staged[0] === hash && staged[1]) {
      let status: Connection["status"] | undefined;
      try {
        status = (await api.connection(staged[1])).status;
      } catch (e) {
        if (!isNotFound(e)) throw e;
      }
      if (status === "active") {
        await this.completeSwap(a, staged[1], hash, "active", staged[2]);
        return staged[1];
      }
      if (status === "initiating") {
        if (!this.signingIn.has(user)) this.watchSignIn(a, staged[1], this.d.now() + SIGN_IN_WAIT_MS, name);
        return current;
      }
    }
    if (!this.signingIn.has(user)) {
      if (!(await this.dropStaged(user, current))) throw new Error(`could not delete the abandoned connection of ${user} yet`);
      await this.signIn(a, choice, secrets, hash, name, { swap: true });
    }
    return current;
  }

  /** Makes a sign-in link, posts it, and waits for the connection to become active. */
  private async signIn(a: ComposioAccount, choice: AuthChoice, secrets: Record<string, string>, hash: string, name: string, o: { reuse?: boolean; swap?: boolean }): Promise<void> {
    const { api, store } = this.d;
    const user = userOf(a);
    const row = store.composio.account(user);
    // A managed auth config is one for the toolkit, so it is reused; an OAuth app's is the account's own, made once per set of values.
    const authConfigId = o.reuse && row?.authConfigId !== undefined ? row.authConfigId : await api.ensureAuthConfig(a.toolkit, choice, secrets);
    const link = await api.linkManaged(user, authConfigId);
    if (o.swap) store.setState(this.stagedKey(user), `${hash}|${link.connectionId}|${authConfigId}`);
    else store.composio.setAccount(user, { authConfigId, connectionId: link.connectionId, keyHash: hash, status: "initiating" });
    this.signingIn.add(user);
    // The calendar is the user's own account by design; every other sign-in should be made as the Clots' own.
    const own = a.selfIsUser || a.toolkit === "googlecalendar" ? "" : `\nSign in with the Clots' own ${name} account, not yours, unless the entry has "selfIsUser": true.`;
    await this.d.tell(a, `Sign in to ${name} for the Clots: ${link.redirectUrl}${own}`);
    this.watchSignIn(a, link.connectionId, this.d.now() + SIGN_IN_WAIT_MS, name);
  }

  private watchSignIn(a: ComposioAccount, connectionId: string, deadline: number, name: string): void {
    this.signingIn.add(userOf(a));
    this.d.schedule(SIGN_IN_POLL_MS, () => {
      void (async () => {
        try {
          const status = (await this.d.api.connection(connectionId)).status;
          if (status === "active") {
            await this.signedIn(a, connectionId, status, name);
            return;
          }
        } catch (e) {
          this.log(`checking the ${name} sign-in of ${a.account} failed: ${e instanceof Error ? e.message : String(e)}`);
        }
        if (this.d.now() < deadline) this.watchSignIn(a, connectionId, deadline, name);
        else this.signingIn.delete(userOf(a));
      })();
    });
  }

  /** The sign-in completed: the account is brought up at once, not at the next daily check. */
  private async signedIn(a: ComposioAccount, connectionId: string, status: Connection["status"], name: string): Promise<void> {
    const user = userOf(a);
    this.signingIn.delete(user);
    const staged = this.d.store.getState(this.stagedKey(user))?.split("|");
    try {
      if (staged !== undefined && staged[1] === connectionId) await this.completeSwap(a, connectionId, staged[0], status, staged[2]);
      else this.d.store.composio.setAccount(user, { status });
      await this.afterConnected(a, connectionId, name);
    } catch (e) {
      this.log(`bringing ${user} up after its sign-in failed: ${e instanceof Error ? e.message : String(e)}; the next daily check tries again`);
    }
  }

  /**
   * `/composio reconnect <toolkit>:<account>`: deletes the account's connection at Composio and what the daemon
   * stored of it (its connection, identity and staged marker), then connects again: a new sign-in link for a
   * managed or OAuth-app account, a fresh connection from the `.env` values for a key one. It puts right a sign-in
   * made with the wrong account. The account's triggers are made again on the new connection by the usual sync.
   */
  async reconnect(name: string): Promise<string> {
    const a = this.account(name);
    if (a === undefined || !name.includes(":")) return `No Composio account ${name}.`;
    const { api, store } = this.d;
    const user = userOf(a);
    const row = store.composio.account(user);
    const staged = store.getState(this.stagedKey(user))?.split("|")[1];
    try {
      for (const t of store.composio.triggers(user)) {
        await api.deleteTrigger(t.triggerId).catch((e) => {
          if (!isNotFound(e)) throw e;
        });
        store.composio.deleteTrigger(user, t.slug, t.key);
      }
      for (const id of new Set([row?.connectionId, staged].filter((x): x is string => x !== undefined && x !== ""))) {
        await api.deleteConnection(id).catch((e) => {
          if (!isNotFound(e)) throw e;
        });
      }
      // An OAuth app's auth config is the account's own: the new sign-in makes another.
      if (row?.keyHash?.startsWith("oauth:") && row.authConfigId !== undefined) await api.deleteAuthConfig(row.authConfigId).catch(() => undefined);
    } catch (e) {
      return `Could not reconnect ${user}: ${e instanceof Error ? e.message : String(e)}. Nothing was changed that cannot be tried again.`;
    }
    store.composio.setAccount(user, { connectionId: undefined, keyHash: undefined, identity: undefined, status: undefined });
    store.deleteState(this.stagedKey(user));
    this.signingIn.delete(user);
    for (const key of [...this.told]) if (key.includes(user)) this.told.delete(key);
    void this.reconcileAccount(a).catch((e) => this.log(`reconnecting ${user} failed: ${e instanceof Error ? e.message : String(e)}`));
    return `Reconnecting ${user}.`;
  }

  /**
   * Reads who the connection is, once. A failure is retried with a growing wait and does not hold back anything else. One
   * chain per account: a second call while one is running does nothing. A toolkit that cannot say who it is does not retry.
   */
  private async learnIdentity(a: ComposioAccount, failures = 0): Promise<void> {
    const def = defFor(a.toolkit);
    const user = userOf(a);
    if (a.selfIsUser || def.identity === undefined || this.d.store.composio.account(user)?.identity) return;
    if (failures === 0 && this.learning.has(user)) return;
    this.learning.add(user);
    try {
      const id = await def.identity(a, this);
      if (id !== undefined) this.d.store.composio.setAccount(user, { identity: id });
      this.learning.delete(user);
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
    this.d.store.composio.pruneDeliveries(this.d.now());
    this.d.store.composio.pruneReads(this.d.now());
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
    if (a.apiKeyName === undefined && a.fieldKeys === undefined) {
      // Once a day, never more: the daily check is what asks again.
      if (this.told.has(`signin:${userOf(a)}:${Math.floor(this.d.now() / DAY_MS)}`)) return;
      this.told.add(`signin:${userOf(a)}:${Math.floor(this.d.now() / DAY_MS)}`);
      const auth = await this.resolveAuth(a);
      if (auth === undefined || auth.choice.kind === "key" || auth.choice.kind === "none") return;
      const secrets = secretsOf(a);
      await this.signIn(a, auth.choice, secrets, authHash(auth.choice, secrets), auth.name, { reuse: true });
      return;
    }
    await this.tellOnce(`expired:${userOf(a)}`, a, this.connectionText(a));
  }

  private connectionText(a: ComposioAccount): string {
    const keys = a.apiKeyName ?? Object.values(a.fieldKeys ?? {}).join(", ");
    return `Composio is no longer accepting the connection for ${userOf(a)}. Replace ${keys || "its key"} in .env and restart the daemon.`;
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
