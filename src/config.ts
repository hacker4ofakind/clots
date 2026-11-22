import { z } from "zod";
import { repoSlug } from "./events/github.js";
import { parseSpan, type GateConfig, type Windows } from "./gates.js";
import { WEEKDAYS } from "./time.js";

/** The name of the Clot for what belongs to no project. */
export const HOME_CLOT = "home";

/** Names a project Clot cannot have: the home Clot's, the one the rulebook uses for the file every Clot shares, and the two the spend log books to. */
const RESERVED_NAMES = [HOME_CLOT, "global", "daemon", "sweep"];

const weekdays = (window: string): Record<string, string> => Object.fromEntries(["mon", "tue", "wed", "thu", "fri"].map((day) => [day, window]));

/** Windows by weekday: "15:00-18:00", start before end, in the configured time zone. */
const windowsSchema = z.partialRecord(z.enum(WEEKDAYS), z.string()).transform((raw, ctx): Windows => {
  const windows: Windows = {};
  for (const [day, text] of Object.entries(raw)) {
    const span = parseSpan(text as string);
    if (typeof span === "string") {
      ctx.addIssue({ code: "custom", message: `${day}: ${span}`, path: [day] });
      continue;
    }
    windows[day as keyof Windows] = span;
  }
  return windows;
});

const GatesSchema = z
  .strictObject({
    scarce: windowsSchema.default(() => windowsSchema.parse(weekdays("15:00-18:00"))),
    leadIn: windowsSchema.default(() => windowsSchema.parse(weekdays("10:00-15:00"))),
    leadInPercent: z.number().int().min(1).max(100).default(50),
  })
  .prefault({});

const NAME = /^[a-z0-9][a-z0-9-]*$/;

/** The name of a key in .env. A credential is never written in the configuration file, only the key that holds it. */
const envKey = z.string().regex(/^[A-Z][A-Z0-9_]*$/, "names a key in .env, in capital letters");

/** What every account of a source has: a name of its own, and either the Clot it is bound to or `shared: true`. */
const accountFields = {
  account: z.string().regex(NAME, "an account's name uses lowercase letters, digits and hyphens"),
  clot: z.string().regex(NAME).optional(),
  shared: z.literal(true).optional(),
};

const endpoint = (port: number) => z.strictObject({ host: z.string().min(1), port: z.number().int().min(1).max(65535).default(port) });

/** "24h", "90m" or "2d", in minutes. */
const leadTime = z
  .string()
  .regex(/^\d+[mhd]$/, 'a lead time is a number followed by m, h or d, such as "24h"')
  .transform((text) => Number(text.slice(0, -1)) * { m: 1, h: 60, d: 1440 }[text.slice(-1) as "m" | "h" | "d"]);

/** Who sees what happens in an account: only the user and the Clots, the user and people they know well, or anyone. */
export const AUDIENCES = ["private", "team", "public"] as const;
export type Audience = (typeof AUDIENCES)[number];

const composioFields = { ...accountFields, audience: z.enum(AUDIENCES).default("public") };

