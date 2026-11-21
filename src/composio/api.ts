import crypto from "node:crypto";
import { Composio } from "@composio/core";
import { toolkitInfoFrom, type AuthChoice, type ToolkitInfo } from "./auth.js";

/** The only file that imports @composio/core: everything above it is tested with a fake of ComposioApi. */

export type Connection = { id: string; status: "active" | "initiating" | "expired" | "failed" };
export type ToolInfo = { slug: string; toolkit: string; name: string; description: string; inputSchema: unknown; tags: string[] };
export type FailureReason = "cap" | "auth" | "unreachable" | "refused";
/** `timedOut`: the call did not answer in time, so a write may or may not have happened. */
/** `drift`: the tool answered, but not in the shape the daemon relies on (see `Composio.runChecked`). */
export type ExecResult = { ok: true; data: unknown } | { ok: false; error: string; reason: FailureReason; timedOut?: true; drift?: true };
/** A trigger instance Composio holds. */
export type TriggerInstance = { id: string; slug: string; connectionId: string; config: Record<string, unknown>; disabled: boolean };

export interface ComposioApi {
  /** What Composio says of the toolkit's ways of connecting. */
  toolkitInfo(slug: string): Promise<ToolkitInfo>;
  /**
   * The auth config for the choice: a managed or key one is adopted when it exists, else made; an `oauthApp` one is
   * always made, from the values `secrets` gives for the choice's `.env` keys, and is never shared or adopted.
   */
  ensureAuthConfig(toolkit: string, choice: AuthChoice, secrets: Record<string, string>): Promise<string>;
  /** Deletes an auth config the daemon made for an `oauthApp` that was replaced. */
  deleteAuthConfig(id: string): Promise<void>;
  /** The user's connection for the toolkit, preferring an active one. */
  findConnection(user: string, toolkit: string): Promise<Connection | undefined>;
  /** A key connection, active at once: the scheme and its fields by Composio's names, resolved to their values. */
  connectWithKey(user: string, authConfigId: string, scheme: string, fields: Record<string, string>): Promise<Connection>;
  linkManaged(user: string, authConfigId: string): Promise<{ redirectUrl: string; connectionId: string }>;
  connection(id: string): Promise<Connection>;
  deleteConnection(id: string): Promise<void>;
  /** The trigger instances on a connection. */
  listTriggers(connectionId: string): Promise<TriggerInstance[]>;
  /** Makes the instance, or adopts the one that has this slug and config. Returns its ID. */
  upsertTrigger(user: string, connectionId: string, slug: string, config: Record<string, unknown>, pollingMinutes?: number): Promise<string>;
  deleteTrigger(triggerId: string): Promise<void>;
  triggerState(triggerId: string): Promise<"active" | "disabled" | "missing">;
  /** The project's webhook subscription, if there is one. */
  webhook(): Promise<{ url: string; secret?: string } | undefined>;
  /** Points the subscription at the URL, making it if there is none. The secret is returned when Composio gives it. */
  setWebhook(url: string): Promise<{ secret?: string }>;
  rotateWebhookSecret(): Promise<{ secret: string }>;
  tool(slug: string): Promise<ToolInfo | undefined>;
  search(toolkit: string, query: string): Promise<ToolInfo[]>;
  /** A toolkit's tools, for `composio_toolkit`. At most `limit`. */
  toolkitTools(toolkit: string, limit: number): Promise<ToolInfo[]>;
  /** A toolkit's trigger types: each trigger's slug and whether Composio delivers it by webhook or polls for it. */
  toolkitTriggers(toolkit: string): Promise<{ slug: string; type: "webhook" | "poll" }[]>;
  /** One trigger type's details: its config schema and the schema of the payload it delivers. Undefined for an unknown slug. */
  triggerType(slug: string): Promise<{ slug: string; name: string; type: string; config: unknown; payload: unknown } | undefined>;
  execute(user: string, toolkit: string, slug: string, args: Record<string, unknown>): Promise<ExecResult>;
}

/** What a hung call is given before it is abandoned. */
export const CALL_TIMEOUT_MS = 30_000;

export class TimeoutError extends Error {
  constructor(what: string) {
    super(`${what} did not answer within ${CALL_TIMEOUT_MS / 1000} seconds`);
    this.name = "TimeoutError";
  }
}

