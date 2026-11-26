import { readableText, type ConfigureBody, type IntegrationJob, type IntegrationStatus, type ToolkitSummaryView } from "@clots/ui-api-schemas";
import type { ComposioApi } from "../composio/api.js";
import type { ToolkitInfo } from "../composio/auth.js";
import { HOME_CLOT } from "../config.js";
import type { ConfigStore } from "../config-store.js";
import { CLOT_NAME, sameClot } from "../clot-name.js";
import { isBuiltinToolkit } from "../events/kinds.js";
import { keyNameFor, type ConfigureRequest, type ConfigureResult, type ConnectAuth } from "./configurer.js";

const HOUR_MS = 3_600_000;
/** The toolkit list is read from Composio once a day. */
export const TOOLKIT_CACHE_MS = 24 * HOUR_MS;
/** A sign-in not finished within this long is removed from Composio. */
export const ABANDON_AFTER_MS = HOUR_MS;
/** Done stays disabled this long after the link is made, so a click cannot outrun the sign-in. */
export const OAUTH_READY_AFTER_MS = 5_000;
/** The most toolkits one answer lists. */
export const TOOLKIT_LIMIT = 60;

/** Thrown for a request that cannot be done; the route turns it into an answer. */
export class JobError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Whether the built-in toolkits' events come as webhooks: the calendar is polled by the daemon. */
const BUILTIN_WEBHOOKS: Record<string, boolean> = { linear: true, notion: true, stripe: true, googlecalendar: false };

/**
 * How a toolkit connects from the dialog, or why it cannot: the daemon decides this from what Composio says of the toolkit (the
 * configurer never does, and neither does the toolkit's name: Linear signs in through Composio, PostHog takes a key). A sign-in that
 * Composio manages and that asks for nothing first goes through it; otherwise a key scheme is a key.
 */
export function authFor(info: ToolkitInfo): ConnectAuth | { error: string } {
  if (info.noAuth === true) return "none";
  const sign = info.schemes.find((s) => s.scheme.startsWith("OAUTH") && info.managed.includes(s.scheme));
  if (sign !== undefined && sign.required.length === 0) return "oauth";
  if (info.schemes.some((s) => !s.scheme.startsWith("OAUTH"))) return "key";
  return { error: `${info.name} needs an OAuth app of your own, which this dialog cannot set up. Put an entry with oauthApp in clots.config.json.` };
}

/** Whether an entry connects with a key of its own (it names one in `apiKey` or `fields`). */
const hasKey = (entry: Record<string, unknown>): boolean => entry.apiKey !== undefined || entry.fields !== undefined;

/**
 * How a tool that exists keeps connecting when its settings are edited: the way its entry already does, never a new one (a Linear
 * entry that names a key stays a key entry, one that signs in stays a sign-in), so an edit cannot leave a key behind or drop one.
 */
export function authOfEntry(entry: Record<string, unknown>, info: ToolkitInfo): ConnectAuth {
  if (hasKey(entry)) return "key";
  return info.noAuth === true ? "none" : "oauth";
}

interface Job {
  id: string;
  toolkit: string;
  name: string;
  /** The account in `sources.composio`. */
  account: string;
  clot?: string;
  audience: ConfigureBody["audience"];
  selfIsUser: boolean;
  events: boolean;
  pollMinutes?: number;
  leadTimes?: string[];
  checkoutCompleted?: boolean;
  /** `<toolkit>:<account>` of the tool being edited. */
  replaces?: string;
  /** A reconnect of a tool that exists: no configurer, no entry written. */
  reconnect?: true;
  /** `<toolkit>:<account>` of the entry this job wrote, so a second Finish replaces it. */
  writtenId?: string;
  auth: ConnectAuth;
  keyName?: string;
  /** The key was put in `.env` by this job, and nothing has used it yet. */
  keyWritten: boolean;
  state: IntegrationStatus["state"];
  error?: string;
  instructions?: string;
  entry?: Record<string, unknown>;
  link?: string;
  linkedAt?: number;
  connectionId?: string;
  /** The connection was made by this job, so abandoning removes it. A tool's existing one is never removed. */
  ownConnection: boolean;
  /** The connection is ready but the Clot it is for does not exist yet. */
  held: boolean;
  committed: boolean;
  needsRestart: boolean;
  /** Bumped by each Finish and by abandon: a run that finds it changed is out of date and does nothing more. */
  gen: number;
  /** When the state last changed, for the hour a finished or failed job is kept. */
  touched: number;
}

