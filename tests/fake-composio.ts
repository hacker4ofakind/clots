import fs from "node:fs";
import type { ComposioApi, Connection, ExecResult, ToolInfo, ToolkitSummary, TriggerInstance } from "../src/composio/api.js";
import type { AuthChoice, ToolkitInfo } from "../src/composio/auth.js";

/** Composio's recorded metadata for a toolkit (tests/fixtures/composio/meta). */
export const toolkitMeta = (slug: string): { info: ToolkitInfo; triggers: { slug: string; type: string; config?: unknown }[] } => JSON.parse(fs.readFileSync(new URL(`./fixtures/composio/meta/${slug}.json`, import.meta.url), "utf8"));

/** A fake of the Composio API that records what it is asked and keeps what it is given, for every test above the seam. */
export class FakeComposioApi implements ComposioApi {
  /** Every call, in order, as `method:detail`. */
  calls: string[] = [];
  authConfigs = new Map<string, string>();
  connections = new Map<string, Connection & { user: string; key?: string; toolkit: string }>();
  triggers = new Map<string, TriggerInstance & { user: string }>();
  subscription: { url: string; secret?: string } | undefined;
  tools = new Map<string, ToolInfo>();
  /** What `execute` answers for a slug; anything else answers ok with an empty object. */
  answers = new Map<string, ExecResult | ((args: Record<string, unknown>) => ExecResult)>();
  /** Methods that throw once, by name: `failNext.set("connectWithKey", new Error("down"))`. */
  failNext = new Map<string, Error>();
  /** Triggers the next `triggerState` call calls disabled, by ID. */
  disabled = new Set<string>();
  private n = 0;

  private id(prefix: string): string {
    this.n += 1;
    return `${prefix}_${this.n}`;
  }

  private enter(method: string, detail = ""): void {
    this.calls.push(detail === "" ? method : `${method}:${detail}`);
    const error = this.failNext.get(method);
    if (error) {
      this.failNext.delete(method);
      throw error;
    }
  }

  /** The calls to one method. */
  of(method: string): string[] {
    return this.calls.filter((c) => c === method || c.startsWith(`${method}:`));
  }

  /** Toolkits whose metadata is read from a fixture; a test can put its own in `meta`. */
  meta = new Map<string, ToolkitInfo>();
  /** Auth configs deleted, by ID. */
  deletedAuthConfigs: string[] = [];

  /** What `listToolkits` answers. */
  toolkitList: ToolkitSummary[] = [];

  async listToolkits(): Promise<ToolkitSummary[]> {
    this.enter("listToolkits");
    return this.toolkitList;
  }

  async toolkitInfo(slug: string): Promise<ToolkitInfo> {
    this.enter("toolkitInfo", slug);
    return this.meta.get(slug) ?? toolkitMeta(slug).info;
  }

  async ensureAuthConfig(toolkit: string, choice: AuthChoice, _secrets: Record<string, string>): Promise<string> {
    const scheme = choice.kind === "key" ? choice.scheme : choice.kind === "managed" ? "MANAGED" : "OAUTH_APP";
    this.enter("ensureAuthConfig", `${toolkit}/${scheme}`);
    const key = `${toolkit}/${scheme}`;
    // An OAuth app's auth config is the account's own, made anew each time; the others are adopted.
    if (choice.kind === "oauthApp") return this.id("ac");
    if (!this.authConfigs.has(key)) this.authConfigs.set(key, this.id("ac"));
    return this.authConfigs.get(key)!;
  }

  async deleteAuthConfig(id: string): Promise<void> {
    this.enter("deleteAuthConfig", id);
    this.deletedAuthConfigs.push(id);
  }

  async findConnection(user: string, toolkit: string): Promise<Connection | undefined> {
    this.enter("findConnection", user);
    const found = [...this.connections.values()].filter((c) => c.user === user && c.toolkit === toolkit);
    const c = found.find((x) => x.status === "active") ?? found[0];
    return c && { id: c.id, status: c.status };
  }

  async connectWithKey(user: string, _authConfigId: string, scheme: string, fields: Record<string, string>): Promise<Connection> {
    const { generic_api_key: key, ...extra } = fields;
    this.enter("connectWithKey", `${user}${Object.keys(extra).length > 0 || scheme !== "API_KEY" || key === undefined ? " " + JSON.stringify({ ...(scheme === "API_KEY" ? {} : { scheme }), ...extra, ...(key === undefined ? {} : { generic_api_key: "…" }) }) : ""}`);
    const c = { id: this.id("ca"), status: "active" as const, user, key: key ?? JSON.stringify(fields), toolkit: user.split(":")[0] };
    this.connections.set(c.id, c);
    return { id: c.id, status: c.status };
  }

  async linkManaged(user: string): Promise<{ redirectUrl: string; connectionId: string }> {
    this.enter("linkManaged", user);
    const c = { id: this.id("ca"), status: "initiating" as const, user, toolkit: user.split(":")[0] };
    this.connections.set(c.id, c);
    return { redirectUrl: `https://connect.example/link/${c.id}`, connectionId: c.id };
  }

