import { fileURLToPath } from "node:url";
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import { recloneWorkspace, stopContainer, addWorktree, containerName, defaultBranch, ensureContainer, hasOwnLogin, installPlugin, killStrayClaude, prsForBranch, refreshMainCheckout, removeWorktree, sessionEnv, sessionExistsAsync, worktreeExists } from "./agent/container.js";
import { DockerMemoryFolders } from "./agent/memory-folder.js";
import { CLOT_SYSTEM_PROMPT, composioNote, HOME_SYSTEM_PROMPT } from "./agent/prompts.js";
import { SdkRunner } from "./agent/runner.js";
import { Clot } from "./clot.js";
import { applyChangeLive, check, getAt, missingEnvKeys, parseKey } from "./config-edit.js";
import { configKind, restartKind } from "./asks/config.js";
import { announceSkipped } from "./skipped-notice.js";
import { calendarPollingCalls, type Config, HOME_CLOT, isCalendar, type EmailAccount, legacyKeysIn, renamedKeysIn, type AccountBase, type NotionAccount } from "./config.js";
import { ConfigStore } from "./config-store.js";
import { registerSettingsRoutes } from "./ui-api/routes/settings.js";
import { registerIntegrationRoutes } from "./ui-api/routes/integrations.js";
import { registerClotAdminRoutes } from "./ui-api/routes/clots-admin.js";
import { ClotCreator, onboardingMessage } from "./onboarding/create.js";
import { IconStore } from "./onboarding/icons.js";
import { checklist, markPush, markWebhook } from "./onboarding/checklist.js";
import { ConversationService } from "./conversation/conversation.js";
import { LiveEnv } from "./live-env.js";
import { EventBus } from "./ui-api/events.js";
import { registerClotRoutes } from "./ui-api/routes/clots.js";
import { registerPrefsRoutes } from "./ui-api/routes/prefs.js";
import { registerPushRoutes } from "./ui-api/routes/push.js";
import { newVapidKeys, Push, webPushSender } from "./push.js";
import { setEnvKey } from "./env-file.js";
import { registerWorkerRoutes } from "./ui-api/routes/workers.js";
import { ensureEnvKey } from "./ui-api/secrets.js";
import { UiApi } from "./ui-api/server.js";
import { githubCommentSender } from "./events/github-comment.js";
import { isSelfCaused, repoSlug } from "./events/github.js";
import { enricherBySource, type Enricher } from "./enrich.js";
import { SdkRoutingCall } from "./routing-call.js";
import { bindingResolver, EventRouter } from "./routing.js";
import type { ClotEvent } from "./events/types.js";
import { inlineCommentReader } from "./events/review-comments.js";
import { McpHub, oauthCallbackHandler, sdkOpener } from "./mcp/hub.js";
import { Watcher, type Hub } from "./watch.js";
import { composioHub } from "./composio/hub.js";
import { readEnvFile } from "./env-file.js";
import { recipeHandler } from "./webhook-recipe.js";
import { StoredOAuth } from "./mcp/oauth.js";
import { CalendarFeed } from "./sources/calendar.js";
import { calendarOverComposio } from "./sources/calendar-composio.js";
import { composioKind } from "./asks/composio.js";
import { sourcesApplier } from "./integrations/apply.js";
import { Configurer, sdkConfigurerModel } from "./integrations/configurer.js";
import { IntegrationJobs } from "./integrations/jobs.js";
import { ComposioActions } from "./composio/actions.js";
import { ComposioAuthoring } from "./composio/authoring.js";
import { sdkComposioApi } from "./composio/api.js";
import { Composio, WEBHOOK_SECRET_KEY } from "./composio/component.js";
import { composioHandler } from "./composio/intake.js";
import { Meter } from "./composio/meter.js";
import { RecipeReads, recipeEnricher } from "./composio/recipe.js";
import { isBuiltinToolkit } from "./events/kinds.js";
import { sdkWriteReviewer } from "./composio/reviewer.js";
import { defFor } from "./composio/toolkits/index.js";
import { ComposioUndo } from "./composio/undo.js";
import { genericMapper } from "./sources/generic.js";
import { draftFates, imapflowClient, MailboxListener, saveDraft, saveSent } from "./sources/imap.js";
import { EmailSync } from "./email-sync.js";
import { diffClots, diffServers, registerLiveConfig } from "./live-config.js";
import { Asks } from "./asks.js";
import { askEmail, emailKind, type SendRequest } from "./asks/email.js";
import { askChoice, choiceKind } from "./asks/choice.js";
import { askMerge, mergeKind, withdrawMerges } from "./asks/merge.js";
import { memoryKind } from "./asks/memory.js";
import { askRule, ruleKind } from "./asks/rule.js";
import { CalendarUndo } from "./calendar-undo.js";
import { DraftTracker } from "./drafts.js";
import { linearCommentSender, linearEnricher, linearMapper } from "./sources/linear.js";
import { notionCommentSender, notionEnricher, notionHandler } from "./sources/notion.js";
import { emailReplySender, mailer, smtpTransport } from "./sources/smtp.js";
import { stripeEnricher, stripeMapper } from "./sources/stripe.js";
import { GlobalMemory } from "./global-memory.js";
import { handOver } from "./hand-over.js";
import { Supervisor } from "./listeners.js";
import { githubHandler, startIntake, type Handler, type PullRequestChange } from "./intake.js";
import { Pipeline } from "./pipeline.js";
import { SdkRouter } from "./router.js";
import { RuleWriter } from "./rule-writer.js";
import { Rulebook, watchTarget } from "./rulebook.js";
import { matchStanding } from "./standing.js";
import { Store } from "./store.js";
import { makeTools, showRules, type ToolDeps } from "./tools.js";
import { SdkTriage } from "./triage.js";
import { Workers } from "./workers.js";
import { GateTicker } from "./gate-ticker.js";
import { gateAt } from "./gates.js";
import { UsageMeter } from "./usage-meter.js";
import { SpendLog } from "./spend.js";
import { skipList, Sweeper } from "./sweep.js";
import { CacheKeeper } from "./keep-warm.js";
import { makeReground } from "./reground.js";

// The daemon starts with `node --env-file`, so a key written to .env later never reaches process.env: secrets are read through this.
const bus = new EventBus();
const ENV_FILE = ".env";
const uiSecret = ensureEnvKey(ENV_FILE, "CLOTS_UI_SECRET");
const liveEnv = new LiveEnv(ENV_FILE);
const configFile: unknown = JSON.parse(fs.readFileSync("clots.config.json", "utf8"));
for (const key of legacyKeysIn(configFile)) console.log(`[config] "${key}" in clots.config.json is not used any more and is ignored.`);
for (const [old, now] of renamedKeysIn(configFile)) console.log(`[config] "${old}" in clots.config.json is now called "${now}"; its value is used as it is. Rename it when you next edit the file.`);
// The configuration is owned by the config store: it validates every change, writes atomically, watches the file and applies what it can live.
const configStore = new ConfigStore({
  file: "clots.config.json",
  envFile: ENV_FILE,
  env: liveEnv,
  log: (text) => console.log(text),
  // The moment a configuration is in force, before its apply handlers run: whatever reads `config` at call time sees it.
  onAdopt: (next) => {
    config = next;
  },
  onChanged: (e) => {
    config = configStore.current;
    announceConfig({ applied: e.keys.filter((k) => !e.needsRestart.includes(k)), needsRestart: e.needsRestart, fromFile: e.fromFile, error: e.error });
  },
});
let config = configStore.current;
const skippedAccounts = configStore.skipped;
/** Tells the UI what changed in the configuration, and whether a hand edit was picked up or refused. */
function announceConfig(e: { applied: string[]; needsRestart: string[]; fromFile: boolean; error?: string }): void {
  bus.emit("config.changed", { keys: e.applied, needsRestart: e.needsRestart, fromFile: e.fromFile, ...(e.error === undefined ? {} : { error: e.error }) });
}
if (config.ui.owner === undefined) console.warn('[config] "ui.owner" is not set in clots.config.json: the web app refuses everyone until it is.');
for (const s of skippedAccounts) console.error(`[config] sources.composio entry ${s.entry} is not usable and is left out: ${s.problem}`);