export interface JobsDeps {
  config: Pick<ConfigStore, "current" | "json" | "save" | "setKey" | "removeKey" | "usersOf" | "keys" | "skipped">;
  api: Pick<ComposioApi, "listToolkits" | "toolkitTriggers" | "toolkitInfo" | "ensureAuthConfig" | "linkManaged" | "connection" | "deleteConnection" | "findConnection">;
  configurer: { configure(req: ConfigureRequest): Promise<ConfigureResult> };
  emit(type: "integration.status", data: IntegrationStatus): void;
  now(): number;
  newId(): string;
  /** A tool that already exists has a new connection (a reconnect): the component adopts it. */
  reconnected(toolId: string): Promise<void>;
  /** Deletes what the component stored of a tool's old connection, ready for a new one. Returns why it could not. */
  forget(toolId: string): Promise<string | undefined>;
  log?: (text: string) => void;
}

const idOf = (e: Record<string, unknown>) => `${String(e.toolkit)}:${String(e.account)}`;
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const isNotFound = (e: unknown): boolean => Number((e as { status?: unknown } | null)?.status) === 404 || /404|not found/i.test(message(e));

/** The `.env` key an existing entry names for its one secret, if it names exactly one. */
function secretKeyOf(entry: Record<string, unknown>): string | undefined {
  const fields = Object.values((entry.fields as Record<string, string> | undefined) ?? {});
  const names = [entry.apiKey, ...fields].filter((n): n is string => typeof n === "string");
  return names.length === 1 ? names[0] : undefined;
}

/**
 * The connection attempts of the dialog: one job per toolkit and scope, from Finish to a tool that works. A job runs the configurer, then
 * makes the connection ready (a sign-in link Composio is watched for, or the person's key written to `.env`), and only then writes the
 * entry, so the configuration never holds a tool that cannot work yet. Jobs live in memory and are dropped an hour after their last change.
 */
export class IntegrationJobs {
  private jobs = new Map<string, Job>();
  private toolkitCache?: { at: number; list: ToolkitSummaryView[] };
  private toolkitLoading?: Promise<ToolkitSummaryView[]>;
  /** Whether each toolkit has a webhook trigger type, read from Composio once per toolkit and kept for the day with the list. */
  private webhookFlags = new Map<string, { at: number; value: boolean } | Promise<void>>();
  private ticking = false;

  constructor(private d: JobsDeps) {}

  private log(text: string): void {
    (this.d.log ?? console.log)(`[integrations] ${text}`);
  }

  // ---- the toolkit list

  /** Composio's toolkits, cached for a day. A failed read is not cached. */
  private async loadToolkits(): Promise<ToolkitSummaryView[]> {
    const fresh = this.toolkitCache !== undefined && this.d.now() - this.toolkitCache.at < TOOLKIT_CACHE_MS;
    if (fresh) return this.toolkitCache!.list;
    this.toolkitLoading ??= (async () => {
      try {
        const list: ToolkitSummaryView[] = await this.d.api.listToolkits();
        this.toolkitCache = { at: this.d.now(), list };
        return list;
      } finally {
        this.toolkitLoading = undefined;
      }
    })();
    return this.toolkitLoading;
  }

  /** Starts reading whether a toolkit has a webhook trigger type, unless it is known or being read. A failed read is left unknown. */
  private resolveWebhooks(slug: string): Promise<void> | undefined {
    if (BUILTIN_WEBHOOKS[slug] !== undefined) return undefined;
    const known = this.webhookFlags.get(slug);
    if (known instanceof Promise) return known;
    if (known !== undefined && this.d.now() - known.at < TOOLKIT_CACHE_MS) return undefined;
    const read = this.d.api
      .toolkitTriggers(slug)
      .then((types) => void this.webhookFlags.set(slug, { at: this.d.now(), value: types.some((t) => t.type === "webhook") }))
      .catch(() => void this.webhookFlags.delete(slug));
    this.webhookFlags.set(slug, read);
    return read;
  }

  private webhooksOf(slug: string): boolean | undefined {
    if (BUILTIN_WEBHOOKS[slug] !== undefined) return BUILTIN_WEBHOOKS[slug];
    const flag = this.webhookFlags.get(slug);
    return flag === undefined || flag instanceof Promise ? undefined : flag.value;
  }

