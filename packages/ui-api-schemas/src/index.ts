import { z } from "zod";

/**
 * Request and response shapes of the daemon's UI API (/api/v1), shared by the daemon and the web app.
 * The daemon validates every request with them; the web app uses the types and validates what it forwards.
 */

export const UI_EVENT_TYPES = [
  "message.created",
  "message.delta",
  "message.done",
  "activity",
  "clot.state",
  "ask.opened",
  "ask.updated",
  "ask.closed",
  "workers.updated",
  "config.changed",
  "clot.build",
  "integration.status",
  "resync",
] as const;
export type UiEventType = (typeof UI_EVENT_TYPES)[number];

/** Who may use the UI and where it is served; read by the web app's access check. */
export const identitySchema = z.object({
  owner: z.string().optional(),
  serveHost: z.string().optional(),
});
export type Identity = z.infer<typeof identitySchema>;

// ---------------------------------------------------------------- clots

export const CLOT_STATES = ["idle", "working", "paused", "failed"] as const;
export type ClotStateName = (typeof CLOT_STATES)[number];

/** A Clot's icon: a Phosphor icon (by component name) in one of eight colours, or an uploaded image. */
export const clotIconSchema = z.union([z.object({ phosphor: z.string().min(1).max(60), color: z.string().min(1).max(30) }), z.object({ upload: z.string().min(1).max(100) })]);
export type ClotIcon = z.infer<typeof clotIconSchema>;

export const clotSummarySchema = z.object({
  name: z.string(),
  icon: clotIconSchema.optional(),
  state: z.enum(CLOT_STATES),
  reason: z.string().optional(),
  unread: z.number().int(),
  waiting: z.number().int(),
  /** The home Clot has no repository. */
  home: z.boolean(),
  /** The repository as owner/name; null for the home Clot. */
  repository: z.string().nullable(),
  /** The start of the Clot's newest reply, for the phone's Clots list; null before it has said anything. */
  preview: z.string().nullable(),
  /** Unix seconds a paused Clot resumes at, or null. */
  resumesAt: z.number().nullable(),
  /** Its container is still being built: the New Clot flow is not done. */
  building: z.boolean().optional(),
});
export type ClotSummary = z.infer<typeof clotSummarySchema>;

export const clotInfoSchema = z.object({
  name: z.string(),
  repository: z.string().nullable(),
  connections: z.array(z.object({ kind: z.enum(["email", "composio"]), account: z.string(), label: z.string(), toolkit: z.string().optional(), logo: z.string().optional(), shared: z.boolean() })),
});
export type ClotInfo = z.infer<typeof clotInfoSchema>;

// ---------------------------------------------------------------- messages

export const MESSAGE_KINDS = ["user", "clot", "activity", "note", "ask", "workers", "onboarding"] as const;
export type MessageKindName = (typeof MESSAGE_KINDS)[number];

export const messageViewSchema = z.object({
  id: z.string(),
  clot: z.string(),
  sessionId: z.string().nullable(),
  kind: z.enum(MESSAGE_KINDS),
  text: z.string(),
  ref: z.string().nullable(),
  data: z.record(z.string(), z.unknown()).nullable(),
  createdAt: z.number(),
  images: z.number().int(),
});
export type MessageView = z.infer<typeof messageViewSchema>;

/** An image a message carries, as a data URL: the browser sends it as the user pasted or picked it, after shrinking it. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_IMAGES = 6;

export const sendMessageSchema = z.object({
  /** Made by the client, and reused when a send is retried: the daemon stores a message ID once. */
  id: z.string().min(8).max(64),
  text: z.string().max(100_000),
  images: z.array(z.string().max(Math.ceil(MAX_IMAGE_BYTES * 1.4))).max(MAX_IMAGES).default([]),
});
export type SendMessage = z.infer<typeof sendMessageSchema>;

// ---------------------------------------------------------------- asks

export const ASK_TIMERS = ["calm", "calling", "urgent"] as const;
export type AskTimerName = (typeof ASK_TIMERS)[number];