async function timed<T>(what: string, work: Promise<T>, ms = CALL_TIMEOUT_MS): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new TimeoutError(what)), ms)))]);
  } finally {
    clearTimeout(timer);
  }
}

/** Composio's own monthly quota wording: the plan's allowance is used up. A per-minute rate limit is not it. */
const MONTHLY_QUOTA = /quota|usage limit|monthly|plan limit|limit (has been )?reached/i;

/**
 * How a thrown error reads to the daemon. Composio's monthly quota is `cap`; a rejected key, an expired
 * connection or a session with no active connection is `auth`; the network, a timeout, a 5xx and Composio's
 * own per-minute rate limit (a 429 that is not the quota) are `unreachable`, to be tried again later; anything
 * else, a refusal.
 */
export function classifyComposioError(e: unknown): FailureReason {
  const text = e instanceof Error ? e.message : String(e);
  const status = Number((e as { status?: unknown } | null)?.status ?? (e as { statusCode?: unknown } | null)?.statusCode);
  if (e instanceof TimeoutError) return "unreachable";
  if (MONTHLY_QUOTA.test(text) && !/rate.?limit/i.test(text)) return "cap";
  if (status === 429 || /rate.?limit|too many requests/i.test(text)) return "unreachable";
  if (status === 401 || status === 403 || /ToolRouterV2_NoActiveConnection|APIKey_Invalid|expired|revoked|no active connection/i.test(text)) return "auth";
  if (status >= 500 || /ECONN|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|fetch failed|network|socket hang up/i.test(text)) return "unreachable";
  return "refused";
}

/**
 * How a tool that answered `failed` reads: the service's own status code decides, and none of it is Composio's
 * monthly cap. A service that rate-limits (429, or says so) is a call to be tried again later, `unreachable`, so an
 * undo keeps its place for the next time; it is never "Composio's free monthly limit is reached". A 401 is the
 * service rejecting the connection's credentials (`auth`: replace the key or sign in again); a 403 is the service
 * refusing this one request (a private subreddit, a missing scope), which says nothing about the connection, so it is
 * `refused`.
 */
export function classifyFailedResult(statusCode: unknown, text: string): FailureReason {
  const status = Number(statusCode);
  if (status === 401) return "auth";
  if (status === 429 || status >= 500 || /rate.?limit|too many requests|quota/i.test(text)) return "unreachable";
  return "refused";
}

const toConnection = (item: any): Connection => {
  const status = String(item?.status ?? "").toUpperCase();
  return { id: item.id, status: status === "ACTIVE" ? "active" : status === "EXPIRED" ? "expired" : status === "FAILED" || status === "INACTIVE" || status === "DELETED" ? "failed" : "initiating" };
};

const toTool = (t: any): ToolInfo => ({ slug: t.slug, toolkit: String(t.toolkit?.slug ?? "").toLowerCase(), name: t.name ?? t.slug, description: t.description ?? "", inputSchema: t.inputParameters, tags: t.tags ?? [] });

/** Whether an instance's config holds every value the wanted config names (Composio adds defaults of its own). */
const sameConfig = (have: Record<string, unknown>, want: Record<string, unknown>) => Object.entries(want).every(([k, v]) => JSON.stringify(have?.[k]) === JSON.stringify(v));