/** One strict schema per toolkit the daemon knows; any other toolkit takes its triggers from the configuration. */
const COMPOSIO_TOOLKITS = {
  linear: z.strictObject({ ...composioFields, toolkit: z.literal("linear"), apiKey: envKey }),
  notion: z.strictObject({ ...composioFields, toolkit: z.literal("notion"), apiKey: envKey, verificationToken: envKey.optional() }),
  stripe: z.strictObject({ ...composioFields, toolkit: z.literal("stripe"), apiKey: envKey, checkoutCompleted: z.boolean().default(false) }),
  googlecalendar: z.strictObject({
    ...composioFields,
    toolkit: z.literal("googlecalendar"),
    leadTimes: z.array(leadTime).min(1).default([1440]),
    pollMinutes: z.number().int().min(1).default(5),
  }),
  posthog: z.strictObject({
    ...composioFields,
    toolkit: z.literal("posthog"),
    apiKey: envKey,
    region: z.enum(["us", "eu"]).default("us"),
    projectId: z.number().int().positive(),
    events: z.array(z.string().min(1)).min(1),
  }),
};
const GENERIC_TOOLKIT = z
  .strictObject({
    ...composioFields,
    toolkit: z.string().regex(/^[a-z][a-z0-9_]*$/, "a toolkit is Composio's lowercase slug"),
    // How it connects: a key (`apiKey`, or `fields` for a scheme of several fields), the user's own OAuth app, or neither (Composio's managed sign-in).
    apiKey: envKey.optional(),
    fields: z.record(z.string().min(1), envKey).refine((f) => Object.keys(f).length > 0, "fields names at least one field").optional(),
    scheme: z.string().regex(/^[A-Z][A-Z0-9_]*$/, "a scheme is Composio's uppercase name, such as API_KEY").optional(),
    oauthApp: z.strictObject({ clientId: envKey, clientSecret: envKey }).optional(),
    // True when the connection is the user's own account at the service, not the Clots'.
    selfIsUser: z.boolean().default(false),
    triggers: z.array(z.strictObject({ slug: z.string().regex(/^[A-Z][A-Z0-9_]*$/, "a trigger is Composio's uppercase slug"), config: z.record(z.string(), z.unknown()).default({}) })).default([]),
  })
  .refine((a) => !(a.oauthApp !== undefined && (a.apiKey !== undefined || a.fields !== undefined)), { message: "oauthApp cannot go with apiKey or fields", path: ["oauthApp"] })
  .refine((a) => !(a.apiKey !== undefined && a.fields !== undefined), { message: "give apiKey or fields, not both", path: ["fields"] })
  .refine((a) => a.scheme === undefined || a.apiKey !== undefined || a.fields !== undefined, { message: "scheme goes with apiKey or fields", path: ["scheme"] });

/** The source keys 2e moved into sources.composio. */
const MOVED_SOURCES = ["stripe", "linear", "notion", "calendar"];

const SourcesSchema = z
  .strictObject({
    email: z
      .array(
        z.strictObject({
          ...accountFields,
          address: z.email(),
          addresses: z.array(z.email()).default([]),
          password: envKey,
          imap: endpoint(993).optional(),
          smtp: endpoint(465).optional(),
          mailboxes: z.array(z.string().min(1)).min(1),
          // Whether the Clots are told the account's addresses, or only its name.
          tellAddress: z.boolean().default(true),
        }),
      )
      .default([]),
    composio: z.array(z.looseObject({ toolkit: z.string() })).default([]),
  })
  .prefault({});

const McpServerSchema = z.union([
  z.strictObject({ command: z.string().min(1), args: z.array(z.string()).default([]), env: z.record(z.string(), envKey).default({}) }),
  z.strictObject({ url: z.url(), headers: z.record(z.string(), envKey).default({}), oauth: z.boolean().default(false) }),
]);