  async connection(id: string): Promise<Connection> {
    this.enter("connection", id);
    const c = this.connections.get(id);
    if (!c) throw Object.assign(new Error(`404 Connected account "${id}" not found`), { status: 404 });
    return { id: c.id, status: c.status };
  }

  async deleteConnection(id: string): Promise<void> {
    this.enter("deleteConnection", id);
    this.connections.delete(id);
    for (const [tid, t] of this.triggers) if (t.connectionId === id) this.triggers.delete(tid);
  }

  async listTriggers(connectionId: string): Promise<TriggerInstance[]> {
    this.enter("listTriggers", connectionId);
    return [...this.triggers.values()].filter((t) => t.connectionId === connectionId);
  }

  async upsertTrigger(user: string, connectionId: string, slug: string, config: Record<string, unknown>, pollingMinutes?: number): Promise<string> {
    this.enter("upsertTrigger", `${user} ${slug} ${JSON.stringify(config)}${pollingMinutes ? ` every ${pollingMinutes}m` : ""}`);
    const have = [...this.triggers.values()].find((t) => t.connectionId === connectionId && t.slug === slug && JSON.stringify(t.config) === JSON.stringify(config) && !this.disabled.has(t.id));
    if (have) return have.id;
    const id = this.id("ti");
    this.triggers.set(id, { id, slug, connectionId, config, disabled: false, user });
    return id;
  }

  async deleteTrigger(triggerId: string): Promise<void> {
    this.enter("deleteTrigger", triggerId);
    this.triggers.delete(triggerId);
    this.disabled.delete(triggerId);
  }

  async triggerState(triggerId: string): Promise<"active" | "disabled" | "missing"> {
    this.enter("triggerState", triggerId);
    if (!this.triggers.has(triggerId)) return "missing";
    return this.disabled.has(triggerId) ? "disabled" : "active";
  }

  async webhook(): Promise<{ url: string; secret?: string } | undefined> {
    this.enter("webhook");
    return this.subscription && { ...this.subscription };
  }

  async setWebhook(url: string): Promise<{ secret?: string }> {
    this.enter("setWebhook", url);
    const secret = this.subscription?.secret ?? `whsec_${this.id("s")}`;
    this.subscription = { url, secret };
    return { secret };
  }

  async rotateWebhookSecret(): Promise<{ secret: string }> {
    this.enter("rotateWebhookSecret");
    const secret = `whsec_${this.id("s")}`;
    this.subscription = { ...(this.subscription ?? { url: "" }), secret };
    return { secret };
  }

  async tool(slug: string): Promise<ToolInfo | undefined> {
    this.enter("tool", slug);
    return this.tools.get(slug);
  }

  async search(toolkit: string, query: string): Promise<ToolInfo[]> {
    this.enter("search", `${toolkit} ${query}`);
    return [...this.tools.values()].filter((t) => t.toolkit === toolkit && (t.slug + t.name + t.description).toLowerCase().includes(query.toLowerCase()));
  }

  /** Trigger types by toolkit, when a test wants others than the recorded ones. */
  triggerTypes = new Map<string, { slug: string; type: "webhook" | "poll" }[]>();
  /** Trigger type details by slug. */
  triggerDetails = new Map<string, { slug: string; name: string; type: string; config: unknown; payload: unknown }>();

  async toolkitTools(toolkit: string, limit: number): Promise<ToolInfo[]> {
    this.enter("toolkitTools", toolkit);
    return [...this.tools.values()].filter((t) => t.toolkit === toolkit).slice(0, limit);
  }

  async toolkitTriggers(toolkit: string): Promise<{ slug: string; type: "webhook" | "poll" }[]> {
    this.enter("toolkitTriggers", toolkit);
    return this.triggerTypes.get(toolkit) ?? toolkitMeta(toolkit).triggers.map((t) => ({ slug: t.slug, type: t.type === "poll" ? ("poll" as const) : ("webhook" as const) }));
  }

  async triggerType(slug: string): Promise<{ slug: string; name: string; type: string; config: unknown; payload: unknown } | undefined> {
    this.enter("triggerType", slug);
    return this.triggerDetails.get(slug);
  }

  async execute(user: string, toolkit: string, slug: string, args: Record<string, unknown>): Promise<ExecResult> {
    this.enter("execute", `${user} ${slug} ${JSON.stringify(args)}`);
    const answer = this.answers.get(slug);
    if (typeof answer === "function") return answer(args);
    return answer ?? { ok: true, data: {} };
  }
}

/** A tool as Composio describes it. */
export function tool(slug: string, tags: string[], over: Partial<ToolInfo> = {}): ToolInfo {
  const toolkit = slug.split("_")[0].toLowerCase();
  return { slug, toolkit, name: slug.toLowerCase().replace(/_/g, " "), description: `Does ${slug}.`, inputSchema: { type: "object", properties: {} }, tags, ...over };
}