// The intake port is taken first, before anything is read or changed. It is what keeps a second
// daemon from starting beside this one, and it lets GitHub's deliveries be stored while the rest
// starts up, which can take as long as finishing a turn that a restart cut off.
fs.mkdirSync("data", { recursive: true });
const store = new Store("data/clots.db");
let onEvent: (event: ClotEvent) => void = () => undefined;
/**
 * Hands a stored event on: to the pipeline, or nowhere when its source already knew it goes no
 * further. Before the pipeline exists, an event stays as received and is picked up at its start.
 */
const deliver = (event: ClotEvent, dropped?: string): void => {
  if (dropped !== undefined) store.setEventStatus(event.id, "dropped", dropped);
  else onEvent(event);
};
/**
 * The intake's paths. Each source adds its own as it is set up below. A request to a path that is
 * not here yet is answered 404, and webhook sources deliver it again later.
 */
/** Set once the workers exist. A pull request closed before then is caught by their check with GitHub at startup. */
let onPullRequest: (a: PullRequestChange) => Promise<void> = async () => undefined;
/** The Clots share one GitHub account; its login is what marks an event as caused by a Clot. Read when the first container starts; set before the intake takes deliveries so a push handled earlier finds it. */
let clotLogin = "";
const handlers = new Map<string, Handler>([
  ["/webhooks/github", githubHandler({ secret: config.webhookSecret, insertEvent: (event) => store.insertEvent(event), now: () => Date.now(), onPullRequest: (a) => onPullRequest(a), onPing: (repo) => markWebhook(store, repo), onPush: (repo, sender) => void markPush(store, repo, sender, clotLogin) })],
]);
/**
 * Composio's path answers from the start: 503 until the daemon has set it up, which tells Composio to deliver
 * again, instead of 404, which says there is nothing here.
 */
let composioIntake: Handler = async () => ({ status: 503, text: "starting" });
// Whenever there is a Composio key, not only when an account exists: a tool connected from the web app is live with no restart.
if (config.composioApiKey !== undefined) handlers.set("/webhooks/composio", (req) => composioIntake(req));
/** The webhook recipes' paths, /webhooks/r/<name>, set once the rulebook is read. */
let recipeHandlers: (name: string) => Handler | undefined = () => undefined;
const intake = startIntake({
  port: config.intakePort,
  handlerFor: (path) => handlers.get(path) ?? (path.startsWith("/webhooks/r/") ? recipeHandlers(path.slice("/webhooks/r/".length)) : undefined),
  onAnswer: (answer) => {
    if (answer.event) deliver(answer.event, answer.dropped);
  },
});
await new Promise<void>((resolve) => {
  intake.once("listening", resolve);
  intake.once("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EADDRINUSE") console.error(`Port ${config.intakePort} is in use: another daemon is probably running. Stop it before starting this one.`);
    else console.error("[events] the intake server could not start:", error);
    process.exit(1);
  });
});
console.log(`[events] listening for webhooks on http://127.0.0.1:${config.intakePort}${config.publicUrl === "" ? "" : `, public at ${config.publicUrl}`}`);

/**
 * Every Clot the daemon runs: one per project, and the home Clot when the configuration asks for it.
 * The home Clot comes first: its startup check of the global memories runs before any project Clot's turn.
 */
const definitions: { name: string; repoUrl?: string; testCommand?: string }[] = [...(config.home ? [{ name: HOME_CLOT }] : []), ...config.clots];
const names = definitions.map((c) => c.name);
/** Every Clot with a line on what it looks after: what the sweep and each Clot's own session are told of them. */
const roster = (): { name: string; about: string }[] => [
  ...(config.home ? [{ name: HOME_CLOT, about: "anything that belongs to no project" }] : []),
  ...config.clots.map((c) => ({ name: c.name, about: c.about ?? `the project in the repository ${repoSlug(c.repoUrl)}` })),
];

// Push: the keys are made at first start and kept in .env.
if (!readEnvFile(ENV_FILE).VAPID_PUBLIC_KEY || !readEnvFile(ENV_FILE).VAPID_PRIVATE_KEY) {
  const keys = newVapidKeys();
  setEnvKey(ENV_FILE, "VAPID_PUBLIC_KEY", keys.publicKey);
  setEnvKey(ENV_FILE, "VAPID_PRIVATE_KEY", keys.privateKey);
  liveEnv.reload();
}
const push = new Push({
  store: store.push,
  now: () => Date.now(),
  send: webPushSender({ publicKey: liveEnv.get("VAPID_PUBLIC_KEY")!, privateKey: liveEnv.get("VAPID_PRIVATE_KEY")!, subject: config.publicUrl === "" ? "https://localhost" : config.publicUrl }),
});
const conv = new ConversationService({
  store,
  bus,
  now: () => Date.now(),
  newId: randomUUID,
  onReply: (clot, message) => void push.reply(clot, message.text).catch(() => undefined),
});
// What the user is told while away: a new ask, one in its last minute, a choice the timeout decided, a Clot paused or failed.
bus.subscribe((event) => {
  const d = event.data as any;
  if (event.type === "ask.opened") void push.askOpened(d).catch(() => undefined);
  else if (event.type === "ask.updated" && d.timer === "urgent") void push.askUrgent(d).catch(() => undefined);
  else if (event.type === "ask.closed" && d.kind === "choice" && String(d.outcome).startsWith("No answer within")) void push.choiceDecided(d.clot, d.id, d.outcome).catch(() => undefined);
  else if (event.type === "clot.state" && (d.state === "paused" || d.state === "failed")) void push.clotStopped(d.clot, d.state, d.reason).catch(() => undefined);
});
/** What the router, triage and the routing call cost, booked to the Clot they were for; the routing call belongs to the daemon. */
const bookCall = (who: "triage" | "routing") => (usd: number, clot: string | null) => void spend.book({ clot: clot ?? "daemon", who, total: usd }).catch((error) => console.error("booking a call's cost failed:", error));
const router = new SdkRouter({ onCost: bookCall("triage") });
const clots = new Map<string, Clot>();
/** Parts built late in this file that a change to the configuration reaches: set when each exists. */
const late: { sweeper?: Sweeper; pipeline?: Pipeline; email?: (accounts: EmailAccount[]) => Promise<void>; mcp?: (next: Config["mcpServers"], prev: Config["mcpServers"]) => void } = {};
const runners = new Map<string, SdkRunner>();
const repoOf = new Map(definitions.map((c) => [c.name, c.repoUrl === undefined ? null : (repoSlug(c.repoUrl) ?? null)]));

/** The Clots whose container has a login of its own (made with `claude /login`), which is what brings plan limits and connectors. */
const ownLogins = new Set<string>();
/** The account's container: the home Clot's when it has its own login, else the first Clot's that has one. */
const accountClot = (): string | undefined => (ownLogins.has(HOME_CLOT) ? HOME_CLOT : names.find((name) => ownLogins.has(name)));

// Readings of the account's usage. Kept across restarts, and decided from before any Clot drains its queue.
const meter = new UsageMeter({
  store,
  now: () => Date.now(),
  read: async () => runners.get(accountClot() ?? (config.home ? HOME_CLOT : names[0]!))?.readUsage(),
});
/** What the scarce and lead-in gates say now. The usage-limit pause is each Clot's own, and is not part of it. */
const gate = () => gateAt(Date.now(), config.gates, config.timeZone, meter.snapshot());
let sweepTick: () => Promise<void> = async () => undefined;
const ticker = new GateTicker({
  meter,
  gates: config.gates,
  timeZone: config.timeZone,
  now: () => Date.now(),
  kickAll: () => {
    for (const clot of clots.values()) clot.kick();
  },
  wakeWorkers: () => workers.wake(),
  sweep: () => sweepTick(),
  keepWarm: () => keeper.tick(),
});
const keeper = new CacheKeeper({
  names: () => names,
  now: () => Date.now(),
  lastTurnAt: (name) => clots.get(name)?.lastTurnAt(),
  ping: (name) => clots.get(name)?.keepWarm() ?? Promise.resolve(),
});
meter.onChange(() => ticker.recheck());

