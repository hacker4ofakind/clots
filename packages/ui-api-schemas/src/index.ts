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

export const answerResponseSchema = z.object({ outcome: z.string().nullable() });
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
});
export type InboxBody = z.infer<typeof inboxBodySchema>;