export const askViewSchema = z.object({
  heading: z.string(),
  shortHeading: z.string(),
  rows: z.array(z.object({ label: z.string(), value: z.string(), href: z.string().optional() })),
  previous: z.string().optional(),
  body: z.string().optional(),
  bodyEditable: z.boolean().optional(),
  labels: z.object({ allow: z.string(), block: z.string() }).optional(),
  options: z.tuple([z.string(), z.string()]).optional(),
  pick: z.union([z.literal(0), z.literal(1)]).optional(),
  warning: z.string().optional(),
});
export type AskView = z.infer<typeof askViewSchema>;

export const askSnapshotSchema = z.object({
  id: z.number().int(),
  clot: z.string(),
  kind: z.string(),
  summary: z.string(),
  view: askViewSchema,
  /** Unix milliseconds. */
  deadline: z.number(),
  timer: z.enum(ASK_TIMERS),
  state: z.enum(["open", "busy"]),
  openedAt: z.number(),
  outsider: z.boolean(),
  /** The ID of the chat message that holds its card, so Open in chat can scroll to it. */
  messageId: z.string().nullable().optional(),
});
export type AskSnapshot = z.infer<typeof askSnapshotSchema>;

/** The answer to an ask. A choice's options are numbered 0 and 1 here. */
export const askAnswerSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("allow") }),
  z.object({ action: z.literal("block") }),
  z.object({ action: z.literal("edit"), body: z.string().max(200_000) }),
  z.object({ action: z.literal("pick"), option: z.union([z.literal(0), z.literal(1)]) }),
]);
export type AskAnswerBody = z.infer<typeof askAnswerSchema>;

export const answerRequestSchema = z.object({ answer: askAnswerSchema, key: z.string().min(1).max(64).optional() });
export type AnswerRequest = z.infer<typeof answerRequestSchema>;

/**
 * How an ask ended, as a type of its own so the card's icon never depends on the outcome's words:
 * approved (also with the user's edits, and a choice the user picked), declined (by the user),
 * timed_out (nobody answered; a choice goes with the Clot's pick), failed (approved but not carried
 * out, unclear, or the daemon stopped meanwhile), feedback (the user's reply was passed on instead
 * of an answer) and withdrawn (what it would act on changed).
 */
export const askResultSchema = z.enum(["approved", "declined", "timed_out", "failed", "feedback", "withdrawn"]);
export type AskResult = z.infer<typeof askResultSchema>;

export const answerResponseSchema = z.object({ outcome: z.string().nullable(), result: askResultSchema.nullable().optional() });
export type AnswerResponse = z.infer<typeof answerResponseSchema>;

/** What a chat's `ask` message shows: the open ask, or how a closed one ended. */
export const askCardSchema = z.object({
  id: z.number().int(),
  state: z.enum(["open", "busy", "closed"]),
  snapshot: askSnapshotSchema.optional(),
  /** For a closed one. */
  view: askViewSchema.optional(),
  summary: z.string().optional(),
  outcome: z.string().optional(),
  /** How it ended; absent on rows closed before it was kept (shown as approved). */
  result: askResultSchema.optional(),
});
export type AskCard = z.infer<typeof askCardSchema>;

export const messagePageSchema = z.object({
  /** Newest first. */
  messages: z.array(messageViewSchema.extend({ ask: askCardSchema.optional(), workers: z.array(z.lazy(() => workerViewSchema)).optional() })),
  hasMore: z.boolean(),
});
export type MessagePage = z.infer<typeof messagePageSchema>;

// ---------------------------------------------------------------- commands, workers, preferences

export const commandSchema = z.object({
  /** What follows the slash: "close", "calendar undo". */
  name: z.string(),
  /** The arguments it takes, in plain English: "low or medium". Empty when it takes none. */
  options: z.string(),
  /** The command does nothing without the options text (an effort level, an account): the menu completes it instead of running it. */
  required: z.boolean(),
  description: z.string(),
});
export type CommandInfo = z.infer<typeof commandSchema>;

export const WORKER_STATUSES = ["queued", "running", "pr-open", "done", "failed"] as const;
export type WorkerStatusName = (typeof WORKER_STATUSES)[number];

