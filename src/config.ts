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

const SourcesSchema = z
  .strictObject({
    stripe: z.array(z.strictObject({ ...accountFields, webhookSecret: envKey, apiKey: envKey, checkoutCompleted: z.boolean().default(false) })).default([]),
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
    calendar: z
      .array(
        z.strictObject({
          ...accountFields,
          icalUrl: envKey,
          script: envKey.optional(),
          scriptSecret: envKey.optional(),
          leadTimes: z.array(leadTime).min(1).default([1440]),
          pollMinutes: z.number().int().min(1).default(5),
        }),
      )
      .default([]),
    linear: z.array(z.strictObject({ ...accountFields, webhookSecret: envKey, apiKey: envKey })).default([]),
    notion: z.array(z.strictObject({ ...accountFields, token: envKey, verificationToken: envKey.optional() })).default([]),
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
  sweep: z.strictObject({ enabled: z.boolean().default(true), everyMinutes: z.number().int().min(15).default(90) }).prefault({}),
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
export interface StripeAccount extends AccountBase {
  webhookSecret: string;
  apiKey: string;
  checkoutCompleted: boolean;
}
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
export interface CalendarAccount extends AccountBase {
  icalUrl: string;
  /** The Apps Script web app that changes events. Without it the calendar is read-only. */
  script?: { url: string; secret: string };
  /** How long before an event its reminders come, in minutes. */
  leadMinutes: number[];
  pollMinutes: number;
}
export interface LinearAccount extends AccountBase {
  webhookSecret: string;
  apiKey: string;
}
export interface NotionAccount extends AccountBase {
  token: string;
  verificationToken?: string;
}
export interface Sources {
  stripe: StripeAccount[];
  email: EmailAccount[];
  calendar: CalendarAccount[];
  linear: LinearAccount[];
  notion: NotionAccount[];
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
  mcpServers: Record<string, McpServer>;
}

function secret(env: Record<string, string | undefined>, key: string): string {
  const value = env[key];
  if (!value) throw new Error(`${key} is not set in .env`);
  return value;
}

const values = (env: Record<string, string | undefined>, keys: Record<string, string>) => Object.fromEntries(Object.entries(keys).map(([name, key]) => [name, secret(env, key)]));

export function loadConfig(json: unknown, env: Record<string, string | undefined>): Config {
  const file = FileSchema.parse(json);

  const clotNames = new Set([...file.clots.map((c) => c.name), ...(file.home ? [HOME_CLOT] : [])]);
  const base = (source: string, a: { account: string; clot?: string; shared?: true }): AccountBase => {
    if ((a.clot === undefined) === (a.shared === undefined)) throw new Error(`${source} account ${a.account}: give either clot or shared: true`);
    if (a.clot !== undefined && !clotNames.has(a.clot)) throw new Error(`${source} account ${a.account}: there is no Clot named ${a.clot}`);
    return { account: a.account, clot: a.clot, shared: a.shared === true };
  };
  for (const [source, accounts] of Object.entries(file.sources)) {
    const seen = new Set<string>();
    for (const a of accounts) {
      if (seen.has(a.account)) throw new Error(`${source} account ${a.account} is named twice`);
      seen.add(a.account);
    }
  }

  const sources: Sources = {
    stripe: file.sources.stripe.map((a) => ({ ...base("stripe", a), webhookSecret: secret(env, a.webhookSecret), apiKey: secret(env, a.apiKey), checkoutCompleted: a.checkoutCompleted })),
    email: file.sources.email.map((a) => {
      const gmail = a.address.toLowerCase().endsWith("@gmail.com");
      const imap = a.imap ?? (gmail ? { host: "imap.gmail.com", port: 993 } : undefined);
      const smtp = a.smtp ?? (gmail ? { host: "smtp.gmail.com", port: 465 } : undefined);
      if (imap === undefined || smtp === undefined) throw new Error(`email account ${a.account}: imap and smtp are needed for an address that is not a Gmail one`);
      return { ...base("email", a), address: a.address.toLowerCase(), addresses: a.addresses.map((x) => x.toLowerCase()), password: secret(env, a.password), imap, smtp, mailboxes: a.mailboxes, tellAddress: a.tellAddress };
    }),
    calendar: file.sources.calendar.map((a) => {
      if ((a.script === undefined) !== (a.scriptSecret === undefined)) throw new Error(`calendar account ${a.account}: script and scriptSecret go together`);
      const script = a.script === undefined || a.scriptSecret === undefined ? undefined : { url: secret(env, a.script), secret: secret(env, a.scriptSecret) };
      return { ...base("calendar", a), icalUrl: secret(env, a.icalUrl), script, leadMinutes: a.leadTimes, pollMinutes: a.pollMinutes };
    }),
    linear: file.sources.linear.map((a) => ({ ...base("linear", a), webhookSecret: secret(env, a.webhookSecret), apiKey: secret(env, a.apiKey) })),
    notion: file.sources.notion.map((a) => ({ ...base("notion", a), token: secret(env, a.token), verificationToken: a.verificationToken === undefined ? undefined : secret(env, a.verificationToken) })),
  };

  const mcpServers: Record<string, McpServer> = Object.fromEntries(
    Object.entries(file.mcpServers).map(([name, server]) => [
      name,
      "command" in server ? { kind: "stdio" as const, command: server.command, args: server.args, env: values(env, server.env) } : { kind: "http" as const, url: server.url, headers: values(env, server.headers), oauth: server.oauth },
    ]),
  );

  const publicUrl = (file.publicUrl ?? "").replace(/\/+$/, "");
  const reachedFromOutside = sources.stripe.length + sources.linear.length + sources.notion.length > 0 || Object.values(mcpServers).some((server) => server.kind === "http" && server.oauth);
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
    mcpServers,
  };
}