const spend = new SpendLog({ store, now: () => Date.now(), timeZone: config.timeZone, weeklyWarnUsd: config.spend.weeklyWarnUsd, post: (clot, text) => postLive(clot, text), gate, meter });

/** Follows the drafts the Clots save, and before each turn tells the Clot which the user sent or deleted. Made before the Clots start, so that their first turns already check; it follows the mail accounts as they change. */
const drafts = new DraftTracker({ store, accounts: config.sources.email, lookup: draftFates, timeZone: config.timeZone, now: () => Date.now(), log: (text, error) => console.warn(text, error) });

/** Posts a note in a Clot's chat. What the daemon says there never enters the Clot's session. */
const say = async (clot: string, text: string): Promise<void> => {
  await conv.post(clot, text, { kind: "note" }).catch(() => undefined);
};
/** Like say, but a failed post throws: the spend warning is tried again when it fails. */
const postLive = async (clot: string, text: string): Promise<void> => {
  await conv.post(clot, text, { kind: "note" });
};

const rulebook = new Rulebook(config.rulebookDir, names, (file, problem) => {
  console.error(`[rulebook] ${file} is not usable: ${problem}`);
  // A Clot's own file is reported in its channel; the global file in every Clot's.
  const affected = file === "global.yaml" ? names : [file.replace(/\.yaml$/, "")];
  for (const name of affected) void say(name, `\`${file}\` in the rulebook could not be used, so its last good version stays in force.\n${problem}`);
});
// A watch or webhook recipe cannot take the name of a toolkit that sources.composio names: the toolkit is its events' source.
rulebook.setReserved(config.sources.composio.map((a) => a.toolkit));
// The watches on Composio accounts share the month's polling limit with the calendars.
rulebook.setCalendarCalls(calendarPollingCalls(config.sources.composio));
rulebook.ensure();
rulebook.load();
rulebook.watch();

const workers = new Workers({
  store,
  runnerFor: (clot) => runners.get(clot)!,
  container: {
    defaultBranch: (clot) => defaultBranch(containerName(clot)),
    addWorktree: (clot, o) => addWorktree(containerName(clot), { ...o, githubToken: config.githubToken }),
    removeWorktree: (clot, path) => removeWorktree(containerName(clot), path),
    worktreeExists: (clot, path) => worktreeExists(containerName(clot), path),
    sessionExists: (clot, id) => sessionExistsAsync(containerName(clot), id),
  },
  prsForBranch: (clot, branch, repo) => prsForBranch(containerName(clot), { branch, repo, githubToken: config.githubToken }),
  knows: (clot) => runners.has(clot),
  repoOf: (clot) => repoOf.get(clot) ?? null,
  limit: config.maxWorkers,
  now: () => Date.now(),
  newId: randomUUID,
  random: () => randomBytes(2).toString("hex"),
  every: (ms, fn) => {
    const timer = setInterval(fn, ms);
    return () => clearInterval(timer);
  },
  after: (ms, fn) => {
    const timer = setTimeout(fn, ms);
    return () => clearTimeout(timer);
  },
  kick: (clot) => clots.get(clot)?.kick(),
  pause: async (clot, resetsAt) => clots.get(clot)?.pauseFor(resetsAt),
  announce: async (clot, turnId) => void (await conv.postWorkers(clot, turnId)),
  gate,
  timeZone: config.timeZone,
  book: (a) => spend.book(a),
});
onPullRequest = (a) => workers.onPullRequest(a);
// Database only, and before any Clot starts: their first turns can start workers.
workers.recover();

const writer = new RuleWriter({ rulebook, store });

/** Sends as the user: standing-rule replies and approved emails, each with a copy in Sent where the server does not file one. */
const sendMail = mailer({ store, transport: smtpTransport, saveSent, log: (text, error) => console.warn(text, error) });