export const workerViewSchema = z.object({
  id: z.string(),
  title: z.string(),
  brief: z.string(),
  /** "Sonnet 5.5" */
  model: z.string(),
  effort: z.string(),
  status: z.enum(WORKER_STATUSES),
  pr: z.string().optional(),
});
export type WorkerView = z.infer<typeof workerViewSchema>;

export const workersResponseSchema = z.object({ turnId: z.string(), clot: z.string(), workers: z.array(workerViewSchema) });
export type WorkersResponse = z.infer<typeof workersResponseSchema>;

export const THEMES = ["system", "light", "dark"] as const;
export const CONTENT_WIDTHS = ["wide", "medium", "narrow"] as const;

/** The UI's own preferences: kept by the daemon so they follow the user from one device to the next. */
export const uiPrefsSchema = z.object({
  theme: z.enum(THEMES).default("system"),
  contentWidth: z.enum(CONTENT_WIDTHS).default("wide"),
  /** The side pane's width per Clot, as a fraction of the window (0 to 1). */
  paneWidths: z.record(z.string(), z.number().min(0).max(1)).default({}),
  notificationsDismissed: z.boolean().default(false),
});
export type UiPrefs = z.infer<typeof uiPrefsSchema>;
/** Part of the preferences: only what is given changes. */
export const uiPrefsPatchSchema = z.object({
  theme: z.enum(THEMES).optional(),
  contentWidth: z.enum(CONTENT_WIDTHS).optional(),
  paneWidths: z.record(z.string(), z.number().min(0).max(1)).optional(),
  notificationsDismissed: z.boolean().optional(),
});

// ---------------------------------------------------------------- integrations (connecting services)

export const AUDIENCE_NAMES = ["private", "team", "public"] as const;
export type AudienceName = (typeof AUDIENCE_NAMES)[number];

/** How a toolkit connects: Composio's own sign-in (oauth), a key the user pastes, or not at all. */
export const TOOLKIT_AUTH = ["oauth", "key", "none"] as const;
export type ToolkitAuth = (typeof TOOLKIT_AUTH)[number];

export const toolkitSummarySchema = z.object({
  slug: z.string(),
  name: z.string(),
  logo: z.string().optional(),
  description: z.string().optional(),
  auth: z.enum(TOOLKIT_AUTH),
  /** Whether Composio has a webhook trigger type for it (the polling time is used only when it has none). Absent when not known yet. */
  webhooks: z.boolean().optional(),
});
export type ToolkitSummaryView = z.infer<typeof toolkitSummarySchema>;
export const toolkitListSchema = z.object({ toolkits: z.array(toolkitSummarySchema) });

/** One connection attempt: what the dialog's Options step sends when Finish is pressed. `clot` absent = shared with every Clot. */
export const configureBodySchema = z.object({
  toolkit: z.string().regex(/^[a-z][a-z0-9_]*$/).max(64),
  clot: z.string().min(1).max(80).optional(),
  audience: z.enum(AUDIENCE_NAMES),
  selfIsUser: z.boolean(),
  events: z.boolean(),
  pollMinutes: z.number().int().min(1).max(1440).optional(),
  /** Google Calendar: how long before an event each reminder comes ("24h", "90m", "2d"). */
  leadTimes: z.array(z.string().regex(/^\d{1,4}[mhd]$/)).min(1).max(10).optional(),
  /** Stripe: also tell the Clot when a customer finishes paying at checkout. */
  checkoutCompleted: z.boolean().optional(),
  /** The same job again, after Back: it is updated, never doubled. */
  jobId: z.string().min(1).max(64).optional(),
  /** `<toolkit>:<account>` of the tool whose settings are being edited. */
  replaces: z.string().min(1).max(120).optional(),
});
export type ConfigureBody = z.infer<typeof configureBodySchema>;

export const INTEGRATION_STATES = ["working", "oauth", "key", "active", "failed"] as const;
export type IntegrationState = (typeof INTEGRATION_STATES)[number];