  /**
   * The toolkits whose name or slug holds `q`, at most 60, each with whether it has a webhook trigger. A short answer (a toolkit looked
   * up by name) waits for that to be read; a long one gets what is known and reads the rest in the background for the next ask.
   */
  async toolkits(q?: string): Promise<ToolkitSummaryView[]> {
    const all = await this.loadToolkits();
    const needle = (q ?? "").trim().toLowerCase();
    const found = (needle === "" ? all : all.filter((t) => t.name.toLowerCase().includes(needle) || t.slug.toLowerCase().includes(needle))).slice(0, TOOLKIT_LIMIT);
    const reads = found.map((t) => this.resolveWebhooks(t.slug)).filter((r): r is Promise<void> => r !== undefined);
    if (found.length <= 3) await Promise.race([Promise.all(reads), new Promise((resolve) => setTimeout(resolve, 5_000).unref())]);
    return found.map((t) => {
      const webhooks = this.webhooksOf(t.slug);
      return webhooks === undefined ? t : { ...t, webhooks };
    });
  }

  /** A toolkit's logo from the list read so far; asks for the list when it was never read. */
  logoOf(toolkit: string): string | undefined {
    if (this.toolkitCache === undefined) void this.loadToolkits().catch(() => undefined);
    return this.toolkitCache?.list.find((t) => t.slug === toolkit)?.logo;
  }

  // ---- reading a job

  private view(job: Job): IntegrationJob {
    return { ...this.status(job), name: job.name, clot: job.clot ?? null, ...(job.held ? { held: true } : {}) };
  }

  private status(job: Job): IntegrationStatus {
    return {
      jobId: job.id,
      toolkit: job.toolkit,
      state: job.state,
      ...(job.state === "oauth" && job.link !== undefined ? { link: job.link, oauthReadyAt: (job.linkedAt ?? this.d.now()) + OAUTH_READY_AFTER_MS } : {}),
      ...(job.state === "key" ? { keyName: job.keyName, ...(job.instructions === undefined ? {} : { instructions: job.instructions }) } : {}),
      ...(job.error === undefined || job.state !== "failed" ? {} : { error: job.error }),
      ...(job.needsRestart ? { needsRestart: true } : {}),
    };
  }

  private set(job: Job, state: Job["state"], extra: { error?: string } = {}): void {
    job.state = state;
    job.error = extra.error;
    job.touched = this.d.now();
    this.d.emit("integration.status", this.status(job));
  }

  private fail(job: Job, error: string): void {
    this.log(`${job.toolkit}:${job.account} failed: ${error}`);
    // The dialog shows this: a sentence for a person, never the exception's own words (those are in the log).
    this.set(job, "failed", { error: readableText(error, "The connection could not be made. Try again.") });
  }

  get(jobId: string): IntegrationJob {
    const job = this.jobs.get(jobId);
    if (job === undefined) throw new JobError(404, "There is no such connection in progress.");
    return this.view(job);
  }

  // ---- starting a job

  private clotExists(name: string): boolean {
    const c = this.d.config.current;
    return (name === HOME_CLOT && c.home) || c.clots.some((x) => x.name === name);
  }

  private composioEntries(): Record<string, unknown>[] {
    return ((this.d.config.json().sources as { composio?: Record<string, unknown>[] } | undefined)?.composio ?? []).slice();
  }

  /** An account name for a new tool: the Clot's, or `shared`, with a number when the toolkit already has it. */
  private accountFor(toolkit: string, clot?: string): string {
    const base = clot === undefined ? "shared" : clot.toLowerCase();
    const taken = new Set([...this.composioEntries().filter((e) => e.toolkit === toolkit).map((e) => String(e.account)), ...[...this.jobs.values()].filter((j) => j.toolkit === toolkit).map((j) => j.account)]);
    let account = base;
    for (let n = 2; taken.has(account); n++) account = `${base}-${n}`;
    return account;
  }

  /** The key name that is the daemon's own for this account. Unique against the configuration and the jobs in progress. */
  private newKeyName(toolkit: string, account: string): string {
    const used = new Set([...this.jobs.values()].map((j) => j.keyName));
    return keyNameFor(toolkit, account, (name) => this.d.config.usersOf(name).length > 0 || used.has(name));
  }

