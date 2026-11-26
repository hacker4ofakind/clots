/**
 * A fake Composio and configurer for the end-to-end tests: the toolkit list, jobs that move working -> oauth or key -> active,
 * the connected tools and the inboxes, all in memory, speaking the routes and the `integration.status` event of the
 * builder contract (.superpowers/handoffs/4a-builder-contract.md). The test's controls (in fake-daemon.mts) complete an
 * OAuth sign-in: POST /integrations/activate {jobId?}, and put everything back: POST /integrations/reset.
 */
import { randomUUID } from "node:crypto";
import { ApiError, ApiResult, type UiApi } from "../../src/ui-api/server.js";
import type { EventBus } from "../../src/ui-api/events.js";

type Auth = "oauth" | "key" | "none";
interface Toolkit {
  slug: string;
  name: string;
  auth: Auth;
  webhooks?: boolean;
  logo?: string;
}
interface Tool {
  id: string;
  toolkit: string;
  account: string;
  clot: string | null;
  shared: boolean;
  audience: "private" | "team" | "public";
  status: "active" | "waiting" | "failed" | "unknown";
  selfIsUser?: boolean;
  events?: boolean;
  pollMinutes?: number;
  leadTimes?: string[];
  checkoutCompleted?: boolean;
  restartNeeded?: true;
}
interface Inbox {
  account: string;
  address: string;
  clot: string | null;
  shared: boolean;
  provider: "Gmail" | "Email";
  mailboxes: string[];
  imap?: { host: string; port: number };
  smtp?: { host: string; port: number };
  addresses: string[];
  tellAddress: boolean;
}
interface Options {
  toolkit: string;
  clot?: string;
  audience: Tool["audience"];
  selfIsUser: boolean;
  events: boolean;
  pollMinutes?: number;
  leadTimes?: string[];
  checkoutCompleted?: boolean;
  replaces?: string;
}
interface Job {
  jobId: string;
  toolkit: string;
  name: string;
  clot: string | null;
  state: "working" | "oauth" | "key" | "active" | "failed";
  link?: string;
  instructions?: string;
  keyName?: string;
  error?: string;
  oauthReadyAt?: number;
  options: Options;
  attempts: number;
}

const TOOLKITS: Toolkit[] = [
  { slug: "vercel", name: "Vercel", auth: "oauth" },
  { slug: "instagram", name: "Instagram", auth: "oauth" },
  { slug: "granola", name: "Granola", auth: "oauth" },
  { slug: "notion", name: "Notion", auth: "oauth", webhooks: true },
  { slug: "microsoft_teams", name: "Microsoft Teams", auth: "oauth" },
  { slug: "github", name: "GitHub", auth: "oauth", webhooks: true },
  { slug: "posthog", name: "PostHog", auth: "key" },
  { slug: "elevenlabs", name: "ElevenLabs", auth: "key" },
  { slug: "flaky", name: "Flaky", auth: "oauth" },
  { slug: "slack", name: "Slack", auth: "oauth", webhooks: true },
  { slug: "linear", name: "Linear", auth: "oauth", webhooks: true },
  { slug: "stripe", name: "Stripe", auth: "key", webhooks: true },
  { slug: "googlecalendar", name: "Google Calendar", auth: "oauth" },
];

const KEY_INSTRUCTIONS = ["1. Open https://elevenlabs.io/app/developers/api-keys.", "2. Select Create API key and name it Clots.", "3. Under permissions, leave Text to Speech and Voices on; turn the rest off.", "4. Copy the key and paste it above. ElevenLabs only shows it once."].join("\n");

const initialTools = (): Tool[] => [
  { id: "posthog:main", toolkit: "posthog", account: "main", clot: "Truecast", shared: false, audience: "public", status: "active" },
  { id: "microsoft_teams:main", toolkit: "microsoft_teams", account: "main", clot: null, shared: true, audience: "team", status: "active" },
];
const initialInboxes = (): Inbox[] => [
  { account: "tady", address: "lukas@tady.ch", clot: null, shared: true, provider: "Email", mailboxes: ["INBOX"], imap: { host: "mail.tady.ch", port: 993 }, smtp: { host: "mail.tady.ch", port: 465 }, addresses: [], tellAddress: true },
  { account: "lukbicycles", address: "lukbicycles.com+clots@gmail.com", clot: "home", shared: false, provider: "Gmail", mailboxes: ["INBOX"], imap: { host: "imap.gmail.com", port: 993 }, smtp: { host: "smtp.gmail.com", port: 465 }, addresses: [], tellAddress: true },
];