// The kinds of ask. The email kind reads the accounts as they are now, so the first inbox added needs no restart.
const ruleAsk = ruleKind({ writer, store });
const emailAsk = emailKind({ store, accounts: () => config.sources.email, send: sendMail });
let memory: GlobalMemory;
const memoryAsk = memoryKind({ resolve: (payload, answer) => memory.resolve(payload, answer), restore: (payload) => memory.restore(payload), inForce: (payload) => memory.inForce(payload) });
const mergeAsk = mergeKind({ token: config.githubToken });
const choiceAsk = choiceKind();
// Changing the configuration and restarting: asked of the user, and carried out by the home Clot's tools only.
const CONFIG_FILE = "clots.config.json";
const configAsk = configKind({ apply: (key, value) => applyChangeLive(configStore, liveEnv.all(), key, value) });
/** Whether any Clot has a turn running, or any worker is running. */
const turnsRunning = (): boolean => [...clots.values()].some((c) => c.isBusy()) || [...clots.keys()].some((name) => store.workersOf(name).some((w) => w.status === "running"));
const restartAsk = restartKind({
  async restartWhenIdle(beforeExit) {
    const give = Date.now() + 30 * 60_000;
    while (turnsRunning()) {
      if (Date.now() > give) return false;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    await beforeExit();
    // The service's Restart=always starts it again after a few seconds.
    setTimeout(() => process.exit(0), 1000);
    return true;
  },
});
const after = (ms: number, fn: () => void) => {
  const timer = setTimeout(fn, ms);
  return () => clearTimeout(timer);
};
const supervisor = new Supervisor({ schedule: (ms, fn) => after(ms, fn) });
/** Tells the user about an account: in its Clot's channel, or in every Clot's channel when it is shared. */
const tellAccount =
  (account: { clot?: string }) =>
  async (text: string): Promise<void> => {
    for (const name of account.clot === undefined ? names : [account.clot]) await say(name, text);
  };

// Composio: the accounts, the one component that talks to it, and what the Clots may do through it. The
// Composio key is read here and goes nowhere else: no container, no session, no log line.
/** The home Clot's channel, or the first Clot's when there is no home Clot. */
const tellHome = (text: string): Promise<void> => say(config.home ? HOME_CLOT : names[0]!, text);
/** An account's own Clot's channel, or the home Clot's for a shared account. */
const tellComposio = (account: { clot?: string }) => (text: string): Promise<void> => (account.clot === undefined ? tellHome(text) : say(account.clot, text));
const composioMeter = new Meter({ store, now: () => Date.now(), tellHome });
// Made whenever the Composio key exists, so the web app can list toolkits and connect the first one without a restart.
const composioApi = config.composioApiKey === undefined ? undefined : sdkComposioApi(config.composioApiKey);
const composio =
  composioApi === undefined
    ? undefined
    : new Composio({
        api: composioApi,
        store,
        accounts: config.sources.composio,
        skipped: skippedAccounts.map((s) => s.entry),
        publicUrl: config.publicUrl,
        tell: (account, text) => tellComposio(account)(text),
        tellHome,
        now: () => Date.now(),
        schedule: after,
        supervisor,
        meter: composioMeter,
        recipe: (toolkit) => rulebook.composioRecipe(toolkit),
      });
let composioActions: ComposioActions | undefined;
const composioAsk = composio === undefined ? undefined : composioKind({ composio, actions: { executeWrite: (o) => composioActions!.executeWrite(o) } });
/** The calendars, each over its own connection. */
const calendars = new Map(config.sources.composio.filter(isCalendar).map((account) => [account.account, calendarOverComposio(composio!, account, config.timeZone)]));
const feeds = new Map<string, CalendarFeed>();
/** A change of the user's zone: each calendar is made again for it, and the undo reads the new zone. The feeds and the tool look the calendars up at each call. */
const calendarZone = (zone: string): void => {
  for (const account of config.sources.composio.filter(isCalendar)) calendars.set(account.account, calendarOverComposio(composio!, account, zone));
  calendarUndo?.setTimeZone(zone);
  for (const feed of feeds.values()) feed.setTimeZone(zone);
  if (toolDeps.calendar !== undefined) toolDeps.calendar.timeZone = zone;
};
const calendarUndo = calendars.size === 0 ? undefined : new CalendarUndo({ store, call: (account, req) => calendars.get(account)!.call(req), timeZone: config.timeZone });
const composioUndo = composio === undefined ? undefined : new ComposioUndo({ composio, store });

const asks = new Asks({
  store,
  conv,
  now: () => Date.now(),
  kick: (clot) => clots.get(clot)?.kick(),
  after,
  kinds: [ruleAsk, memoryAsk, mergeAsk, choiceAsk, configAsk, restartAsk, emailAsk, ...(composioAsk ? [composioAsk] : [])],
  emit: (type, data) => void bus.emit(type, data),
  timeoutMs: () => config.askTimeoutMinutes * 60_000,
});
let composioAuthoring: ComposioAuthoring | undefined;
if (composio !== undefined && composioAsk !== undefined) {
  composioActions = new ComposioActions({
    composio,
    store,
    // The reviewer's cost is booked to the Clot the write is for, as the triage calls are.
    reviewer: sdkWriteReviewer((usd, clot) => bookCall("triage")(usd, clot)),
    ask: (clot, payload, o) => asks.open(composioAsk, clot, payload, { summary: o.summary, dedupe: o.dedupe, max: 5, outsider: o.outsider }),
    say,
    now: () => Date.now(),
  });
  composioAuthoring = new ComposioAuthoring({
    composio,
    api: composioApi!,
    store,
    countCall: (ctx) => composioActions!.countCall(ctx),
    meter: composioMeter,
    now: () => Date.now(),
    recipe: (toolkit) => rulebook.composioRecipe(toolkit),
    clotNames: () => [...names],
    // A shipped recipe is in no file, so nothing shadows a recipe set in one.
    recipeFile: (toolkit) => rulebook.recipeFile(toolkit)?.file || undefined,
  });
}
onPullRequest = async (a) => {
  await workers.onPullRequest(a);
  await withdrawMerges(asks, a);
};

/** The home Clot's tools for the configuration and for restarting, and the other Clots' way to pass such a request on. */
function daemonConfigTools(): NonNullable<ToolDeps["daemonConfig"]> {
  const readFile = () => JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")) as Record<string, unknown>;
  const show = (value: unknown, max = 3000) => {
    const text = JSON.stringify(value, null, 2) ?? "not set";
    return text.length > max ? `${text.slice(0, max)}\n[cut]` : text;
  };
  return {
    get(key) {
      const file = readFile();
      const value = key === undefined ? file : getAt(file, key.split("."));
      return value === undefined ? `${key} is not set.` : show(value, 20_000);
    },
    async set(clot, key, value) {
      const path = parseKey(key);
      if (typeof path === "string") return `Not changed: ${path}`;
      // Checked before the user is asked: they are never shown a change that cannot be saved.
      const file = readFile();
      const checked = check(file, key, value);
      if (typeof checked === "string") return checked;
      const missing = missingEnvKeys(checked.candidate, liveEnv.all());
      const filed = await asks.open(configAsk, clot, { key, value, current: getAt(file, path) }, { summary: `change ${key}`, dedupe: key, max: 3 });
      return missing.length === 0 ? filed : `${filed}\nOnce it is saved the user must add ${missing.map((k) => `\`${k}\``).join(", ")} to the \`.env\` file in ${process.cwd()}.`;
    },
    async restart(clot, reason) {
      if (process.env.INVOCATION_ID === undefined) return "Not asked: this daemon is not running as a systemd service, so nothing would start it again after it stopped. Tell the user to restart it themselves.";
      return asks.open(restartAsk, clot, { reason }, { summary: "restart the daemon", dedupe: "restart", max: 1 });
    },
    async toHome(from, request) {
      const home = clots.get(HOME_CLOT);
      if (home === undefined) return "Not passed on: there is no home Clot.";
      const link = await home.queueRequest(from, request);
      return `Passed to the home Clot, which will carry it out and answer in ${link}. Tell the user to follow it there.`;
    },
  };
}

const toolDeps: ToolDeps = {
  watchBudgetProblem: (recipe) => rulebook.watchBudgetProblem(recipe),
  rulebook,
  writer,
  asks: {
    rule: (clot, scope, edit, outsider) => askRule(asks, ruleAsk, { writer, store, max: config.maxProposals }, clot, scope, edit, outsider),
    email: (clot: string, req: SendRequest, outsider: boolean) => askEmail(asks, emailAsk, config.maxProposals, clot, req, outsider),
    merge: (clot, a, outsider) =>
      askMerge(asks, mergeAsk, { token: config.githubToken, repoOf: (name) => repoOf.get(name) ?? null, workerRepos: (name) => [...new Set(store.workersOf(name).flatMap((w) => (w.prRepo === null ? [] : [w.prRepo])))] }, clot, a, outsider),
    choice: (clot, a, outsider) => askChoice(asks, choiceAsk, clot, a, outsider),
  },
  store,
  senders: { github_comment: githubCommentSender(config.githubToken) },
  say,
  handOver: (from, eventId, to, byRequest) => handOver({ store, clots, say }, from, eventId, to, byRequest),
  ...(config.home ? { daemonConfig: daemonConfigTools() } : {}),
  workers,
};

memory = new GlobalMemory({
  store,
  // A Clot's memory folder is named after the directory its turns start in: the home Clot has no clone.
  folders: new DockerMemoryFolders((name) => (name === HOME_CLOT ? "/workspace" : "/workspace/repo")),
  home: HOME_CLOT,
  clots: names,
  say,
  isBusy: (name) => clots.get(name)?.isBusy() ?? false,
  asks: {
    open: (payload) => asks.open(memoryAsk, HOME_CLOT, payload, { summary: `Global memory \`${payload.file}\` from an outsider's turn`, dedupe: `${payload.file}:${payload.text}`, max: config.maxProposals }),
    withdraw: (id, reason) => asks.withdraw(id, reason),
  },
});

// The UI's API: loopback only, on a port of its own (8788), refusing every request without the shared secret.
const UI_API_PORT = 8788;
const ui = new UiApi({ secret: () => uiSecret, bus });
registerClotRoutes(ui, { store, conv, asks, config: () => config, clots: () => clots, names: () => names, now: () => Date.now() });
registerWorkerRoutes(ui, { store });
registerSettingsRoutes(ui, {
  config: configStore,
  announce: announceConfig,
  reorder: (order) => {
    names.splice(0, names.length, ...order);
  },
  removeClot: (name) => removeClotLive(name),
  building: (name) => creator.isBuilding(name),
});
/** Takes a Clot out of the running daemon: its container stops, what waits for it is dropped. Its volumes and its chat stay. */
async function removeClotLive(name: string): Promise<void> {
  // The configuration handler and the delete route both call this: the second finds nothing left to do.
  if (!names.includes(name) && !clots.has(name)) return;
  const at = names.indexOf(name);
  if (at >= 0) names.splice(at, 1);
  const definition = definitions.findIndex((c) => c.name === name);
  if (definition >= 0) definitions.splice(definition, 1);
  clots.delete(name);
  runners.delete(name);
  repoOf.delete(name);
  store.clearInbox(name);
  await stopContainer(containerName(name));
  bus.emit("clot.state", { clot: name, state: "idle", removed: true });
}
// Connecting services: the dialog's jobs. Without a Composio key there are none, and the routes that need Composio say so.
const restartNeeded = new Set<string>();
const integrationJobs =
  composioApi === undefined || composio === undefined
    ? undefined
    : new IntegrationJobs({
        config: configStore,
        api: composioApi,
        configurer: new Configurer({
          model: sdkConfigurerModel(),
          toolkitInfo: (slug) => composio.toolkitInfo(slug),
          toolkitText: (a) => composioAuthoring!.toolkit(a),
          triggerTypes: (toolkit) => composioApi.toolkitTriggers(toolkit),
          onCost: (usd) => bookCall("triage")(usd, null),
        }),
        emit: (type, data) => void bus.emit(type, data),
        now: () => Date.now(),
        newId: randomUUID,
        // A reconnect finished in the dialog: the entry did not change, so the account is told to adopt what is now connected. A new key
        // is only in the config store's account list after it is read again, which a save with nothing in it does.
        reconnected: async (id) => {
          await configStore.save({});
          composio.setAccounts(configStore.current.sources.composio, configStore.skipped.map((s) => s.entry));
          const account = composio.account(id);
          if (account !== undefined) await composio.adopt(account);
        },
        forget: async (id) => {
          const account = composio.account(id);
          return account === undefined ? "No such tool." : composio.forget(account);
        },
        log: (text) => console.log(text),
      });