/** The data of an `integration.status` event. */
export const integrationStatusSchema = z.object({
  jobId: z.string(),
  toolkit: z.string(),
  state: z.enum(INTEGRATION_STATES),
  link: z.string().optional(),
  /** The configurer's step-by-step text for an API key: plain text, at most 1,200 characters. */
  instructions: z.string().optional(),
  keyName: z.string().optional(),
  error: z.string().optional(),
  /** Milliseconds since the epoch at which Done may be enabled (the link's time plus 5 s). */
  oauthReadyAt: z.number().optional(),
  /** The tool is saved, but only a restart of the daemon finishes wiring it (a built-in toolkit's own handlers). */
  needsRestart: z.boolean().optional(),
});
export type IntegrationStatus = z.infer<typeof integrationStatusSchema>;

/** `GET /integrations/jobs/:jobId`: the status, with the toolkit's name and the Clot it is for. */
export const integrationJobSchema = integrationStatusSchema.extend({
  name: z.string(),
  clot: z.string().nullable(),
  /** The entry is held until the Clot it names is created (New Clot's Tools step). */
  held: z.boolean().optional(),
});
export type IntegrationJob = z.infer<typeof integrationJobSchema>;

export const jobKeyBodySchema = z.object({ value: z.string().min(1).max(4000) });

export const TOOL_STATUSES = ["active", "waiting", "failed", "unknown"] as const;
export const toolViewSchema = z.object({
  /** `<toolkit>:<account>` */
  id: z.string(),
  toolkit: z.string(),
  account: z.string(),
  clot: z.string().nullable(),
  shared: z.boolean(),
  audience: z.enum(AUDIENCE_NAMES),
  /** How the tool was set up, for Edit settings. */
  selfIsUser: z.boolean(),
  events: z.boolean(),
  pollMinutes: z.number().int().optional(),
  /** Google Calendar: the lead times of its reminders, as given ("24h"). */
  leadTimes: z.array(z.string()).optional(),
  /** Stripe: whether completed checkouts are told. */
  checkoutCompleted: z.boolean().optional(),
  logo: z.string().optional(),
  status: z.enum(TOOL_STATUSES),
  restartNeeded: z.literal(true).optional(),
});
export type ToolView = z.infer<typeof toolViewSchema>;

export const inboxBodySchema = z.object({
  address: z.email().max(200),
  account: z.string().regex(/^[a-z][a-z0-9-]{0,30}$/).optional(),
  /** Needed to add an inbox; optional when editing one (left out, the saved password stays). */
  password: z.string().min(1).max(500).optional(),
  mailboxes: z.array(z.string().min(1).max(100)).min(1).max(10).default(["INBOX"]),
  clot: z.string().optional(),
  imap: z.object({ host: z.string().min(1).max(200), port: z.number().int().min(1).max(65535) }).optional(),
  smtp: z.object({ host: z.string().min(1).max(200), port: z.number().int().min(1).max(65535) }).optional(),
  /** Other addresses delivered into this inbox. Given, it replaces the saved list (empty clears it). */
  addresses: z.array(z.email().max(200)).max(20).optional(),
  /** Whether the Clots are told the inbox's address, or only its name. */
  tellAddress: z.boolean().optional(),
});
export type InboxBody = z.infer<typeof inboxBodySchema>;

/**
 * What a person reads when something fails, worded in one place for the daemon and the web app alike: text that came from the
 * network, Composio, GitHub, Docker, git or a validator is shown only as a sentence for people, or as a plain line for the kind of failure.
 */

/** What an unknown failure says when there is nothing more specific. */
export const GENERIC_ERROR = "Something went wrong. Try again in a moment.";