const FileSchema = z.object({
  timeZone: z.string().min(1),
  image: z.string().min(1),
  discord: z.object({ guildId: z.string().min(1), userId: z.string().min(1) }),
  intake: z.object({ port: z.number().int().min(1).max(65535) }).default({ port: 8787 }),
  rulebookDir: z.string().min(1).default("rulebook"),
  hold: z.object({ quietSeconds: z.number().min(0), capSeconds: z.number().min(0) }).default({ quietSeconds: 60, capSeconds: 120 }),
  clots: z
    .array(
      z.object({
        name: z
          .string()
          .regex(NAME)
          .refine((name) => !RESERVED_NAMES.includes(name), "the names home and global are the daemon's own"),
        // Events are routed by repository, so the URL must be one a repository can be read from.
        repoUrl: z.string().refine((url) => repoSlug(url) !== undefined, "repoUrl must look like https://github.com/owner/name.git"),
        testCommand: z.string().min(1).optional(),
        // One line for the routing call: what this project is, so an event that names no repository can be placed.
        about: z.string().min(1).max(300).optional(),
      }),
    )
    .min(1),
  // A Clot with no repository of its own, for events no project Clot is bound to.
  home: z.boolean().default(false),
  // The share of the context window at which a session rolls over to a fresh one.
  rolloverPercent: z.number().min(1).max(100).default(65),
  // How many rule proposals a Clot may have waiting for the user at once.
  maxProposals: z.number().int().min(1).default(3),
  // How many worker turns run at once across the daemon.
  maxWorkers: z.number().int().min(1).max(20).default(3),
  // How long a choice waits for the user before the Clot goes with its pick.
  choiceTimeoutMinutes: z.number().int().min(1).max(1440).default(10),
  // The address the tunnel gives the intake port, for webhooks and OAuth logins.
  publicUrl: z.url().optional(),
  // Whether a Clot may ask to send an email, which the daemon sends on the user's yes in a review channel; and how many days a request waits for that answer.
  sendReview: z.strictObject({ enabled: z.boolean().default(true), days: z.number().positive().default(3) }).prefault({}),
  gates: GatesSchema,
  sweep: z.strictObject({ enabled: z.boolean().default(true), everyMinutes: z.number().int().min(15).default(180) }).prefault({}),
  // An explicit {} means no warning.
  spend: z.strictObject({ weeklyWarnUsd: z.number().positive().optional() }).default({ weeklyWarnUsd: 50 }),
  sources: SourcesSchema,
  mcpServers: z.record(z.string().regex(NAME), McpServerSchema).default({}),
});

export interface AccountBase {
  account: string;
  /** The Clot the account is bound to. Without one, the account is shared and its events are routed. */
  clot?: string;
  shared: boolean;
}
export type Endpoint = { host: string; port: number };
export interface EmailAccount extends AccountBase {
  address: string;
  /** Other addresses delivered into this account, such as support@. */
  addresses: string[];
  password: string;
  imap: Endpoint;
  smtp: Endpoint;
  /** The folders or Gmail labels the daemon watches. Nothing else is read. */
  mailboxes: string[];
  /** Whether the Clots are told the account's addresses, or only its name. */
  tellAddress: boolean;
}
/** An account of any Composio toolkit. The fields a toolkit does not take are absent; the narrowed types below say which are present. */
export interface ComposioAccount extends AccountBase {
  /** Composio's toolkit slug: `linear`, `googlecalendar`, `slack`... */
  toolkit: string;
  audience: Audience;
  /** The service's key, read from .env. Absent for an account that signs in through Composio or gives `fields`. */
  apiKey?: string;
  /** The .env key that holds it, for telling the user which key to replace. */
  apiKeyName?: string;
  /** A key scheme of several fields: each field's value by Composio's field name, and the .env key it came from. */
  fields?: Record<string, string>;
  fieldKeys?: Record<string, string>;
  /** Which key scheme, when the toolkit has several. */
  scheme?: string;
  /** The user's own OAuth app: the .env keys of its client ID and secret, and their values. */
  oauthApp?: { clientId: string; clientSecret: string };
  oauthValues?: { clientId: string; clientSecret: string };
  /** The connection is the user's own account at the service, not the Clots'. */
  selfIsUser: boolean;
  /** Notion: the .env key of Notion's verification token, if set by hand. */
  verificationToken?: string;
  /** A toolkit with no built-in mapper: the triggers to make, with their config. */
  triggers: { slug: string; config: Record<string, unknown> }[];
  /** Calendar: how long before an event its reminders come, in minutes; and how often the calendar is read. */
  leadMinutes?: number[];
  pollMinutes?: number;
  /** Stripe */
  checkoutCompleted?: boolean;
  /** PostHog */
  region?: "us" | "eu";
  projectId?: number;
  events?: string[];
}
export type StripeAccount = ComposioAccount & { toolkit: "stripe"; apiKey: string; checkoutCompleted: boolean };
export type LinearAccount = ComposioAccount & { toolkit: "linear"; apiKey: string };
export type NotionAccount = ComposioAccount & { toolkit: "notion"; apiKey: string };
export type CalendarAccount = ComposioAccount & { toolkit: "googlecalendar"; leadMinutes: number[]; pollMinutes: number };
export type PostHogAccount = ComposioAccount & { toolkit: "posthog"; apiKey: string; region: "us" | "eu"; projectId: number; events: string[] };
export const isCalendar = (a: ComposioAccount): a is CalendarAccount => a.toolkit === "googlecalendar";
export interface Sources {
  email: EmailAccount[];
  composio: ComposioAccount[];
}
export type McpServer = { kind: "stdio"; command: string; args: string[]; env: Record<string, string> } | { kind: "http"; url: string; headers: Record<string, string>; oauth: boolean };