  /** Finish: starts a job, or updates the one named by `jobId`, and runs the configurer. Answers the job's ID at once. */
  async configure(body: ConfigureBody): Promise<string> {
    if (body.clot !== undefined && !CLOT_NAME.test(body.clot)) throw new JobError(400, "That is not a Clot's name.");
    let job = body.jobId === undefined ? undefined : this.jobs.get(body.jobId);
    if (body.jobId !== undefined && job === undefined) throw new JobError(404, "That connection was dropped after an hour. Start again.");
    if (job !== undefined && job.toolkit !== body.toolkit) throw new JobError(409, "That connection is for another service.");
    if (job?.reconnect) throw new JobError(409, "A reconnect has no settings to change.");

    let info: ToolkitInfo;
    try {
      info = await this.d.api.toolkitInfo(body.toolkit);
    } catch (e) {
      this.log(`describing ${body.toolkit} failed: ${message(e)}`);
      throw new JobError(404, `Composio could not load the settings for ${body.toolkit}. Check the name or try again in a moment.`);
    }

    const replaces = body.replaces ?? job?.replaces;
    let current: Record<string, unknown> | undefined;
    if (replaces !== undefined) {
      current = this.composioEntries().find((e) => idOf(e) === replaces);
      if (current === undefined) throw new JobError(404, "The tool being edited is gone.");
      if (current.toolkit !== body.toolkit) throw new JobError(409, "That tool is for another service.");
    }
    const decided = current === undefined ? authFor(info) : authOfEntry(current, info);
    if (typeof decided !== "string") throw new JobError(400, decided.error);
    const auth: ConnectAuth = decided;

    if (job === undefined) {
      const account = current === undefined ? this.accountFor(body.toolkit, body.clot) : String(current.account);
      job = {
        id: this.d.newId(),
        toolkit: body.toolkit,
        name: info.name || body.toolkit,
        account,
        audience: body.audience,
        selfIsUser: body.selfIsUser,
        events: body.events,
        auth,
        keyWritten: false,
        state: "working",
        ownConnection: false,
        held: false,
        committed: false,
        needsRestart: false,
        gen: 0,
        touched: this.d.now(),
      };
      this.jobs.set(job.id, job);
    }
    // The same job again (Back, then Finish): the new options replace the old, and whatever the last run made is kept or remade below.
    job.gen += 1;
    job.clot = body.clot;
    job.audience = body.audience;
    job.selfIsUser = body.selfIsUser;
    job.events = body.events;
    job.pollMinutes = body.pollMinutes;
    job.leadTimes = body.leadTimes;
    job.checkoutCompleted = body.checkoutCompleted;
    job.replaces = replaces;
    job.auth = auth;
    job.instructions = undefined;
    job.entry = undefined;
    job.held = false;
    job.keyName = auth === "key" ? ((current === undefined ? undefined : secretKeyOf(current)) ?? job.keyName ?? this.newKeyName(job.toolkit, job.account)) : undefined;
    this.set(job, "working");
    void this.run(job, job.gen, current, info);
    return job.id;
  }

  private async run(job: Job, gen: number, current: Record<string, unknown> | undefined, info: ToolkitInfo): Promise<void> {
    const stale = () => job.gen !== gen || this.jobs.get(job.id) !== job;
    try {
      const clots = [...this.d.config.current.clots.map((c) => c.name), ...(this.d.config.current.home ? [HOME_CLOT] : []), ...(job.clot !== undefined && !this.clotExists(job.clot) ? [job.clot] : [])];
      const result = await this.d.configurer.configure({
        toolkit: job.toolkit,
        name: info.name || job.toolkit,
        account: job.account,
        ...(job.clot === undefined ? {} : { clot: job.clot }),
        audience: job.audience,
        selfIsUser: job.selfIsUser,
        events: job.events,
        ...(job.pollMinutes === undefined ? {} : { pollMinutes: job.pollMinutes }),
        ...(job.leadTimes === undefined ? {} : { leadTimes: job.leadTimes }),
        ...(job.checkoutCompleted === undefined ? {} : { checkoutCompleted: job.checkoutCompleted }),
        auth: job.auth,
        ...(job.keyName === undefined ? {} : { keyName: job.keyName }),
        ...(current === undefined ? {} : { current }),
        clots,
      });
      if (stale()) return;
      if (!result.ok) {
        if (result.detail !== undefined) this.log(`${job.toolkit}:${job.account} configurer: ${result.detail}`);
        return this.fail(job, result.error);
      }
      job.entry = result.entry;
      job.instructions = result.instructions;
      await this.connect(job, gen);
    } catch (e) {
      if (!stale()) this.fail(job, message(e));
    }
  }