/** Text that is a raw status, class, code or stack in a sentence's clothes. */
const RAW = /\b(?:HTTP|status|code)\s*[:=]?\s*[1-5]\d\d\b|\b[45]\d\d\s+[A-Z][a-z]|\bE[A-Z]{4,}\b|[{}]|\bat\s+\S+:\d+|\n|\bundefined\b|\[object|\bnull\b/;

/**
 * Whether text can be shown as it is: a sentence the daemon wrote for a person ("There is a Clot named Home already."), not a code,
 * a status line, a stack or a library's message ("invalid request", "Failed with 500", "TypeError: x", "Too small: expected...").
 */
export function isSentence(text: string): boolean {
  if (text.length < 8 || text.length > 240) return false;
  if (!/^[A-Z0-9]/.test(text) || !/[.?!"')]$/.test(text)) return false;
  if (/^Failed with \d+/.test(text) || /^\w*Error\b/.test(text) || RAW.test(text)) return false;
  // The words of a validator, not of a person.
  if (/^(Invalid|Required|Expected|Too (small|big)|Unrecognized|String must|Number must)\b/.test(text)) return false;
  return true;
}

/** Known failures that arrive as raw text (from Composio, GitHub, Docker, git, the network, a validator), and what to tell a person. First match wins. */
const KNOWN: [RegExp, string][] = [
  [/cannot connect to the docker|docker daemon|docker_engine|dockerDesktop|error during connect|docker.*not running/i, "Docker isn't responding. Open Docker Desktop, then try again."],
  [/could not read from remote|repository not found|authentication failed for|fatal: |remote: /i, "The repository could not be downloaded. Check its name and that the Clots account can reach it."],
  [/ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|ENETUNREACH|socket hang up|fetch failed|network|offline/i, "The connection failed. Check the internet connection and try again."],
  [/ETIMEDOUT|timed? ?out|timeout|aborted/i, "The service took too long to answer. Try again."],
  [/\b429\b|rate.?limit|too many requests|quota/i, "The service is limiting requests right now. Wait a few minutes and try again."],
  [/\b401\b|unauthori[sz]ed|bad credentials|invalid[ _-]?(api[ _-]?)?(key|token|credentials)|authentication|expired token|revoked/i, "The service did not accept the sign-in. Connect it again and try once more."],
  [/\b403\b|forbidden|permission denied|access denied|not permitted/i, "That account isn't allowed to do that. Check its access and try again."],
  [/\b404\b|not found|no such/i, "That could not be found. It may have been removed."],
  [/\b5\d\d\b|bad gateway|service unavailable|gateway time-?out|internal server error|overloaded/i, "The service is having trouble right now. Try again in a moment."],
  [/^(Invalid|Required|Expected|Too (small|big)|Unrecognized|String must|Number must)\b|\bexpected .+ received\b|\bzod\b|\bschema\b/i, "That value isn't allowed. Check it and try again."],
];

/**
 * What to tell a person about text that came from somewhere else (a job's failure, a field's reason, a config file's error): the text
 * itself when it is a sentence for people, a plain line for a kind of failure it names, otherwise `fallback`. Never the raw text.
 */
export function readableText(text: unknown, fallback: string): string {
  if (typeof text !== "string") return fallback;
  const trimmed = text.trim();
  if (isSentence(trimmed)) return trimmed;
  for (const [pattern, sentence] of KNOWN) if (pattern.test(trimmed)) return sentence;
  return fallback;
}

/** What a failed build says above its log, by what the log shows. The log is for troubleshooting; this line says what to do. */
export function readableBuildFailure(log: string | undefined): string {
  const known = KNOWN.slice(0, 5).find(([pattern]) => pattern.test(log ?? ""));
  return known === undefined ? "The build did not finish. The log below shows where it stopped." : `${known[1]} The log below has the details.`;
}


/** The part of a validator's issue this reads: zod's issues have these fields. */
export interface IssueLike {
  code: string;
  message: string;
  minimum?: unknown;
  maximum?: unknown;
  origin?: unknown;
  format?: unknown;
}

/** A validator's refusal of one value, in words a person reads beside a field ("That must be at least 1."). */
export function readableIssue(issue: IssueLike): string {
  const count = issue.origin === "string" || issue.origin === "array" ? " characters or items" : "";
  if (issue.code === "too_small" && issue.minimum !== undefined) return issue.origin === "string" && issue.minimum === 1 ? "A value is needed." : `That must be at least ${String(issue.minimum)}${count === "" ? "" : " long"}.`;
  if (issue.code === "too_big" && issue.maximum !== undefined) return `That must be at most ${String(issue.maximum)}${count === "" ? "" : " long"}.`;
  if (issue.code === "invalid_format" && (issue.format === "url" || issue.format === "email")) return issue.format === "url" ? "That isn't a valid web address." : "That isn't a valid email address.";
  if (issue.code === "invalid_type") return "That isn't the kind of value this needs. Check it and try again.";
  return readableText(issue.message, "That value isn't allowed. Check it and try again.");
}
