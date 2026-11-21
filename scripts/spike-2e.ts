// Stage 2e live probes for the assumptions in spec section 16, plus the slugs and shapes the build
// names "confirmed in Task 1". Every step prints PASS/FAIL lines or the raw evidence; nothing prints a key.
// The SDK is used raw: the daemon's own wrapper (src/composio/api.ts) does not exist yet.
//
// Run: node --env-file=.env --import tsx scripts/spike-2e.ts <step> [arguments]
//   offline                      what needs no network: verifyWebhook, the sandbox-off option
//   catalog                      every tool (slug, tags) and trigger type of the five toolkits -> .spike-2e/catalog.json
//   webhook <publicUrl>          points the project's webhook subscription at <publicUrl>/webhooks/composio
//   connect <toolkit>            connects spike:<toolkit> (a key from .env, or a sign-in link for googlecalendar; posthog also reads POSTHOG_SUBDOMAIN, "us" or "eu")
//   trigger <toolkit> <slug> [configJson]   creates a trigger instance on that connection
//   exec <toolkit> <slug> [argsJson]        runs one tool through a session with the sandbox off
//   calendar                     assumption 6: creates a repeating event, lists occurrences, cancels one, deletes the series, deletes everything it made
//   triggers                     lists the trigger instances of every spike user
//   cleanup [toolkit]            deletes every trigger, connection and auth config the spike made
// Follow-up (any toolkit) steps:
//   toolkit <slug> [--save]      prints Composio's metadata for a toolkit as the daemon reads it (ToolkitInfo, trigger types, one trigger's payload schema); --save writes tests/fixtures/composio/meta/<slug>.json
//   link <slug> [triggerSlug configJson]   makes a managed sign-in link for user spike:<slug>, waits for the sign-in, makes the trigger when one is given, and waits for you to press Ctrl+C; then deletes its trigger, connection and the sign-in's leftovers
import crypto from "node:crypto";
import fs from "node:fs";
import { AuthScheme, Composio, ToolRouterCreateSessionConfigSchema } from "@composio/core";
import { toolkitInfoFrom } from "../src/composio/auth.js";

const OUT = ".spike-2e";
fs.mkdirSync(OUT, { recursive: true });

/** Which .env key holds the service key for each key-based toolkit. */
const KEY_ENV: Record<string, string> = {
  linear: "LINEAR_PROTON_KEY",
  notion: "NOTION_CONNECTION_API_KEY",
  stripe: "STRIPE_ENCRYPTIFY_KEY",
  posthog: "POSTHOG_ENCRYPTIFY_KEY",
};
const MANAGED = new Set(["googlecalendar"]);
const TOOLKITS = ["linear", "notion", "stripe", "googlecalendar", "posthog"];
const userOf = (toolkit: string) => `spike:${toolkit}`;

const apiKey = process.env.COMPOSIO_API_KEY;
// The step "offline" must not touch the network: point the client at a closed port.
const composio: any = new Composio({ apiKey: apiKey ?? "offline", ...(apiKey ? {} : { baseURL: "http://127.0.0.1:9" }) });