// Sign-ins are watched, and an abandoned one is removed after an hour.
if (integrationJobs !== undefined) setInterval(() => void integrationJobs.tick().catch((error) => console.error("[integrations] the check failed:", error)), 3_000);
registerIntegrationRoutes(ui, { config: configStore, jobs: integrationJobs, statusOf: (id) => composio?.statusOf(id) ?? "unknown", restartNeeded: (id) => restartNeeded.has(id) });
// New Clots: made from the UI, started here once. A Clot whose create is in progress is not started again by anything else.
const icons = new IconStore("data/icons");
const creator: ClotCreator = new ClotCreator({
  config: configStore,
  ...(integrationJobs === undefined ? {} : { tools: integrationJobs }),
  token: () => config.githubToken,
  start: async (def, step) => {
    if (!definitions.some((c) => c.name === def.name)) {
      definitions.push(def);
      names.push(def.name);
      repoOf.set(def.name, repoSlug(def.repoUrl) ?? null);
    }
    step("cloning");
    try {
      await startClot(def);
    } catch (error) {
      const at = names.indexOf(def.name);
      if (at >= 0) names.splice(at, 1);
      const d = definitions.findIndex((c) => c.name === def.name);
      if (d >= 0) definitions.splice(d, 1);
      clots.delete(def.name);
      repoOf.delete(def.name);
      throw error;
    }
    step("starting");
  },
  emit: (e) => void bus.emit("clot.build", e),
  // Edit with another repository: a fresh workspace volume, the container moved onto it, the Clot started again on it.
  busy: (name) => {
    if (clots.get(name)?.isBusy()) return `${name} is working right now. Try again when its turn has ended.`;
    if (store.listedWorkers(name).length > 0) return `${name} has workers on branches in its current workspace. Try again when they are done.`;
    return undefined;
  },
  reclone: async (def, step, commit) => {
    const definition = definitions.find((c) => c.name === def.name);
    if (definition === undefined) throw new Error(`${def.name} is not running`);
    step("cloning");
    await recloneWorkspace({
      clot: def.name,
      image: config.image,
      repoUrl: def.repoUrl,
      githubToken: config.githubToken,
      // After the container is swapped. The old container waits until this has worked; a failure puts it back, so the runtime state goes back too.
      after: async () => {
        step("starting");
        const prior = { clot: clots.get(def.name), runner: runners.get(def.name), repo: repoOf.get(def.name), slugs: [...repoToClot].filter(([, clot]) => clot === def.name).map(([slug]) => slug) };
        for (const slug of prior.slugs) repoToClot.delete(slug);
        repoOf.set(def.name, repoSlug(def.repoUrl) ?? null);
        try {
          // The definition (the object the configuration holds too) keeps its old repository until the new one is saved.
          await startClot({ ...definition, repoUrl: def.repoUrl });
          await commit();
        } catch (error) {
          for (const [slug, clot] of repoToClot) if (clot === def.name) repoToClot.delete(slug);
          for (const slug of prior.slugs) repoToClot.set(slug, def.name);
          if (prior.repo === undefined) repoOf.delete(def.name);
          else repoOf.set(def.name, prior.repo);
          if (prior.clot === undefined) clots.delete(def.name);
          else clots.set(def.name, prior.clot);
          if (prior.runner === undefined) runners.delete(def.name);
          else runners.set(def.name, prior.runner);
          throw error;
        }
        definition.repoUrl = def.repoUrl;
      },
    });
  },
  onReady: async (name, repo) => {
    const { text, data } = onboardingMessage({ name, repo, webhookUrl: `${config.publicUrl}/webhooks/github` });
    await conv.post(name, text, { kind: "onboarding", data });
  },
});
registerClotAdminRoutes(ui, {
  creator,
  icons,
  config: configStore,
  webhookSecret: () => config.webhookSecret,
  onboarding: (name) => {
    const repo = repoOf.get(name);
    const tools = config.sources.composio.filter((a) => a.clot === name).map((a) => ({ id: `${a.toolkit}:${a.account}`, active: store.composio.account(composio?.userOf(a) ?? "")?.status === "active" }));
    return checklist({ marks: store, repo: repo ?? null, tools, hasPullRequest: store.workersOf(name).some((w) => w.prNumber !== null) });
  },
});
// A Clot added to the file by hand starts; one taken out stops. One made from the UI is started by its create, and one deleted from it was stopped by its delete.
configStore.onChange(["clots"], async (next, prev) => {
  const change = diffClots(prev.clots, next.clots);
  for (const name of change.testCommandChanged) {
    const c = next.clots.find((x) => x.name === name)!;
    const definition = definitions.find((x) => x.name === name);
    if (definition !== undefined) definition.testCommand = c.testCommand;
    runners.get(name)?.setTestCommand(c.testCommand);
  }
  // A repository changed by hand leaves the workspace on the old one: the Edit page in Manage Clots re-clones, and marks the Clot as being built while it does.
  for (const name of change.repoChanged.filter((n) => !creator.building.has(n))) console.warn(`[${name}] its repoUrl was changed in the file: the workspace still holds the old repository. Use Edit in Settings > Manage Clots to move it to the new one.`);
  for (const c of next.clots) {
    if (names.includes(c.name) || creator.building.has(c.name)) continue;
    definitions.push(c);
    names.push(c.name);
    repoOf.set(c.name, repoSlug(c.repoUrl) ?? null);
    void startClot(c).catch((error) => console.error(`[${c.name}] could not be started:`, error));
  }
  for (const name of [...names]) if (name !== HOME_CLOT && !next.clots.some((c) => c.name === name) && !creator.building.has(name)) await removeClotLive(name);
});
// What a change reaches at once; the rest of the keys are read at startup and the store reports them as waiting for a restart. Registered here,
// before the parts built later exist: a part that does not exist yet is built from the configuration as it is then, so nothing is missed.
registerLiveConfig(configStore, {
  maxWorkers: (limit) => workers.setLimit(limit),
  rolloverPercent: (rolloverPercent) => {
    for (const clot of clots.values()) clot.configure({ rolloverPercent });
  },
  timeZone: (zone) => {
    for (const clot of clots.values()) clot.configure({ timeZone: zone });
    ticker.configure({ timeZone: zone });
    spend.configure({ timeZone: zone });
    workers.setTimeZone(zone);
    drafts.configure({ timeZone: zone });
    calendarZone(zone);
  },
  gates: (gates) => ticker.configure({ gates }),
  sweep: (sweep) => late.sweeper?.configure(sweep),
  spend: (s) => spend.configure({ weeklyWarnUsd: s.weeklyWarnUsd }),
  hold: (hold) => late.pipeline?.setHold(hold),
  email: async (accounts) => void (await late.email?.(accounts)),
  mcpServers: async (next, prev) => late.mcp?.(next, prev),
});
registerPushRoutes(ui, { push, subscriptions: store.push, publicKey: () => liveEnv.get("VAPID_PUBLIC_KEY") ?? "", now: () => Date.now() });
registerPrefsRoutes(ui, { store, emit: (prefs) => void bus.emit("config.changed", { ui: prefs }) });
// The worker card follows each worker's state: any change tells the UI which turn's card to refetch.
store.onWorkerChange((w) => {
  if (w.turnId !== null) bus.emit("workers.updated", { clot: w.clot, turnId: w.turnId });
});
try {
  await ui.listen(UI_API_PORT);
  console.log(`[ui] the web app's API is listening on http://127.0.0.1:${UI_API_PORT}`);
} catch (error) {
  console.error(`[ui] the UI API could not start on port ${UI_API_PORT}:`, error);
  process.exit(1);
}