export interface Config {
  timeZone: string;
  image: string;
  guildId: string;
  userId: string;
  /** The local port webhooks arrive on, behind the tunnel. */
  intakePort: number;
  rulebookDir: string;
  /** How long automated events are held to be gathered: after the last one, and at most after the first. */
  hold: { quietMs: number; capMs: number };
  /** testCommand, when set, is the one command a locked turn may run besides the read-only list. */
  clots: { name: string; repoUrl: string; testCommand?: string; about?: string }[];
  discordToken: string;
  claudeToken: string;
  githubToken: string;
  webhookSecret: string;
  rolloverPercent: number;
  /** Whether the home Clot runs. */
  home: boolean;
  /** How many rule proposals a Clot may have waiting for the user at once. */
  maxProposals: number;
  /** How many worker turns run at once across the daemon. */
  maxWorkers: number;
  /** How long a choice waits for the user before the Clot goes with its pick. */
  choiceTimeoutMinutes: number;
  /** The tunnel's address, without a trailing slash; "" when not set. */
  publicUrl: string;
  /** Emails a Clot asks to send, sent on the user's yes in a review channel. `maxMs`: how long a request waits for the answer. */
  sendReview: { enabled: boolean; maxMs: number };
  /** The windows in which the Clots step back, and the five-hour utilization at which the lead-in holds. */
  gates: GateConfig;
  /** The periodic read of the claude.ai connectors. */
  sweep: { enabled: boolean; everyMinutes: number };
  /** `weeklyWarnUsd`: a Clot that spends more than this in a week is reported once. Absent: no warning. */
  spend: { weeklyWarnUsd?: number };
  sources: Sources;
  /** The Composio project's key. Only the daemon reads it; it never enters a container. */
  composioApiKey: string | undefined;
  mcpServers: Record<string, McpServer>;
}

function secret(env: Record<string, string | undefined>, key: string): string {
  const value = env[key];
  if (!value) throw new Error(`${key} is not set in .env`);
  return value;
}

const values = (env: Record<string, string | undefined>, keys: Record<string, string>) => Object.fromEntries(Object.entries(keys).map(([name, key]) => [name, secret(env, key)]));

/** What a failed parse of one Composio account says: the account, then each field and what is wrong with it. */
function composioIssues(index: number, error: z.ZodError): string {
  return error.issues.map((issue) => `sources.composio[${index}].${issue.path.join(".") || "(account)"}: ${issue.message}`).join("; ");
}

/** Composio's free plan allows this many tool calls a month on its own app: the calendars' polling and the Composio watches share it. */
export const MONTHLY_POLLING_CALLS = 10_000;

/** A month's polling calls at one interval, in minutes. */
export const callsPerMonth = (minutes: number): number => 43_200 / minutes;

/** The calendars' share of the month's polling calls. */
export const calendarPollingCalls = (accounts: ComposioAccount[]): number => accounts.filter(isCalendar).reduce((sum, a) => sum + callsPerMonth(a.pollMinutes), 0);