  // ---- making the connection ready

  private async connect(job: Job, gen: number): Promise<void> {
    if (job.auth === "oauth") return this.signIn(job, gen);
    if (job.auth === "none") return this.ready(job);
    // A key. Editing a tool whose key is already in `.env` asks for nothing; otherwise the dialog asks for it.
    if (job.replaces !== undefined && this.d.config.keys().some((k) => k.name === job.keyName)) return this.ready(job);
    this.set(job, "key");
  }

  private async deleteQuiet(id: string): Promise<void> {
    try {
      await this.d.api.deleteConnection(id);
    } catch (e) {
      if (!isNotFound(e)) this.log(`deleting the connection ${id} failed: ${message(e)}`);
    }
  }

  /** The sign-in link, or the connection that is already there, and the watch for it to become active. */
  private async signIn(job: Job, gen: number): Promise<void> {
    const stale = () => job.gen !== gen || this.jobs.get(job.id) !== job;
    const user = `${job.toolkit}:${job.account}`;
    // Back and Finish again: the connection made before is kept while it can still be signed in to.
    if (job.connectionId !== undefined) {
      let status: string | undefined;
      try {
        status = (await this.d.api.connection(job.connectionId)).status;
      } catch (e) {
        if (!isNotFound(e)) throw e;
      }
      if (stale()) return;
      if (status === "active") return this.signedIn(job);
      if (status === "initiating" && job.link !== undefined && job.linkedAt !== undefined && this.d.now() - job.linkedAt < ABANDON_AFTER_MS) return this.set(job, "oauth");
      await this.deleteQuiet(job.connectionId);
      job.connectionId = undefined;
      job.link = undefined;
      job.ownConnection = false;
    }
    const have = await this.d.api.findConnection(user, job.toolkit);
    if (stale()) return;
    if (have !== undefined) {
      // Editing a tool keeps the sign-in it has; a connection left behind by a tool of this name that was removed is not the person's choice now.
      if (have.status === "active" && job.replaces !== undefined) {
        job.connectionId = have.id;
        return this.signedIn(job);
      }
      await this.deleteQuiet(have.id);
    }
    const authConfigId = await this.d.api.ensureAuthConfig(job.toolkit, { kind: "managed" }, {});
    const link = await this.d.api.linkManaged(user, authConfigId);
    if (stale()) {
      await this.deleteQuiet(link.connectionId);
      return;
    }
    job.connectionId = link.connectionId;
    job.ownConnection = true;
    job.link = link.redirectUrl;
    job.linkedAt = this.d.now();
    this.set(job, "oauth");
  }

  /** The connection is active: the entry is written (or held), or for a reconnect the component adopts it. */
  private async signedIn(job: Job): Promise<void> {
    if (job.reconnect) {
      try {
        await this.d.reconnected(job.replaces!);
      } catch (e) {
        this.log(`bringing ${job.toolkit}:${job.account} up again failed: ${message(e)}`);
        return this.fail(job, "The tool could not be brought up again. Try again in a moment.");
      }
      return this.set(job, "active");
    }
    return this.ready(job);
  }

  /** The connection is ready: writes the entry, or holds it for a Clot that is not made yet. */
  private async ready(job: Job): Promise<void> {
    if (job.entry === undefined) return this.fail(job, "There is no entry to save.");
    if (job.clot !== undefined && !this.clotExists(job.clot)) {
      job.held = true;
      return this.set(job, "active");
    }
    const written = await this.commit(job);
    if (written !== undefined) return this.fail(job, written);
    this.set(job, "active");
  }