export function sdkComposioApi(apiKey: string): ComposioApi {
  const composio: any = new Composio({ apiKey });
  const connectionOf = new Map<string, string>();
  const sessions = new Map<string, any>();

  const remember = (user: string, c: Connection) => {
    connectionOf.set(user, c.id);
    return c;
  };
  const activeInstances = async (): Promise<TriggerInstance[]> => {
    const out: TriggerInstance[] = [];
    let cursor: string | undefined;
    do {
      const page: any = await timed("listing triggers", composio.triggers.listActive(cursor ? { cursor } : {}));
      for (const i of page.items ?? []) out.push({ id: i.id, slug: i.triggerName, connectionId: i.connectedAccountId, config: i.triggerConfig ?? {}, disabled: i.disabledAt != null });
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    return out;
  };

  const api: ComposioApi = {
    async toolkitInfo(slug) {
      return toolkitInfoFrom(await timed("reading a toolkit", composio.toolkits.get(slug)));
    },

    async ensureAuthConfig(toolkit, choice, secrets) {
      if (choice.kind === "none") throw new Error(`${toolkit} needs no auth config`);
      if (choice.kind === "oauthApp") {
        const created: any = await timed(
          "creating an auth config",
          composio.authConfigs.create(toolkit, { type: "use_custom_auth", authScheme: "OAUTH2", credentials: { client_id: secrets[choice.clientId], client_secret: secrets[choice.clientSecret] } }),
        );
        return created.id;
      }
      const list: any = await timed("listing auth configs", composio.authConfigs.list({ toolkit }));
      const managed = choice.kind === "managed";
      const scheme = choice.kind === "key" ? choice.scheme : "";
      const found = (list.items ?? []).find((c: any) => (managed ? c.isComposioManaged === true : c.authScheme === scheme && c.isComposioManaged !== true) && c.status !== "DISABLED");
      if (found) return found.id;
      const created: any = await timed(
        "creating an auth config",
        managed ? composio.authConfigs.create(toolkit, { type: "use_composio_managed_auth" }) : composio.authConfigs.create(toolkit, { type: "use_custom_auth", authScheme: scheme, credentials: {} }),
      );
      return created.id;
    },

    async deleteAuthConfig(id) {
      await timed("deleting an auth config", composio.authConfigs.delete(id));
    },

    async findConnection(user, toolkit) {
      const list: any = await timed("listing connections", composio.connectedAccounts.list({ userIds: [user], toolkitSlugs: [toolkit] }));
      const items: any[] = list.items ?? [];
      const item = items.find((c) => c.status === "ACTIVE") ?? items[0];
      return item ? remember(user, toConnection(item)) : undefined;
    },

    // `allowMultiple`: a changed key connects the new key while the old connection still exists (the old one is deleted last),
    // and Composio refuses a second connection for the same user without it.
    async connectWithKey(user, authConfigId, scheme, fields) {
      // What the SDK's AuthScheme helpers build, for any scheme: the scheme's name and the fields, active at once.
      const request: any = await timed("connecting", composio.connectedAccounts.initiate(user, authConfigId, { config: { authScheme: scheme, val: { status: "ACTIVE", ...fields } } as any, allowMultiple: true }));
      const connection = request.status === "ACTIVE" ? toConnection(request) : toConnection(await timed("waiting for the connection", composio.connectedAccounts.waitForConnection(request.id, 20_000)));
      return remember(user, connection);
    },

    async linkManaged(user, authConfigId) {
      const request: any = await timed("making a sign-in link", composio.connectedAccounts.link(user, authConfigId));
      // No pin is made here. While a replacement sign-in is pending, a call finds the active connection (the pin is empty
      // after a restart, and `findConnection` prefers an active one over the initiating one); once the old connection is
      // deleted the pin is cleared and the next call finds the new one.
      return { redirectUrl: request.redirectUrl, connectionId: request.id };
    },

    async connection(id) {
      return toConnection(await timed("reading a connection", composio.connectedAccounts.get(id)));
    },

    async deleteConnection(id) {
      await timed("deleting a connection", composio.connectedAccounts.delete(id));
      for (const [user, pinned] of connectionOf) if (pinned === id) connectionOf.delete(user);
    },

    async listTriggers(connectionId) {
      return (await activeInstances()).filter((i) => i.connectionId === connectionId);
    },

    async upsertTrigger(user, connectionId, slug, config, pollingMinutes) {
      const same = (await api.listTriggers(connectionId)).filter((i) => i.slug === slug && sameConfig(i.config, config));
      const [keep, ...extras] = same;
      for (const extra of extras) await api.deleteTrigger(extra.id);
      if (keep && !keep.disabled) return keep.id;
      if (keep) await api.deleteTrigger(keep.id);
      const created: any = await timed("creating a trigger", composio.triggers.create(user, slug, { connectedAccountId: connectionId, triggerConfig: config, ...(pollingMinutes === undefined ? {} : { pollingInterval: pollingMinutes }) }));
      return created.triggerId;
    },

    async deleteTrigger(triggerId) {
      await timed("deleting a trigger", composio.triggers.delete(triggerId));
    },

    async triggerState(triggerId) {
      const found = (await activeInstances()).find((i) => i.id === triggerId);
      return found === undefined ? "missing" : found.disabled ? "disabled" : "active";
    },

    async webhook() {
      const list: any = await timed("reading the webhook subscription", composio.webhooks.subscriptions.list());
      const sub = (list.items ?? [])[0];
      return sub ? { url: sub.webhookUrl, ...(sub.secret ? { secret: sub.secret } : {}) } : undefined;
    },

    async setWebhook(url) {
      const sub: any = await timed("setting the webhook subscription", composio.triggers.setWebhookSubscription({ webhookUrl: url, enabledEvents: ["composio.trigger.message", "composio.trigger.disabled", "composio.connected_account.expired"] }));
      return sub?.secret ? { secret: sub.secret } : {};
    },

    async rotateWebhookSecret() {
      const list: any = await timed("reading the webhook subscription", composio.webhooks.subscriptions.list());
      const sub = (list.items ?? [])[0];
      if (!sub) throw new Error("there is no webhook subscription to rotate");
      const rotated: any = await timed("rotating the webhook secret", composio.webhooks.subscriptions.rotateSecret(sub.id));
      return { secret: rotated.secret };
    },

    async tool(slug) {
      try {
        return toTool(await timed("reading a tool", composio.tools.getRawComposioToolBySlug(slug)));
      } catch (e) {
        if (/not.?found|404/i.test(e instanceof Error ? e.message : "") || (e as { status?: number })?.status === 404) return undefined;
        throw e;
      }
    },

    async search(toolkit, query) {
      const tools: any[] = await timed("searching tools", composio.tools.getRawComposioTools({ toolkits: [toolkit], search: query, limit: 10 }));
      return tools.map(toTool);
    },

    async toolkitTools(toolkit, limit) {
      const tools: any[] = await timed("listing a toolkit's tools", composio.tools.getRawComposioTools({ toolkits: [toolkit], limit }));
      return tools.map(toTool);
    },

    async toolkitTriggers(toolkit) {
      const page: any = await timed("listing trigger types", composio.triggers.listTypes({ toolkits: [toolkit], limit: 100 }));
      return (page.items ?? []).map((t: any) => ({ slug: t.slug, type: t.type === "poll" ? "poll" : "webhook" }));
    },

    async triggerType(slug) {
      try {
        const t: any = await timed("reading a trigger type", composio.triggers.getType(slug));
        return { slug: t.slug, name: t.name ?? t.slug, type: String(t.type ?? ""), config: t.config, payload: t.payload };
      } catch (e) {
        if (/not.?found|404/i.test(e instanceof Error ? e.message : "") || (e as { status?: number })?.status === 404) return undefined;
        throw e;
      }
    },

    async execute(user, toolkit, slug, args) {
      try {
        let connectionId = connectionOf.get(user);
        if (connectionId === undefined) connectionId = (await api.findConnection(user, toolkit))?.id;
        const key = `${user}|${connectionId}`;
        let session = sessions.get(key);
        if (session === undefined) {
          // The pin is what lets a session find a key connection; the sandbox is off, since the Clots have computers of their own.
          session = await timed("making a session", composio.create(user, { toolkits: [toolkit], sandbox: { enable: false }, ...(connectionId ? { connectedAccounts: { [toolkit]: connectionId } } : {}) }));
          sessions.set(key, session);
        }
        const result: any = await timed(`running ${slug}`, session.execute(slug, args));
        if (result?.resultType === "completed" && !result.error) return { ok: true, data: result.data };
        const text = String(result?.error ?? result?.data?.message ?? "the tool failed");
        return { ok: false, error: text, reason: classifyFailedResult(result?.data?.status_code, text) };
      } catch (e) {
        const text = e instanceof Error ? e.message : String(e);
        return { ok: false, error: text, reason: classifyComposioError(e), ...(e instanceof TimeoutError ? { timedOut: true as const } : {}) };
      }
    },
  };
  return api;
}

/** A stable short key for a trigger instance's config, so one slug can run once per team. */
export function configKey(config: Record<string, unknown>): string {
  const sorted = JSON.stringify(Object.fromEntries(Object.entries(config).sort(([a], [b]) => (a < b ? -1 : 1))));
  return crypto.createHash("sha256").update(sorted).digest("hex").slice(0, 16);
}

export { keyHash } from "./auth.js";