/** The Clots share one GitHub account; its login is what marks an event as caused by a Clot. */
const repoToClot = new Map<string, string>();
/** The daemon's plugin (skills for the Clots), shipped in the repository next to src/. */
const PLUGIN_SOURCE = fileURLToPath(new URL("../plugin", import.meta.url));

async function startClot(c: (typeof definitions)[number]): Promise<void> {
  console.log(`[${c.name}] preparing container`);
  const login = await ensureContainer({ clot: c.name, image: config.image, repoUrl: c.repoUrl, githubToken: config.githubToken });
  if (login) clotLogin = login;
  // The daemon's own skills go into every container at every start, so they change with the daemon. A failed copy is logged: the Clot starts without them.
  await installPlugin(containerName(c.name), PLUGIN_SOURCE).catch((error) => console.warn(`[${c.name}] could not install the daemon's plugin; the Clot starts without its skills: ${error instanceof Error ? error.message : String(error)}`));
  if (c.repoUrl !== undefined) repoToClot.set(repoSlug(c.repoUrl)!, c.name);
  // A session a `docker exec` kept alive past the last daemon must not run beside the one resumed now.
  await killStrayClaude(containerName(c.name));
  const ownLogin = hasOwnLogin(containerName(c.name));
  if (ownLogin) ownLogins.add(c.name);
  console.log(`[${c.name}] signing in with ${ownLogin ? "the container's own login" : "the token from .env"}`);
  const runner = new SdkRunner({
    clot: c.name,
    env: sessionEnv({ claudeToken: config.claudeToken, githubToken: config.githubToken, ownLogin }),
    testCommand: c.testCommand,
    // The home Clot has no clone to start in, and a system prompt that names no project.
    ...(c.repoUrl === undefined ? { cwd: "/workspace", systemPrompt: HOME_SYSTEM_PROMPT + composioNote(config.sources.composio) } : config.sources.composio.length > 0 ? { systemPrompt: CLOT_SYSTEM_PROMPT + composioNote(config.sources.composio) } : {}),
    onRateLimit: (state) => meter.observe(state),
  });
  runners.set(c.name, runner);
  const clot = new Clot({
    name: c.name,
    store,
    conv,
    router,
    runner,
    workerLines: (name) => workers.lines(name),
    onLimit: (resetsAt) => workers.onLimit(resetsAt),
    keepWarmLog: (name, text) => console.log(`[${name}] keep-warm: ${text}`),
    timeZone: config.timeZone,
    gate,
    spend: { book: (a) => spend.book(a), report: (name) => spend.report(name) },
    reground: makeReground({ run: (name, req) => runners.get(name)!.runOneOff(req), workerLines: (name) => workers.lines(name), book: (a) => spend.book(a) }),
    rolloverPercent: config.rolloverPercent,
    now: () => new Date(),
    newId: randomUUID,
    schedule: (ms, fn) => void setTimeout(fn, ms),
    // After the home Clot's turns, and once at startup, its global memories are looked at.
    onTurnEnd: async (name: string, turn: { outsider: boolean }) => {
      if (name === HOME_CLOT) await memory.afterHomeTurn(turn);
    },
    beforeTurn: async (name) => {
      await drafts.check(name);
      await memory.beforeTurn(name);
      // The main session cannot pull, so the daemon keeps its clone on the latest default branch. Old code is better than none.
      if (repoOf.get(name)) await refreshMainCheckout(containerName(name), config.githubToken).catch((error) => console.warn(`[${name}] refreshing the clone failed; reading the code as it was:`, error));
    },
    memory: { list: () => memory.list(), undo: () => memory.undo() },
    ...(calendarUndo ? { calendar: calendarUndo } : {}),
    ...(composioUndo && composio ? { composio: { undo: (clot: string) => composioUndo.undo(clot), reconnect: (name: string) => composio.reconnect(name) } } : {}),
    makeTools: (ctx) => makeTools(toolDeps, ctx),
    roster,
    standingFor: (name, event) => matchStanding(rulebook.standingFor(name), event, event.kind === "batch" ? store.eventsMergedInto(event.id) : []),
    rules: {
      list: (name) => showRules(toolDeps, name),
      undo: (name) => {
        const done = writer.undo(name);
        return done.ok ? `${done.summary} (\`${done.file}.yaml\`)` : done.reason;
      },
    },
  });
  clots.set(c.name, clot);
  await clot.init();
  console.log(`[${c.name}] ready`);
}
for (const c of [...definitions]) await startClot(c);

// Every Clot is ready: the workers' queue starts, after a check of their worktrees and pull requests.
await workers.startUp();

// The gate's clock: once now, then every minute.
if (ownLogins.size === 0) console.log("[usage] no container has a claude.ai login, so the five-hour usage is read from turns only, and there are no connectors to sweep");
await ticker.tick();
setInterval(() => void ticker.tick(), 60_000);

// What a stop caught half-way is closed, and asks that can no longer be answered are withdrawn: now,
// then every hour. Deadlines are scheduled once the Clots can take what they hand over.
await asks.sweep(true);
asks.startTimers();
setInterval(() => void asks.sweep(false).catch((error) => console.error("[asks] the hourly sweep failed:", error)), 60 * 60_000);

// Once per distinct problem, kept across restarts; an entry that is fixed or removed is forgotten.
void announceSkipped(store, configStore.skipped, tellHome).catch(() => undefined);

if (clotLogin === "") console.warn("[events] could not read the Clots' GitHub login; events the Clots cause themselves will not be recognised");
else console.log(`[events] the Clots act on GitHub as ${clotLogin}`);

// Sources. Each sets up its intake path, its enricher, its way of sending and its listeners here.
const enrichers: Record<string, Enricher> = { github: inlineCommentReader(config.githubToken) };
const insertEvent = (event: ClotEvent) => store.insertEvent(event);

// Email: one connection per watched mailbox, held open and reopened when it drops. They follow sources.email as it changes: a new account
// connects, a changed one reconnects, a removed one disconnects; the Clots' email tools appear with the first account and go with the last.
/** Every address of every configured account: mail from any other is an outsider's. One array, updated in place, that the listeners and the calendar feeds read. */
const ownAddresses: string[] = [];
const emailSync = new EmailSync({
  start: (account, mailbox) => {
    const listener = new MailboxListener({ account, mailbox, client: () => imapflowClient(account), store, deliver, now: () => Date.now(), ownAddresses });
    const stop = supervisor.start({ name: `email ${account.account} (${mailbox})`, everyMs: 0, tell: tellAccount(account), run: (ready) => listener.run(ready) });
    return {
      stop: async () => {
        stop();
        await listener.stop();
      },
    };
  },
  log: (text) => console.log(text),
});
async function applyEmail(accounts: EmailAccount[]): Promise<void> {
  ownAddresses.splice(0, ownAddresses.length, ...accounts.flatMap((a) => [a.address, ...a.addresses]));
  drafts.configure({ accounts });
  if (accounts.length > 0) {
    toolDeps.email = { accounts, save: saveDraft };
    toolDeps.senders.email_reply = emailReplySender({ accounts, store, send: sendMail });
  } else {
    delete toolDeps.email;
    delete toolDeps.senders.email_reply;
  }
  await emailSync.apply(accounts);
}
late.email = applyEmail;
await applyEmail(config.sources.email);