  /** Writes the entry into `sources.composio`, in place of the one it replaces or of the one it wrote before, so never twice. Returns the error. */
  private async commit(job: Job): Promise<string | undefined> {
    const sources = (this.d.config.json().sources ?? {}) as Record<string, unknown>;
    const composio = this.composioEntries();
    const id = `${job.toolkit}:${job.account}`;
    const target = job.writtenId ?? job.replaces ?? id;
    const before = composio.slice();
    const at = composio.findIndex((e) => idOf(e) === target);
    if (at >= 0) composio[at] = job.entry!;
    else composio.push(job.entry!);
    const result = await this.d.config.save({ sources: { ...sources, composio } });
    if (!result.ok) {
      // The key was for this entry: with the entry refused, nothing should keep it.
      this.dropKey(job);
      return Object.values(result.errors)[0] ?? "The configuration did not accept the entry.";
    }
    // The loader leaves out an entry it cannot use and says why, instead of refusing the file: such an entry is not a tool, so it is taken out again.
    const skipped = this.d.config.skipped.find((s) => s.entry === id);
    if (skipped !== undefined) {
      await this.d.config.save({ sources: { ...sources, composio: before } });
      this.dropKey(job);
      return skipped.problem;
    }
    job.writtenId = id;
    job.committed = true;
    job.keyWritten = false;
    job.needsRestart = result.needsRestart.includes("sources");
    return undefined;
  }

  private dropKey(job: Job): void {
    if (!job.keyWritten || job.keyName === undefined) return;
    if (this.d.config.usersOf(job.keyName).length === 0) this.d.config.removeKey(job.keyName);
    job.keyWritten = false;
  }

  // ---- the person's key

  /** The key from the dialog goes to `.env`, then the entry is written: `loadConfig` needs every key an entry names. */
  async putKey(jobId: string, value: string): Promise<void> {
    const job = this.jobs.get(jobId);
    if (job === undefined) throw new JobError(404, "There is no such connection in progress.");
    if (job.auth !== "key" || job.state !== "key" || job.keyName === undefined) throw new JobError(409, "This connection is not waiting for a key.");
    const existed = this.d.config.keys().some((k) => k.name === job.keyName);
    const written = this.d.config.setKey(job.keyName, value);
    if (!written.ok) throw new JobError(400, written.error);
    job.keyWritten = !existed;
    this.set(job, "working");
    if (job.reconnect) {
      try {
        await this.d.reconnected(job.replaces!);
      } catch (e) {
        this.log(`bringing ${job.toolkit}:${job.account} up again failed: ${message(e)}`);
        return this.fail(job, "The tool could not be brought up again. Try again in a moment.");
      }
      return this.set(job, "active");
    }
    await this.ready(job);
  }

  // ---- leaving

  /** Back from the connect step, or a dialog closed: what the job made is removed, unless a tool already uses it. */
  async abandon(jobId: string): Promise<void> {
    const job = this.jobs.get(jobId);
    if (job === undefined) return;
    this.jobs.delete(jobId);
    job.gen += 1;
    await this.cleanup(job);
  }

  private async cleanup(job: Job): Promise<void> {
    // A written entry owns its key and connection. A reconnect's new connection is the tool's only once it is active.
    if (job.committed && (!job.reconnect || job.state === "active")) return;
    this.dropKey(job);
    if (job.ownConnection && job.connectionId !== undefined) await this.deleteQuiet(job.connectionId);
    job.connectionId = undefined;
    job.ownConnection = false;
  }

  /** A sign-in or a key that was never finished. The job stays for an hour as failed, so the dialog can say why. */
  private async expire(job: Job, error: string): Promise<void> {
    job.gen += 1;
    await this.cleanup(job);
    job.link = undefined;
    job.held = false;
    this.fail(job, error);
  }

  // ---- reconnect