/** The .env keys the daemon uses for itself: no account's `apiKey`, `fields` or `oauthApp` may name one. */
const DAEMON_ENV_KEYS = ["COMPOSIO_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "DISCORD_BOT_TOKEN", "CLOT_GITHUB_TOKEN", "GITHUB_WEBHOOK_SECRET"];

/**
 * An entry for a toolkit without built-in support may name only `.env` keys that nothing else uses: not the
 * daemon's own, not a recipe's secret, and not a key another part of the configuration names. The keys of
 * the built-in toolkits, the mail accounts and the MCP servers are the parts of the file it is held against.
 */
function refuseSharedEnvKeys(file: z.infer<typeof FileSchema>, accounts: ComposioAccount[], entries: Record<string, any>[]): void {
  const owners = new Map<string, string>();
  const claim = (key: string | undefined, owner: string, generic: boolean) => {
    if (key === undefined) return;
    if (generic) {
      if (DAEMON_ENV_KEYS.includes(key)) throw new Error(`${owner}: ${key} is a key the daemon uses for itself`);
      if (key.startsWith("RECIPE_")) throw new Error(`${owner}: ${key} is for a recipe's secret`);
      const other = owners.get(key);
      if (other !== undefined) throw new Error(`${owner}: ${key} is already used by ${other}`);
    }
    if (!owners.has(key)) owners.set(key, owner);
  };
  for (const a of file.sources.email) claim(a.password, `email account ${a.account}`, false);
  for (const [name, server] of Object.entries(file.mcpServers)) for (const key of Object.values("command" in server ? server.env : server.headers)) claim(key, `the MCP server ${name}`, false);
  accounts.forEach((a, index) => {
    const entry = entries[index];
    const generic = !(a.toolkit in COMPOSIO_TOOLKITS);
    const owner = `${a.toolkit} account ${a.account}`;
    for (const key of [entry.apiKey, entry.verificationToken, ...Object.values<string>(entry.fields ?? {}), entry.oauthApp?.clientId, entry.oauthApp?.clientSecret]) claim(key, owner, generic);
  });
}

/**
 * What is wrong with one proposed `sources.composio` entry, by the same schemas the loader applies; undefined
 * when it fits. It cannot see `.env`, so a key it names is not checked to exist. `clots` are the configured Clot names.
 */
export function composioEntryProblems(entry: unknown, clots: string[]): string | undefined {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return "an entry is an object";
  const toolkit = (entry as { toolkit?: unknown }).toolkit;
  const schema: z.ZodType = COMPOSIO_TOOLKITS[toolkit as keyof typeof COMPOSIO_TOOLKITS] ?? GENERIC_TOOLKIT;
  const parsed = schema.safeParse(entry);
  if (!parsed.success) return composioIssues(0, parsed.error).replaceAll("sources.composio[0].", "");
  const a = parsed.data as { clot?: string; shared?: true; triggers?: { slug: string }[] };
  if ((a.clot === undefined) === (a.shared === undefined)) return "give either clot or shared: true";
  if (a.clot !== undefined && !clots.includes(a.clot)) return `there is no Clot named ${a.clot} (the Clots are ${clots.join(", ") || "none"})`;
  const slugs = (a.triggers ?? []).map((t) => t.slug);
  const twice = slugs.find((slug, i) => slugs.indexOf(slug) !== i);
  if (twice !== undefined) return `the trigger ${twice} is listed twice`;
  return undefined;
}

/** A `sources.composio` entry the daemon left out because it is not usable, and why. */
export interface SkippedAccount {
  entry: string;
  problem: string;
}

/**
 * `loadConfig`, except that a bad `sources.composio` entry is left out and reported instead of stopping the
 * daemon: one integration's mistake must not take every Clot offline. Anything wrong outside those entries
 * still throws. Entries are tried in order, each on top of the ones kept, so a duplicate or a clash over a
 * `.env` key skips the later entry.
 */
export function loadConfigLeaving(json: unknown, env: Record<string, string | undefined>): { config: Config; skipped: SkippedAccount[] } {
  try {
    return { config: loadConfig(json, env), skipped: [] };
  } catch (error) {
    const root = json as { sources?: { composio?: unknown } } | null;
    const entries = root?.sources?.composio;
    if (!Array.isArray(entries) || entries.length === 0) throw error;
    const withEntries = (list: unknown[]) => ({ ...(json as object), sources: { ...root!.sources, composio: list } });
    // A problem that stays with no entries at all is not an entry's: it stops the daemon as before.
    loadConfig(withEntries([]), env);
    const kept: unknown[] = [];
    const skipped: SkippedAccount[] = [];
    for (const entry of entries) {
      try {
        loadConfig(withEntries([...kept, entry]), env);
        kept.push(entry);
      } catch (problem) {
        const e = entry as { toolkit?: unknown; account?: unknown } | null;
        skipped.push({ entry: `${String(e?.toolkit ?? "?")}:${String(e?.account ?? "?")}`, problem: problem instanceof Error ? problem.message : String(problem) });
      }
    }
    return { config: loadConfig(withEntries(kept), env), skipped };
  }
}

export function loadConfig(json: unknown, env: Record<string, string | undefined>): Config {
  const raw = (json as { sources?: Record<string, unknown> } | null)?.sources;
  for (const name of MOVED_SOURCES) {
    if (raw !== undefined && raw !== null && typeof raw === "object" && name in raw) throw new Error(`sources.${name} moved to sources.composio in stage 2e; see clots.config.example.json`);
  }
  const file = FileSchema.parse(json);

  const clotNames = new Set([...file.clots.map((c) => c.name), ...(file.home ? [HOME_CLOT] : [])]);
  const base = (source: string, a: { account: string; clot?: string; shared?: true }): AccountBase => {
    if ((a.clot === undefined) === (a.shared === undefined)) throw new Error(`${source} account ${a.account}: give either clot or shared: true`);
    if (a.clot !== undefined && !clotNames.has(a.clot)) throw new Error(`${source} account ${a.account}: there is no Clot named ${a.clot}`);
    return { account: a.account, clot: a.clot, shared: a.shared === true };
  };
  for (const [source, accounts] of Object.entries({ email: file.sources.email })) {
    const seen = new Set<string>();
    for (const a of accounts) {
      if (seen.has(a.account)) throw new Error(`${source} account ${a.account} is named twice`);
      seen.add(a.account);
    }
  }

  const composio: ComposioAccount[] = file.sources.composio.map((entry, index) => {
    const schema: z.ZodType = COMPOSIO_TOOLKITS[entry.toolkit as keyof typeof COMPOSIO_TOOLKITS] ?? GENERIC_TOOLKIT;
    const parsed = schema.safeParse(entry);
    if (!parsed.success) throw new Error(composioIssues(index, parsed.error));
    const a = parsed.data as Record<string, any>;
    const triggers: { slug: string; config: Record<string, unknown> }[] = a.triggers ?? [];
    const slugs = new Set<string>();
    for (const t of triggers) {
      if (slugs.has(t.slug)) throw new Error(`${a.toolkit} account ${a.account}: the trigger ${t.slug} is listed twice`);
      slugs.add(t.slug);
    }
    return {
      toolkit: a.toolkit,
      ...base(a.toolkit, a as { account: string; clot?: string; shared?: true }),
      audience: a.audience,
      selfIsUser: a.selfIsUser === true,
      ...(a.apiKey === undefined ? {} : { apiKey: secret(env, a.apiKey), apiKeyName: a.apiKey }),
      ...(a.fields === undefined ? {} : { fields: values(env, a.fields), fieldKeys: a.fields }),
      ...(a.scheme === undefined ? {} : { scheme: a.scheme }),
      ...(a.oauthApp === undefined ? {} : { oauthApp: a.oauthApp, oauthValues: { clientId: secret(env, a.oauthApp.clientId), clientSecret: secret(env, a.oauthApp.clientSecret) } }),
      ...(a.verificationToken === undefined ? {} : { verificationToken: secret(env, a.verificationToken) }),
      triggers,
      ...(a.leadTimes === undefined ? {} : { leadMinutes: a.leadTimes, pollMinutes: a.pollMinutes }),
      ...(a.checkoutCompleted === undefined ? {} : { checkoutCompleted: a.checkoutCompleted }),
      ...(a.region === undefined ? {} : { region: a.region, projectId: a.projectId, events: a.events }),
    };
  });
  const seenComposio = new Set<string>();
  for (const a of composio) {
    const name = `${a.toolkit}:${a.account}`;
    if (seenComposio.has(name)) throw new Error(`${a.toolkit} account ${a.account} is named twice`);
    seenComposio.add(name);
  }
  refuseSharedEnvKeys(file, composio, file.sources.composio as Record<string, any>[]);
  const calendarCalls = calendarPollingCalls(composio);
  if (calendarCalls > MONTHLY_POLLING_CALLS) throw new Error(`the calendars would poll ${Math.round(calendarCalls).toLocaleString("en-US")} times a month; the limit across all calendars is ${MONTHLY_POLLING_CALLS.toLocaleString("en-US")} (raise pollMinutes)`);

  const sources: Sources = {
    email: file.sources.email.map((a) => {
      const gmail = a.address.toLowerCase().endsWith("@gmail.com");
      const imap = a.imap ?? (gmail ? { host: "imap.gmail.com", port: 993 } : undefined);
      const smtp = a.smtp ?? (gmail ? { host: "smtp.gmail.com", port: 465 } : undefined);
      if (imap === undefined || smtp === undefined) throw new Error(`email account ${a.account}: imap and smtp are needed for an address that is not a Gmail one`);
      return { ...base("email", a), address: a.address.toLowerCase(), addresses: a.addresses.map((x) => x.toLowerCase()), password: secret(env, a.password), imap, smtp, mailboxes: a.mailboxes, tellAddress: a.tellAddress };
    }),
    composio,
  };
  const composioApiKey = composio.length > 0 ? secret(env, "COMPOSIO_API_KEY") : env.COMPOSIO_API_KEY || undefined;

  const mcpServers: Record<string, McpServer> = Object.fromEntries(
    Object.entries(file.mcpServers).map(([name, server]) => [
      name,
      "command" in server ? { kind: "stdio" as const, command: server.command, args: server.args, env: values(env, server.env) } : { kind: "http" as const, url: server.url, headers: values(env, server.headers), oauth: server.oauth },
    ]),
  );

  const publicUrl = (file.publicUrl ?? "").replace(/\/+$/, "");
  const reachedFromOutside = sources.composio.length > 0 || Object.values(mcpServers).some((server) => server.kind === "http" && server.oauth);
  if (reachedFromOutside && publicUrl === "") throw new Error("publicUrl is needed: webhooks and OAuth logins reach the daemon through it (the Tailscale Funnel address)");

  return {
    timeZone: file.timeZone,
    image: file.image,
    guildId: file.discord.guildId,
    userId: file.discord.userId,
    intakePort: file.intake.port,
    rulebookDir: file.rulebookDir,
    hold: { quietMs: file.hold.quietSeconds * 1000, capMs: file.hold.capSeconds * 1000 },
    clots: file.clots,
    discordToken: secret(env, "DISCORD_BOT_TOKEN"),
    claudeToken: secret(env, "CLAUDE_CODE_OAUTH_TOKEN"),
    githubToken: secret(env, "CLOT_GITHUB_TOKEN"),
    webhookSecret: secret(env, "GITHUB_WEBHOOK_SECRET"),
    rolloverPercent: file.rolloverPercent,
    home: file.home,
    maxProposals: file.maxProposals,
    choiceTimeoutMinutes: file.choiceTimeoutMinutes,
    maxWorkers: file.maxWorkers,
    publicUrl,
    sendReview: { enabled: file.sendReview.enabled, maxMs: file.sendReview.days * 86_400_000 },
    gates: file.gates,
    sweep: file.sweep,
    spend: file.spend,
    sources,
    composioApiKey,
    mcpServers,
  };
}