// Composio: Stripe, Linear, Notion, the calendar and any other toolkit (PostHog's mapping is a recipe the daemon ships). One path takes every delivery;
// each source keeps its enricher and its way of sending, now over Composio's tools. Notion's events still come on
// its own path, since Composio's Notion triggers need an OAuth app (spec section 9).
let recipeEnrich: Enricher | undefined;
if (composio !== undefined) {
  composioIntake = composioHandler({
    composio,
    secret: () => store.getState(WEBHOOK_SECRET_KEY),
    mappers: { linear: linearMapper, stripe: stripeMapper, generic: genericMapper },
    insertEvent,
    now: () => Date.now(),
    meter: composioMeter,
    recipe: (toolkit) => rulebook.composioRecipe(toolkit),
    keep: (d) => store.composio.keepDelivery(d),
    transaction: (fn) => store.inTransaction(fn),
  });
  // A Composio recipe's reads give an event its actor and title before it is routed; a changed `identity` is learned again.
  const recipeReads = new RecipeReads({ composio, used: (managed) => composioMeter.used(managed), cached: (a, t, h, n) => store.composio.cachedRead(a, t, h, n), keep: (a, t, h, d, n) => store.composio.keepRead(a, t, h, d, n), now: () => Date.now() });
  recipeEnrich = recipeEnricher({ reads: recipeReads, composio, recipe: (toolkit) => rulebook.composioRecipe(toolkit), delivery: (eventId) => store.composio.deliveryByEvent(eventId) });
  const recipesChanged = () => [...new Set(configStore.current.sources.composio.map((a) => a.toolkit).filter((t) => !isBuiltinToolkit(t)))].forEach((toolkit) => composio.recipeChanged(toolkit));
  rulebook.onLoad(recipesChanged);
  recipesChanged();
  const has = (toolkit: string) => config.sources.composio.some((a) => a.toolkit === toolkit);
  if (has("stripe")) enrichers.stripe = stripeEnricher(composio);
  if (has("linear")) {
    enrichers.linear = linearEnricher(composio);
    toolDeps.senders.linear_comment = linearCommentSender(composio);
  }
  for (const account of config.sources.composio.filter((a): a is NotionAccount => a.toolkit === "notion")) {
    handlers.set(`/webhooks/notion/${account.account}`, notionHandler(account, { store, now: () => Date.now(), botId: () => composio.identity(account), log: (text) => console.log(text) }));
  }
  if (has("notion")) {
    enrichers.notion = notionEnricher(composio);
    toolDeps.senders.notion_comment = notionCommentSender(composio);
  }

  // Calendar: each feed polled for reminders, and read for calendar_list. Nothing is polled until the account has signed in.
  for (const account of config.sources.composio.filter(isCalendar)) {
    const feed = new CalendarFeed({ account, timeZone: config.timeZone, store, deliver: (event) => deliver(event), now: () => Date.now(), ownAddresses, source: { list: (from, to) => calendars.get(account.account)!.list(from, to) } });
    feeds.set(account.account, feed);
    const connected = () => store.composio.account(composio.userOf(account))?.status === "active";
    supervisor.start({ name: `calendar ${account.account}`, everyMs: account.pollMinutes * 60_000, tell: tellComposio(account), run: async () => (connected() ? feed.poll() : undefined) });
  }
  if (feeds.size > 0) {
    toolDeps.calendar = {
      accounts: config.sources.composio.filter(isCalendar),
      timeZone: config.timeZone,
      now: () => Date.now(),
      list: (account, from, to) => feeds.get(account)!.list(from, to),
      call: (account, req) => calendars.get(account)!.call(req),
      connected: (account) => store.composio.account(`googlecalendar:${account}`)?.status === "active",
    };
  }
  toolDeps.composioHub = composioHub(composio);
  toolDeps.composioAuthoring = composioAuthoring;
  toolDeps.composio = {
    find: (ctx, a) => composioActions!.find(ctx, a),
    run: (ctx, a) => composioActions!.run(ctx, a),
    countCall: (ctx) => composioActions!.countCall(ctx),
    hasAccount: (name) => composio.account(name) !== undefined && name.includes(":"),
    accountNames: () => composio.accounts().map((a) => composio.userOf(a)),
  };
  // Last: the webhook, each account and the daily check start as jobs of their own, so nothing here holds up the daemon.
  composio.start();
}
// A change to sources.composio from the web app or by hand applies live for a generic toolkit; the built-in ones and the mail accounts
// keep their startup wiring, and say so (the save's answer names sources as needing a restart).
configStore.onChange(
  ["sources"],
  sourcesApplier({
    composio,
    skipped: () => configStore.skipped.map((s) => s.entry),
    restartNeeded,
    emailLive: true,
    log: (text) => console.log(text),
    onToolkits: (accounts, change) => {
      rulebook.setReserved(accounts.map((a) => a.toolkit));
      rulebook.setCalendarCalls(calendarPollingCalls(accounts));
      for (const toolkit of new Set([...change.added, ...change.changed].map((id) => id.split(":")[0]!).filter((t) => !isBuiltinToolkit(t)))) composio?.recipeChanged(toolkit);
      // A Clot's system prompt is fixed when it starts, so a new account reaches it as a note at its next turn.
      for (const id of change.added) {
        const account = accounts.find((a) => `${a.toolkit}:${a.account}` === id);
        if (account === undefined) continue;
        const text = `A new Composio account was connected: ${id} (${account.audience}). composio_find and composio_run reach it; a read always works, a write follows the audience's rules.`;
        for (const clot of account.clot === undefined ? (config.home ? [HOME_CLOT] : names) : [account.clot]) store.addNote(clot, text);
      }
    },
  }),
);

// The daemon's MCP servers. A server that needs a login gets a link in chat, at most once an hour. They follow `mcpServers` as it changes.
/** Who hears about a server: each Clot with a recipe on it in its own file; otherwise the home Clot, or every Clot when there is none. */
const tellServer = async (server: string, text: string) => {
  const owners = [...new Set(rulebook.watches().filter((entry) => watchTarget(entry.recipe) === server && entry.recipe.account === undefined && entry.file !== "global").map((entry) => entry.file))];
  for (const name of owners.length > 0 ? owners : config.home ? [HOME_CLOT] : names) await say(name, text);
};
const lastLink = new Map<string, number>();
const oauthLogins = new Map<string, StoredOAuth>();
/** The login of a server that uses OAuth, made when it is first needed. */
const oauthFor = (name: string): StoredOAuth | undefined => {
  const server = config.mcpServers[name];
  if (server === undefined || server.kind !== "http" || !server.oauth) return undefined;
  let login = oauthLogins.get(name);
  if (login === undefined) {
    login = new StoredOAuth({
      server: name,
      store,
      redirectUrl: `${config.publicUrl}/oauth/callback`,
      now: () => Date.now(),
      onLink: (url) => {
        if (Date.now() - (lastLink.get(name) ?? 0) < 3_600_000) return;
        lastLink.set(name, Date.now());
        void tellServer(name, `Log in to the MCP server ${name} so the daemon can use it. The link works once, for ten minutes: ${url}`);
      },
    });
    oauthLogins.set(name, login);
  }
  return login;
};
const mcp = new McpHub({ names: Object.keys(config.mcpServers), opener: sdkOpener({ servers: () => config.mcpServers, auth: oauthFor }), tell: tellServer });
handlers.set("/oauth/callback", oauthCallbackHandler({ store, now: () => Date.now(), finish: (server, code) => mcp.finishLogin(server, code) }));
/** The Clots' MCP tools exist while there is a server. */
function syncMcpTools(): void {
  if (Object.keys(config.mcpServers).length === 0) delete toolDeps.mcp;
  else toolDeps.mcp = { describe: () => mcp.describe(), listTools: (server) => mcp.listTools(server), callTool: (server, tool, args) => mcp.callTool(server, tool, args) };
}
/** A server the daemon has not seen before is pointed out to the Clots, which may propose a recipe for it. */
function noteNewServers(): void {
  const servers = Object.keys(config.mcpServers);
  const known = new Set(JSON.parse(store.getState("mcp-known-servers") ?? "[]") as string[]);
  for (const name of servers.filter((server) => !known.has(server))) {
    for (const clot of config.home ? [HOME_CLOT] : names) store.addNote(clot, `A new MCP server is set up for the daemon: ${name}. Look at its tools with mcp_list; if one of its read-only tools would show something worth hearing about, propose a watch recipe with rulebook_watch.`);
  }
  store.setState("mcp-known-servers", JSON.stringify(servers));
}
syncMcpTools();
noteNewServers();
late.mcp = (next, prev) => {
  mcp.setServers(Object.keys(next), diffServers(prev, next).changed);
  syncMcpTools();
  noteNewServers();
};
if (Object.keys(config.mcpServers).length > 0) void mcp.start();