export function registerFakeIntegrations(api: UiApi, bus: EventBus, now: () => number = Date.now) {
  let tools = initialTools();
  let inboxes = initialInboxes();
  const jobs = new Map<string, Job>();

  const toolkit = (slug: string) => TOOLKITS.find((t) => t.slug === slug);
  const emit = (job: Job) => {
    const { jobId, toolkit: slug, state, link, instructions, keyName, error, oauthReadyAt } = job;
    void bus.emit("integration.status", { jobId, toolkit: slug, state, ...(link ? { link } : {}), ...(instructions ? { instructions } : {}), ...(keyName ? { keyName } : {}), ...(error ? { error } : {}), ...(oauthReadyAt ? { oauthReadyAt } : {}) });
  };
  const view = (job: Job) => ({ jobId: job.jobId, toolkit: job.toolkit, name: job.name, clot: job.clot, state: job.state, link: job.link, instructions: job.instructions, keyName: job.keyName, error: job.error, oauthReadyAt: job.oauthReadyAt });
  const set = (job: Job, patch: Partial<Job>) => {
    Object.assign(job, patch);
    emit(job);
  };

  /** The configurer "works" for a moment, then the toolkit's own connect step shows. */
  const run = (job: Job) => {
    job.attempts += 1;
    set(job, { state: "working", link: undefined, instructions: undefined, keyName: undefined, error: undefined, oauthReadyAt: undefined });
    setTimeout(() => {
      if (jobs.get(job.jobId) !== job) return;
      const kit = toolkit(job.toolkit);
      if (job.toolkit === "flaky" && job.attempts === 1) return set(job, { state: "failed", error: "The configurer could not find a way to connect Flaky." });
      if (kit?.auth === "key") return set(job, { state: "key", keyName: `${job.toolkit.toUpperCase()}_MAIN_KEY`, instructions: job.toolkit === "elevenlabs" ? KEY_INSTRUCTIONS : "1. Open https://example.com/keys.\n2. Create a key and paste it above." });
      if (kit?.auth === "none") return activate(job);
      set(job, { state: "oauth", link: `https://connect.example.test/${job.jobId}`, oauthReadyAt: now() + 5000 });
    }, 700);
  };

  /** The connection is ready: the entry is written (replacing the one it edits). */
  const activate = (job: Job) => {
    const o = job.options;
    const account = o.replaces ? (o.replaces.split(":")[1] ?? "main") : "main";
    const entry: Tool = { id: `${job.toolkit}:${account}`, toolkit: job.toolkit, account, clot: o.clot ?? null, shared: o.clot === undefined, audience: o.audience, status: "active", selfIsUser: o.selfIsUser, events: o.events, ...(o.pollMinutes === undefined ? {} : { pollMinutes: o.pollMinutes }), ...(o.leadTimes === undefined ? {} : { leadTimes: o.leadTimes }), ...(o.checkoutCompleted === undefined ? {} : { checkoutCompleted: o.checkoutCompleted }) };
    tools = [...tools.filter((t) => t.id !== (o.replaces ?? entry.id) && t.id !== entry.id), entry];
    set(job, { state: "active" });
  };

  api.route("GET", "/integrations/toolkits", (req) => {
    const q = (req.query.get("q") ?? "").trim().toLowerCase();
    return { toolkits: TOOLKITS.filter((t) => q === "" || t.name.toLowerCase().includes(q) || t.slug.includes(q)).slice(0, 60) };
  });
  api.route("GET", "/integrations", () => ({ inboxes, tools }));

  api.route("POST", "/integrations/configure", (req) => {
    const body = (req.body ?? {}) as Options & { jobId?: string };
    if (!toolkit(body.toolkit)) throw new ApiError(400, "Unknown toolkit.");
    const options: Options = { toolkit: body.toolkit, ...(body.clot ? { clot: body.clot } : {}), audience: body.audience, selfIsUser: body.selfIsUser, events: body.events, ...(body.pollMinutes === undefined ? {} : { pollMinutes: body.pollMinutes }), ...(body.leadTimes === undefined ? {} : { leadTimes: body.leadTimes }), ...(body.checkoutCompleted === undefined ? {} : { checkoutCompleted: body.checkoutCompleted }), ...(body.replaces ? { replaces: body.replaces } : {}) };
    const existing = body.jobId ? jobs.get(body.jobId) : undefined;
    const job: Job = existing ?? { jobId: randomUUID(), toolkit: body.toolkit, name: toolkit(body.toolkit)!.name, clot: body.clot ?? null, state: "working", options, attempts: 0 };
    job.options = options;
    job.clot = options.clot ?? null;
    jobs.set(job.jobId, job);
    // The job's first event comes after the answer, as it would in the daemon.
    setTimeout(() => run(job), 50);
    return new ApiResult(201, { jobId: job.jobId });
  });
  api.route("GET", "/integrations/jobs/:jobId", (req) => {
    const job = jobs.get(req.params.jobId!);
    if (!job) throw new ApiError(404, "no such job");
    return view(job);
  });
  api.route("PUT", "/integrations/jobs/:jobId/key", (req) => {
    const job = jobs.get(req.params.jobId!);
    if (!job) throw new ApiError(404, "no such job");
    const value = String((req.body as { value?: unknown } | null)?.value ?? "");
    if (value === "bad") throw new ApiError(400, "That key was refused.");
    activate(job);
    return { ok: true };
  });
  api.route("POST", "/integrations/jobs/:jobId/abandon", (req) => {
    jobs.delete(req.params.jobId!);
    return { ok: true };
  });
  api.route("POST", "/integrations/tools/:id/reconnect", (req) => {
    const tool = tools.find((t) => t.id === req.params.id);
    if (!tool) throw new ApiError(404, "no such tool");
    const kit = toolkit(tool.toolkit)!;
    const job: Job = { jobId: randomUUID(), toolkit: tool.toolkit, name: kit.name, clot: tool.clot, state: "working", options: { toolkit: tool.toolkit, ...(tool.clot ? { clot: tool.clot } : {}), audience: tool.audience, selfIsUser: tool.selfIsUser ?? true, events: tool.events ?? true, replaces: tool.id }, attempts: 1 };
    jobs.set(job.jobId, job);
    if (kit.auth === "key") Object.assign(job, { state: "key", keyName: `${tool.toolkit.toUpperCase()}_MAIN_KEY`, instructions: "1. Open https://example.com/keys.\n2. Create a key and paste it above." });
    else Object.assign(job, { state: "oauth", link: `https://connect.example.test/${job.jobId}`, oauthReadyAt: now() + 5000 });
    return { jobId: job.jobId };
  });
  api.route("DELETE", "/integrations/tools/:id", (req) => {
    if (!tools.some((t) => t.id === req.params.id)) throw new ApiError(404, "no such tool");
    tools = tools.filter((t) => t.id !== req.params.id);
    return { ok: true };
  });

  const inboxFrom = (body: Record<string, unknown>, account: string): Inbox => {
    const address = String(body.address ?? "");
    const gmail = /@(gmail|googlemail)\.com$/i.test(address);
    return { account, address, clot: typeof body.clot === "string" ? body.clot : null, shared: typeof body.clot !== "string", provider: gmail ? "Gmail" : "Email", mailboxes: Array.isArray(body.mailboxes) ? body.mailboxes.map(String) : ["INBOX"], imap: (body.imap as Inbox["imap"]) ?? (gmail ? { host: "imap.gmail.com", port: 993 } : undefined), smtp: (body.smtp as Inbox["smtp"]) ?? (gmail ? { host: "smtp.gmail.com", port: 465 } : undefined), addresses: Array.isArray(body.addresses) ? body.addresses.map(String) : [], tellAddress: body.tellAddress !== false };
  };
  api.route("POST", "/inboxes", (req) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (!body.password) throw new ApiError(400, "A password is needed.");
    const account = String(body.address ?? "").split("@")[0]!.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    if (inboxes.some((i) => i.account === account)) throw new ApiError(409, `There is an inbox named ${account} already.`);
    inboxes = [...inboxes, inboxFrom(body, account)];
    return new ApiResult(201, { account, provider: inboxes.at(-1)!.provider });
  });
  api.route("PUT", "/inboxes/:account", (req) => {
    const found = inboxes.find((i) => i.account === req.params.account);
    if (!found) throw new ApiError(404, "no such inbox");
    inboxes = inboxes.map((i) => (i === found ? inboxFrom({ ...(req.body as object), address: found.address }, found.account) : i));
    return { ok: true };
  });
  api.route("DELETE", "/inboxes/:account", (req) => {
    if (!inboxes.some((i) => i.account === req.params.account)) throw new ApiError(404, "no such inbox");
    inboxes = inboxes.filter((i) => i.account !== req.params.account);
    return { ok: true };
  });

  return {
    /** The user finished signing in: the newest OAuth job becomes active (or the one named). */
    activate(jobId?: string) {
      const job = jobId ? jobs.get(jobId) : [...jobs.values()].reverse().find((j) => j.state === "oauth");
      if (job) activate(job);
      return { jobId: job?.jobId ?? null };
    },
    reset() {
      tools = initialTools();
      inboxes = initialInboxes();
      jobs.clear();
    },
  };
}