  /** Reconnect from a tile's menu: the old connection is deleted, then a new sign-in link (or the key field) is shown. */
  async reconnect(toolId: string): Promise<string> {
    const entry = this.composioEntries().find((e) => idOf(e) === toolId);
    if (entry === undefined) throw new JobError(404, "No such tool.");
    const toolkit = String(entry.toolkit);
    let info: ToolkitInfo;
    try {
      info = await this.d.api.toolkitInfo(toolkit);
    } catch (e) {
      this.log(`describing ${toolkit} failed: ${message(e)}`);
      throw new JobError(502, `Composio could not load the settings for ${toolkit}. Try again in a moment.`);
    }
    // The entry says how it connects: a key it names, or the sign-in.
    const keyName = secretKeyOf(entry);
    if (entry.oauthApp !== undefined) throw new JobError(409, "This tool uses your own OAuth app: sign in again with /composio reconnect in a chat.");
    if (keyName === undefined && (entry.apiKey !== undefined || entry.fields !== undefined)) throw new JobError(409, "This tool uses several keys: replace them in Keys, then /composio reconnect in a chat.");
    if (keyName === undefined && authFor(info) === "none") throw new JobError(409, `${info.name} needs no connection.`);
    const auth: ConnectAuth = keyName !== undefined ? "key" : "oauth";
    const job: Job = {
      id: this.d.newId(),
      toolkit,
      name: info.name || toolkit,
      account: String(entry.account),
      ...(typeof entry.clot === "string" ? { clot: entry.clot } : {}),
      audience: entry.audience as ConfigureBody["audience"],
      selfIsUser: entry.selfIsUser === true,
      events: true,
      replaces: toolId,
      reconnect: true,
      auth,
      ...(keyName === undefined ? {} : { keyName }),
      keyWritten: false,
      state: "working",
      entry,
      ownConnection: false,
      held: false,
      committed: true,
      needsRestart: false,
      gen: 1,
      touched: this.d.now(),
    };
    this.jobs.set(job.id, job);
    this.set(job, "working");
    void (async () => {
      try {
        const problem = await this.d.forget(toolId);
        if (problem !== undefined) return this.fail(job, problem);
        if (job.auth === "key") return this.set(job, "key");
        await this.signIn(job, job.gen);
      } catch (e) {
        this.fail(job, message(e));
      }
    })();
    return job.id;
  }

  // ---- a Clot that is not made yet

  /** The held entries of these jobs for the Clot being created, or why they cannot be used. Nothing is consumed until `committed`. */
  claim(jobIds: string[], clot: string): { ok: true; entries: Record<string, unknown>[] } | { ok: false; error: string } {
    const entries: Record<string, unknown>[] = [];
    for (const id of jobIds) {
      const job = this.jobs.get(id);
      if (job === undefined || job.entry === undefined) return { ok: false, error: "A tool you connected was dropped after an hour. Connect it again." };
      if (job.committed || !job.held || job.clot === undefined || !sameClot(job.clot, clot)) return { ok: false, error: `${job.name} is not ready to be added to ${clot}.` };
      entries.push({ ...job.entry, clot });
    }
    return { ok: true, entries };
  }

  /** The Clot was created with these jobs' entries: they are written, and the jobs are done. */
  committed(jobIds: string[]): void {
    for (const id of jobIds) {
      const job = this.jobs.get(id);
      if (job === undefined) continue;
      job.committed = true;
      job.held = false;
      job.keyWritten = false;
      job.writtenId = `${job.toolkit}:${job.account}`;
      job.touched = this.d.now();
    }
  }

  // ---- time

  /**
   * The daemon calls this every few seconds: a sign-in is checked, one not finished in an hour is removed from Composio, and a job
   * an hour past its last change is forgotten (with what it made, if no tool uses it).
   */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (const job of [...this.jobs.values()]) {
        if (this.jobs.get(job.id) !== job) continue;
        try {
          await this.tickJob(job);
        } catch (e) {
          this.log(`checking ${job.toolkit}:${job.account} failed: ${message(e)}`);
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  private async tickJob(job: Job): Promise<void> {
    const now = this.d.now();
    if (job.state === "oauth" && job.connectionId !== undefined) {
      if (job.linkedAt !== undefined && now - job.linkedAt >= ABANDON_AFTER_MS) return this.expire(job, "The sign-in was not finished in an hour.");
      let status: string;
      try {
        status = (await this.d.api.connection(job.connectionId)).status;
      } catch (e) {
        if (isNotFound(e)) return this.fail(job, "The sign-in was removed at Composio. Go back and try again.");
        throw e;
      }
      if (job.state !== "oauth") return;
      if (status === "active") return this.signedIn(job);
      if (status === "failed" || status === "expired") return this.fail(job, "Composio could not complete the sign-in. Go back and try again.");
      return;
    }
    if (now - job.touched < HOUR_MS) return;
    if (job.state === "key") return this.expire(job, "The key was not entered in an hour.");
    if (job.held && !job.committed) {
      await this.expire(job, "The Clot was not created in an hour.");
      return;
    }
    if (job.state === "active" || job.state === "failed") {
      this.jobs.delete(job.id);
      await this.cleanup(job);
    }
  }
}