const results: [string, boolean][] = [];
const check = (name: string, passed: boolean, detail = "") => {
  results.push([name, passed]);
  console.log(passed ? "PASS" : "FAIL", name, detail);
};
const show = (label: string, value: unknown) => console.log(`${label}: ${JSON.stringify(value, null, 2)}`);
/** What an error looks like, for classifyComposioError's table. Never the request, which can hold a key. */
const describe = (e: any) => ({ name: e?.name, message: e?.message, status: e?.status ?? e?.statusCode, code: e?.code, error: e?.error, cause: e?.cause?.message });
async function attempt<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (e) {
    console.log(`ERROR in ${label}:`, JSON.stringify(describe(e), null, 2));
    return undefined;
  }
}
const need = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set in .env`);
  return value;
};

async function ensureAuthConfig(toolkit: string): Promise<string> {
  const existing = await composio.authConfigs.list({ toolkit });
  const items: any[] = existing.items ?? [];
  const want = MANAGED.has(toolkit) ? (c: any) => c.isComposioManaged === true : (c: any) => c.authScheme === "API_KEY" && c.isComposioManaged !== true;
  const found = items.find(want);
  if (found) return found.id;
  const created = MANAGED.has(toolkit)
    ? await composio.authConfigs.create(toolkit, { type: "use_composio_managed_auth" })
    : await composio.authConfigs.create(toolkit, { type: "use_custom_auth", authScheme: "API_KEY", credentials: {} });
  console.log(`created auth config ${created.id} for ${toolkit}`);
  return created.id;
}

async function connection(toolkit: string): Promise<any | undefined> {
  const list = await composio.connectedAccounts.list({ userIds: [userOf(toolkit)], toolkitSlugs: [toolkit] });
  return (list.items ?? []).find((c: any) => c.status === "ACTIVE") ?? (list.items ?? [])[0];
}

async function connect(toolkit: string) {
  const authConfigId = await ensureAuthConfig(toolkit);
  show("auth config", authConfigId);
  if (MANAGED.has(toolkit)) {
    const request = await composio.connectedAccounts.link(userOf(toolkit), authConfigId);
    console.log(`\nSIGN IN HERE: ${request.redirectUrl}\n(waiting up to 10 minutes)`);
    const account = await composio.connectedAccounts.waitForConnection(request.id, 10 * 60_000);
    show("connection", { id: account.id, status: account.status });
    return;
  }
  const key = need(KEY_ENV[toolkit] ?? "");
  const request = await composio.connectedAccounts.initiate(userOf(toolkit), authConfigId, { config: AuthScheme.APIKey({ generic_api_key: key, ...(toolkit === "posthog" ? { subdomain: process.env.POSTHOG_SUBDOMAIN ?? "us" } : {}) } as any) });
  show("connection request", { id: request.id, status: request.status });
  const account = request.status === "ACTIVE" ? request : await composio.connectedAccounts.waitForConnection(request.id, 60_000);
  show("connection", { id: account.id, status: account.status });
}

async function session(toolkit: string) {
  // A session finds a key connection only when told which one: connectedAccounts pins it.
  const account = await connection(toolkit);
  const config: any = { toolkits: [toolkit], sandbox: { enable: false }, ...(account ? { connectedAccounts: { [toolkit]: account.id } } : {}) };
  ToolRouterCreateSessionConfigSchema.parse(config);
  return composio.create(userOf(toolkit), config);
}

const save = process.argv.includes("--save");
const args = process.argv.filter((a) => a !== "--save");
const step = args[2];
const [toolkit, slug, json] = args.slice(3);

if (step === "offline") {
  const secret = "whsec_test";
  const payload = JSON.stringify({
    id: "msg_1",
    timestamp: new Date().toISOString(),
    type: "composio.trigger.message",
    metadata: { log_id: "log_1", trigger_slug: "LINEAR_PUBLIC_TEAM_ISSUE_CREATED", trigger_id: "ti_1", connected_account_id: "ca_1", auth_config_id: "ac_1", user_id: "linear:proton" },
    data: { id: "issue-1" },
  });
  const id = "msg_1";
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = "v1," + crypto.createHmac("sha256", secret).update(`${id}.${timestamp}.${payload}`).digest("base64");
  const good = await attempt("verifyWebhook good", () => composio.triggers.verifyWebhook({ payload, signature, id, timestamp, secret }));
  check("verifyWebhook accepts a good signature with no network", good !== undefined, JSON.stringify(good)?.slice(0, 200));
  let rejected = false;
  try {
    await composio.triggers.verifyWebhook({ payload, signature: "v1,AAAA", id, timestamp, secret });
  } catch (e) {
    rejected = true;
    console.log("bad signature error:", describe(e));
  }
  check("verifyWebhook rejects a bad signature", rejected);
  let stale = false;
  try {
    const old = String(Math.floor(Date.now() / 1000) - 301);
    const s = "v1," + crypto.createHmac("sha256", secret).update(`${id}.${old}.${payload}`).digest("base64");
    await composio.triggers.verifyWebhook({ payload, signature: s, id, timestamp: old, secret });
  } catch {
    stale = true;
  }
  check("verifyWebhook rejects a 301-second-old timestamp", stale);
  let sandboxOk = true;
  try {
    ToolRouterCreateSessionConfigSchema.parse({ toolkits: ["linear"], sandbox: { enable: false } });
  } catch (e) {
    sandboxOk = false;
    console.log(describe(e));
  }
  check("the session config accepts sandbox: { enable: false }", sandboxOk);
} else if (step === "catalog") {
  if (!apiKey) throw new Error("COMPOSIO_API_KEY is not set in .env");
  const catalog: Record<string, any> = {};
  for (const t of TOOLKITS) {
    const tools = await attempt(`tools ${t}`, () => composio.tools.getRawComposioTools({ toolkits: [t], limit: 1000 }));
    const triggers = await attempt(`trigger types ${t}`, () => composio.triggers.listTypes({ toolkits: [t], limit: 100 }));
    catalog[t] = {
      tools: ((tools as any[]) ?? []).map((x) => ({ slug: x.slug, name: x.name, tags: x.tags, description: String(x.description ?? "").slice(0, 160) })),
      triggers: ((triggers as any)?.items ?? []).map((x: any) => ({ slug: x.slug, name: x.name, type: x.type, config: x.config })),
    };
    console.log(`${t}: ${catalog[t].tools.length} tools, ${catalog[t].triggers.length} trigger types`);
  }
  fs.writeFileSync(`${OUT}/catalog.json`, JSON.stringify(catalog, null, 2));
  console.log(`written to ${OUT}/catalog.json`);
} else if (step === "webhook") {
  if (!apiKey) throw new Error("COMPOSIO_API_KEY is not set in .env");
  const url = `${toolkit.replace(/\/$/, "")}/webhooks/composio`;
  show("event types offered", await attempt("listEventTypes", () => composio.webhooks.subscriptions.listEventTypes()));
  show("subscriptions before", ((await attempt("list", () => composio.webhooks.subscriptions.list())) as any)?.items?.map((s: any) => ({ id: s.id, url: s.webhookUrl, events: s.enabledEvents, version: s.version, hasSecret: Boolean(s.secret) })));
  const set = await attempt("set subscription", () =>
    composio.triggers.setWebhookSubscription({
      webhookUrl: url,
      enabledEvents: ["composio.trigger.message", "composio.trigger.disabled", "composio.connected_account.expired"],
    }),
  );
  show("subscription after", set && { id: (set as any).id, url: (set as any).webhookUrl, events: (set as any).enabledEvents, version: (set as any).version, secretReturned: Boolean((set as any).secret) });
  check("the webhook subscription can be set to the public URL", set !== undefined);
} else if (step === "connect") {
  await connect(toolkit);
} else if (step === "trigger") {
  const account = await connection(toolkit);
  if (!account) throw new Error(`no connection for ${toolkit}: run connect ${toolkit} first`);
  const created = await attempt("trigger create", () => composio.triggers.create(userOf(toolkit), slug, { connectedAccountId: account.id, triggerConfig: json ? JSON.parse(json) : {} }));
  show("trigger instance", created);
} else if (step === "exec") {
  const s = await session(toolkit);
  const result = await attempt("execute", () => s.execute(slug, json ? JSON.parse(json) : {}));
  show("result", result);
} else if (step === "calendar") {
  const s = await session("googlecalendar");
  const run = async (slug: string, args: Record<string, unknown>) => {
    const r: any = await attempt(slug, () => s.execute(slug, args));
    return r;
  };
  const day = new Date(Date.now() + 36 * 3600_000).toISOString().slice(0, 10);
  const created: any = await run("GOOGLECALENDAR_CREATE_EVENT", {
    calendar_id: "primary",
    summary: "Clots Composio probe",
    start_datetime: `${day}T10:00:00`,
    end_datetime: `${day}T11:00:00`,
    timezone: "Africa/Johannesburg",
    recurrence: ["RRULE:FREQ=DAILY;COUNT=3"],
    create_meeting_room: false,
  });
  show("create result", created);
  const seriesId = created?.data?.data?.id ?? created?.data?.response_data?.id ?? created?.data?.id;
  console.log("series id:", seriesId);
  const from = new Date().toISOString();
  const to = new Date(Date.now() + 6 * 86400_000).toISOString();
  const list: any = await run("GOOGLECALENDAR_EVENTS_LIST", { calendarId: "primary", singleEvents: true, orderBy: "startTime", timeMin: from, timeMax: to, maxResults: 250, q: undefined });
  const items: any[] = list?.data?.items ?? list?.data?.data?.items ?? list?.data?.response_data?.items ?? [];
  const mine = items.filter((e) => e.summary === "Clots Composio probe");
  show("occurrences with the probe title", mine.map((e) => ({ id: e.id, recurringEventId: e.recurringEventId, iCalUID: e.iCalUID, originalStartTime: e.originalStartTime, start: e.start, status: e.status })));
  check("the list expands a repeating event into occurrences with the series ID", mine.length >= 2 && mine.every((e) => e.recurringEventId === seriesId));
  const first = mine[0];
  if (first) {
    await run("GOOGLECALENDAR_DELETE_EVENT", { calendar_id: "primary", event_id: first.id, send_updates: "none" });
    show("get of the cancelled occurrence", await run("GOOGLECALENDAR_EVENTS_GET", { calendar_id: "primary", event_id: first.id }));
    const again: any = await run("GOOGLECALENDAR_EVENTS_LIST", { calendarId: "primary", singleEvents: true, orderBy: "startTime", timeMin: from, timeMax: to, maxResults: 250 });
    const left = ((again?.data?.items ?? again?.data?.data?.items ?? again?.data?.response_data?.items ?? []) as any[]).filter((e) => e.summary === "Clots Composio probe");
    show("occurrences after cancelling one (default list)", left.map((e) => ({ id: e.id, status: e.status })));
    const withDeleted: any = await run("GOOGLECALENDAR_EVENTS_LIST", { calendarId: "primary", singleEvents: true, showDeleted: true, timeMin: from, timeMax: to, maxResults: 250 });
    show("same with showDeleted", ((withDeleted?.data?.items ?? withDeleted?.data?.data?.items ?? withDeleted?.data?.response_data?.items ?? []) as any[]).filter((e) => e.summary === "Clots Composio probe").map((e) => ({ id: e.id, status: e.status })));
  }
  if (seriesId) {
    await run("GOOGLECALENDAR_DELETE_EVENT", { calendar_id: "primary", event_id: seriesId, send_updates: "none" });
    show("get of the deleted series", await run("GOOGLECALENDAR_EVENTS_GET", { calendar_id: "primary", event_id: seriesId }));
    show("delete of an already-deleted series", await run("GOOGLECALENDAR_DELETE_EVENT", { calendar_id: "primary", event_id: seriesId }));
  }
} else if (step === "triggers") {
  for (const t of TOOLKITS) {
    const active = await attempt(`listActive ${t}`, () => composio.triggers.listActive({}));
    show("active triggers (all, once)", ((active as any)?.items ?? []).map((i: any) => ({ id: i.id, slug: i.triggerName ?? i.trigger_name ?? i.slug, user: i.userId ?? i.user_id, status: i.disabledAt ? "disabled" : "active", connected: i.connectedAccountId })));
    break;
  }
} else if (step === "cleanup") {
  const active = (await composio.triggers.listActive({})).items ?? [];
  for (const i of active) {
    const user = i.userId ?? i.user_id ?? "";
    if (String(user).startsWith("spike:")) {
      await attempt(`delete trigger ${i.id}`, () => composio.triggers.delete(i.id));
      console.log("deleted trigger", i.id);
    }
  }
  for (const t of [...TOOLKITS, toolkit].filter((x): x is string => Boolean(x))) {
    const list = await composio.connectedAccounts.list({ userIds: [userOf(t)] });
    for (const c of list.items ?? []) {
      await attempt(`delete connection ${c.id}`, () => composio.connectedAccounts.delete(c.id));
      console.log("deleted connection", c.id, t);
    }
  }
  console.log("Auth configs are left in place (the daemon adopts them); delete them in the dashboard if you want a clean project.");
} else if (step === "toolkit") {
  if (!apiKey) throw new Error("COMPOSIO_API_KEY is not set in .env");
  const raw: any = await composio.toolkits.get(toolkit);
  const info = toolkitInfoFrom(raw);
  show("toolkit info", info);
  const types: any = await attempt("trigger types", () => composio.triggers.listTypes({ toolkits: [toolkit], limit: 100 }));
  const triggers = ((types as any)?.items ?? []).map((x: any) => ({ slug: x.slug, type: x.type, config: x.config }));
  show("trigger types (slug, type)", triggers.map((t: any) => `${t.slug} ${t.type}`));
  let payloadField: string | undefined;
  if (triggers[0]) {
    const detail: any = await attempt("trigger type detail", () => composio.triggers.getType(triggers[0].slug));
    payloadField = ["payload", "payloadSchema", "payload_schema"].find((f) => detail?.[f] !== undefined);
    console.log(`getType(${triggers[0].slug}) keys: ${Object.keys(detail ?? {}).join(", ")}; payload schema field: ${payloadField ?? "none"}`);
  }
  if (save) {
    const dir = "tests/fixtures/composio/meta";
    fs.mkdirSync(dir, { recursive: true });
    const keepConfig = toolkit === "slack";
    fs.writeFileSync(`${dir}/${toolkit}.json`, JSON.stringify({ info, triggers: triggers.map((t: any) => ({ slug: t.slug, type: t.type, ...(keepConfig ? { config: t.config } : {}) })), ...(payloadField ? { payloadSchemaField: payloadField } : {}) }, null, 2) + "\n");
    console.log(`saved ${dir}/${toolkit}.json`);
  }
} else if (step === "link") {
  if (!apiKey) throw new Error("COMPOSIO_API_KEY is not set in .env");
  const user = userOf(toolkit);
  const existing: any = await composio.authConfigs.list({ toolkit });
  const found = (existing.items ?? []).find((c: any) => c.isComposioManaged === true && c.status !== "DISABLED");
  const authConfigId = found?.id ?? (await composio.authConfigs.create(toolkit, { type: "use_composio_managed_auth" })).id;
  const request = await composio.connectedAccounts.link(user, authConfigId);
  console.log(`\nSIGN IN HERE: ${request.redirectUrl}\n(waiting up to 10 minutes; use the Clots' own account if there is one)`);
  const account = await composio.connectedAccounts.waitForConnection(request.id, 10 * 60_000);
  show("connection", { id: account.id, status: account.status });
  let triggerId: string | undefined;
  if (slug) {
    const created: any = await attempt("trigger create", () => composio.triggers.create(user, slug, { connectedAccountId: account.id, triggerConfig: json ? JSON.parse(json) : {} }));
    triggerId = created?.triggerId;
    show("trigger instance", created);
  }
  console.log("Connected. Run scripts/capture-2e.ts to record deliveries; press Ctrl+C here to clean up.");
  const cleanup = async () => {
    if (triggerId) await attempt("delete trigger", () => composio.triggers.delete(triggerId!));
    await attempt("delete connection", () => composio.connectedAccounts.delete(account.id));
    console.log("cleaned up");
    process.exit(0);
  };
  process.on("SIGINT", () => void cleanup());
  setInterval(() => {}, 1 << 30); // keeps the process alive until Ctrl+C
} else {
  console.log("Unknown step. See the header of this file.");
}

if (results.length) {
  console.log(`\n${results.filter(([, ok]) => ok).length}/${results.length} passed`);
  if (results.some(([, ok]) => !ok)) process.exitCode = 1;
}