// Watch recipes, from the rulebook: started, and restarted or stopped when the files change.
const watchHub: Hub = { listTools: (server) => mcp.listTools(server), callTool: (server, tool, args) => mcp.callTool(server, tool, args) };
const composioWatchHub = composio === undefined ? undefined : composioHub(composio);
const running = new Map<string, { definition: string; stop: () => void }>();
const missingWatchAccount = new Set<string>();
const syncWatches = () => {
  const wanted = new Map(rulebook.watches().map(({ recipe, file }) => [recipe.name, { recipe, file }]));
  for (const [name, entry] of running) {
    const now = wanted.get(name);
    if (now === undefined || JSON.stringify(now.recipe) !== entry.definition) {
      entry.stop();
      running.delete(name);
    }
  }
  for (const [name, { recipe, file }] of wanted) {
    if (running.has(name)) continue;
    const target = watchTarget(recipe);
    // A saved watch whose account is not in the configuration would be skipped forever: it is reported once, and not started.
    if (recipe.account !== undefined && composio?.account(recipe.account) === undefined) {
      const key = `${name}|${JSON.stringify(recipe)}`;
      if (!missingWatchAccount.has(key)) {
        missingWatchAccount.add(key);
        void (file === "global" ? tellHome : (text: string) => say(file, text))(`The watch recipe \`${name}\` names the Composio account ${recipe.account}, which is not in sources.composio, so it does not run.`);
      }
      continue;
    }
    const tell = file === "global" ? (text: string) => (recipe.account === undefined ? tellServer(target, text) : tellComposio(composio?.account(target) ?? {})(text)) : (text: string) => say(file, text);
    // A watch on a Composio account waits for the account to be signed in, as the calendar's poll does.
    const active = recipe.account === undefined ? undefined : () => store.composio.account(recipe.account!)?.status === "active";
    const watcher = new Watcher({ recipe, hubFor: (r) => (r.account === undefined ? watchHub : composioWatchHub!), store, deliver: (event) => deliver(event), now: () => Date.now(), tell, ...(active ? { active } : {}) });
    // A watch on a Composio account counts every call against the allowance, so a failure is not retried faster than it runs.
    const stop = supervisor.start({ name: `watch recipe ${name}`, everyMs: recipe.every * 60_000, tell, run: () => watcher.run(), ...(recipe.account === undefined ? {} : { minRetryMs: recipe.every * 60_000 }) });
    running.set(name, { definition: JSON.stringify(recipe), stop });
  }
};
rulebook.onLoad(syncWatches);
syncWatches();

// Webhook recipes: their secrets are the RECIPE_ keys of .env, read at the moment a delivery arrives (a key added in Settings, or by hand, counts at once).
recipeHandlers = recipeHandler({
  recipe: (name) => rulebook.webhook(name),
  secret: (key) => (key.startsWith("RECIPE_") ? liveEnv.get(key) : undefined),
  insertEvent,
  now: () => Date.now(),
  missingSecret: (recipe) => {
    const binding = rulebook.recipeBinding(recipe.name);
    const text = `The webhook recipe \`${recipe.name}\` is not active yet: put its secret in .env as ${recipe.verify.secret}. Its address is ${config.publicUrl}/webhooks/r/${recipe.name}.`;
    void (binding !== undefined && binding !== "shared" ? say(binding.clot, text) : tellAccount({})(text));
  },
});

// End of sources.

const eventRouter = new EventRouter({
  bindingOf: bindingResolver({
    repos: repoToClot,
    // Read at each event: a tool connected from the web app routes at once.
    accounts: () => [
      ...configStore.current.sources.email.map((account) => ({ ...account, source: "email" })),
      ...configStore.current.sources.composio.map((account): AccountBase & { source: string } => ({ account: account.account, clot: account.clot, shared: account.shared, source: defFor(account.toolkit).source })),
    ],
    recipes: (name) => rulebook.recipeBinding(name),
  }),
  rules: () => rulebook.routing(),
  call: new SdkRoutingCall({ onCost: bookCall("routing") }),
  clots: () => config.clots.map((c) => ({ name: c.name, about: c.about ?? `the project in the repository ${repoSlug(c.repoUrl)}` })),
  guidance: () => rulebook.guidance("global"),
  home: config.home ? HOME_CLOT : undefined,
});

const pipeline = new Pipeline({
  store,
  conv,
  rulebook,
  triage: new SdkTriage({ onCost: bookCall("triage") }),
  clots,
  route: (event) => eventRouter.route(event),
  selfCaused: (event) => event.source === "github" && isSelfCaused(event, clotLogin),
  enrich: enricherBySource(enrichers, (event) => (recipeEnrich === undefined ? Promise.resolve(event) : recipeEnrich(event))),
  hold: config.hold,
  now: () => Date.now(),
  schedule: (ms, fn) => {
    const timer = setTimeout(fn, ms);
    return () => clearTimeout(timer);
  },
});

late.pipeline = pipeline;
// From here on an event is handled as it arrives. Then the ones that were waiting: stored or held
// before a restart, or delivered while this daemon was starting.
onEvent = (event) => void pipeline.handle(event);

// The sweep: one for the whole daemon, in the container that has a claude.ai login. Its first run is the ticker's next minute.
const sweepAccount = accountClot();
const sweeper = new Sweeper({
  store,
  now: () => Date.now(),
  enabled: config.sweep.enabled,
  everyMinutes: config.sweep.everyMinutes,
  ...(sweepAccount === undefined ? {} : { run: (req) => runners.get(sweepAccount)!.runOneOff(req) }),
  clots: roster,
  skip: () => skipList(config),
  // A gate, or the usage limit for any Clot or the workers: the sweep waits.
  held: () => gate().holds !== null || workers.isPaused() || names.some((name) => (store.getClot(name)?.pausedUntil ?? 0) * 1000 > Date.now()),
  deliver: (event) => pipeline.handle(event),
  tell: async (text) => {
    for (const name of config.home ? [HOME_CLOT] : names) await say(name, text);
  },
  book: (a) => spend.book(a),
  onLimit: (resetsAt) => {
    workers.onLimit(resetsAt);
    if (sweepAccount !== undefined) void clots.get(sweepAccount)?.pauseFor(resetsAt);
  },
  log: (text) => console.log(text),
});
sweepTick = () => sweeper.tick();
late.sweeper = sweeper;
await pipeline.resume();
// A hand edit is picked up from here on. A file changed while the daemon was starting is read once now, so that change is not missed.
await configStore.reload();
configStore.watch();
console.log("[events] ready");
