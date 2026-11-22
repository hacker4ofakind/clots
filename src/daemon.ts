import { fileURLToPath } from "node:url";
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import { addWorktree, containerName, defaultBranch, ensureContainer, hasOwnLogin, installPlugin, killStrayClaude, prsForBranch, refreshMainCheckout, removeWorktree, sessionEnv, sessionExistsAsync, worktreeExists } from "./agent/container.js";
import { DockerMemoryFolders } from "./agent/memory-folder.js";
import { CLOT_SYSTEM_PROMPT, composioNote, HOME_SYSTEM_PROMPT } from "./agent/prompts.js";
import { SdkRunner } from "./agent/runner.js";
import { DiscordChat } from "./chat/discord.js";
import { Clot } from "./clot.js";
import { calendarPollingCalls, HOME_CLOT, isCalendar, loadConfig, type AccountBase, type NotionAccount } from "./config.js";
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
import { posthogMapper } from "./sources/posthog.js";
import { draftFates, imapflowClient, MailboxListener, saveDraft, saveSent } from "./sources/imap.js";
import { Asks } from "./asks.js";
import { askEmail, emailKind, type SendRequest } from "./asks/email.js";
import { askChoice, choiceKind } from "./asks/choice.js";
import { askMerge, mergeKind, withdrawMerges } from "./asks/merge.js";
import { memoryKind } from "./asks/memory.js";
import { askRule, ruleKind } from "./asks/rule.js";
import { migrateAsks } from "./asks-migration.js";
import { CalendarUndo } from "./calendar-undo.js";
import { Waiting } from "./waiting.js";
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

const config = loadConfig(JSON.parse(fs.readFileSync("clots.config.json", "utf8")), process.env);

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
const handlers = new Map<string, Handler>([
  ["/webhooks/github", githubHandler({ secret: config.webhookSecret, insertEvent: (event) => store.insertEvent(event), now: () => Date.now(), onPullRequest: (a) => onPullRequest(a) })],
]);
/**
 * Composio's path answers from the start: 503 until the daemon has set it up, which tells Composio to deliver
 * again, instead of 404, which says there is nothing here.
 */
let composioIntake: Handler = async () => ({ status: 503, text: "starting" });
if (config.sources.composio.length > 0) handlers.set("/webhooks/composio", (req) => composioIntake(req));
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

const chat = new DiscordChat(config.discordToken, config.guildId);
/** What the router, triage and the routing call cost, booked to the Clot they were for; the routing call belongs to the daemon. */
const bookCall = (who: "triage" | "routing") => (usd: number, clot: string | null) => void spend.book({ clot: clot ?? "daemon", who, total: usd }).catch((error) => console.error("booking a call's cost failed:", error));
const router = new SdkRouter({ onCost: bookCall("triage") });
const clots = new Map<string, Clot>();
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

/** Posts in a Clot's live channel. What the daemon says there never enters the Clot's session. */
const say = async (clot: string, text: string): Promise<void> => {
  const session = store.activeSession(clot);
  if (session) await chat.post(session.channelId, text).catch(() => undefined);
};
/** Like say, but a failed post throws: the spend warning is tried again when it fails. */
const postLive = async (clot: string, text: string): Promise<void> => {
  const session = store.activeSession(clot);
  if (session) await chat.post(session.channelId, text);
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
  say,
  postActivity: async (clot, activity) => {
    const session = store.activeSession(clot);
    if (session) await chat.postActivity(session.channelId, activity);
  },
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

// The kinds of ask. Email is asked only with email set up and send review on.
const ruleAsk = ruleKind({ writer, store });
const emailAsk =
  config.sources.email.length === 0 || !config.sendReview.enabled
    ? undefined
    : emailKind({ store, accounts: config.sources.email, maxMs: config.sendReview.maxMs, now: () => Date.now(), send: sendMail, saveDraft, say });
let memory: GlobalMemory;
const memoryAsk = memoryKind({ resolve: (payload, answer) => memory.resolve(payload, answer), restore: (payload) => memory.restore(payload), inForce: (payload) => memory.inForce(payload) });
const mergeAsk = mergeKind({ token: config.githubToken });
const choiceAsk = choiceKind({ timeoutMinutes: config.choiceTimeoutMinutes });
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
const composioApi = config.sources.composio.length === 0 ? undefined : sdkComposioApi(config.composioApiKey!);
const composio =
  composioApi === undefined
    ? undefined
    : new Composio({
        api: composioApi,
        store,
        accounts: config.sources.composio,
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
const calendarUndo = calendars.size === 0 ? undefined : new CalendarUndo({ store, call: (account, req) => calendars.get(account)!.call(req), timeZone: config.timeZone });
const composioUndo = composio === undefined ? undefined : new ComposioUndo({ composio, store });

/** The pinned list of everything waiting for the user, at the top of the server. */
const waiting = new Waiting({ store, chat, after });
const asks = new Asks({
  store,
  chat,
  userId: config.userId,
  now: () => Date.now(),
  kick: (clot) => clots.get(clot)?.kick(),
  say,
  after,
  kinds: [ruleAsk, memoryAsk, mergeAsk, choiceAsk, ...(emailAsk ? [emailAsk] : []), ...(composioAsk ? [composioAsk] : [])],
  // Nothing posted in clots-waiting is an answer, or reaches a Clot.
  ignore: (channelId) => waiting.isChannel(channelId),
});
asks.onChange(() => waiting.refresh());
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
    recipeFile: (toolkit) => rulebook.recipeFile(toolkit)?.file,
  });
}
onPullRequest = async (a) => {
  await workers.onPullRequest(a);
  await withdrawMerges(asks, a);
};

const toolDeps: ToolDeps = {
  watchBudgetProblem: (recipe) => rulebook.watchBudgetProblem(recipe),
  rulebook,
  writer,
  asks: {
    rule: (clot, scope, edit, outsider) => askRule(asks, ruleAsk, { writer, store, max: config.maxProposals }, clot, scope, edit, outsider),
    ...(emailAsk ? { email: (clot: string, req: SendRequest, outsider: boolean) => askEmail(asks, emailAsk, config.maxProposals, clot, req, outsider) } : {}),
    merge: (clot, a, outsider) =>
      askMerge(asks, mergeAsk, { token: config.githubToken, repoOf: (name) => repoOf.get(name) ?? null, workerRepos: (name) => [...new Set(store.workersOf(name).flatMap((w) => (w.prRepo === null ? [] : [w.prRepo])))] }, clot, a, outsider),
    choice: (clot, a, outsider) => askChoice(asks, choiceAsk, { now: () => Date.now(), timeoutMinutes: config.choiceTimeoutMinutes }, clot, a, outsider),
  },
  store,
  senders: { github_comment: githubCommentSender(config.githubToken) },
  say,
  handOver: (from, eventId, to, byRequest) => handOver({ store, clots, say }, from, eventId, to, byRequest),
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

await chat.start((m) => {
  void (async () => {
    // A reply in a temporary channel is an answer to the daemon's question there, not a message for the Clot.
    if (await asks.onReply(m)) return;
    const session = store.sessionByChannel(m.channelId);
    const clot = session && clots.get(session.clot);
    if (clot) await clot.onMessage(m);
  })().catch((error) => console.error("[chat]", error));
});

// The rule proposals, send reviews and memory questions an earlier version kept are withdrawn, once.
await migrateAsks({ store, chat });
// Steering questions an earlier version opened about events have no one to answer them any more.
for (const channelId of store.steeringAskChannels()) await chat.deleteChannel(channelId).catch(() => undefined);
store.clearSteeringAsks();

/** Follows the drafts the Clots save, and before each turn tells the Clot which the user sent or deleted. Made before the Clots start, so that their first turns already check. */
/** Follows the drafts the Clots save, and before each turn tells the Clot which the user sent or deleted. Set up with the email sources. */
const drafts = config.sources.email.length === 0 ? undefined : new DraftTracker({ store, accounts: config.sources.email, lookup: draftFates, timeZone: config.timeZone, now: () => Date.now(), log: (text, error) => console.warn(text, error) });

/** The Clots share one GitHub account; its login is what marks an event as caused by a Clot. */
let clotLogin = "";
const repoToClot = new Map<string, string>();
/** The daemon's plugin (skills for the Clots), shipped in the repository next to src/. */
const PLUGIN_SOURCE = fileURLToPath(new URL("../plugin", import.meta.url));

for (const c of definitions) {
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
    chat,
    router,
    runner,
    workerLines: (name) => workers.lines(name),
    onLimit: (resetsAt) => workers.onLimit(resetsAt),
    keepWarmLog: (name, text) => console.log(`[${name}] keep-warm: ${text}`),
    timeZone: config.timeZone,
    userId: config.userId,
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
      await drafts?.check(name);
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
await waiting.init().catch((error) => console.error("[waiting] clots-waiting could not be set up; it is tried again at the next change:", error));
setInterval(() => void asks.sweep(false).catch((error) => console.error("[asks] the hourly sweep failed:", error)), 60 * 60_000);

if (clotLogin === "") console.warn("[events] could not read the Clots' GitHub login; events the Clots cause themselves will not be recognised");
else console.log(`[events] the Clots act on GitHub as ${clotLogin}`);

// Sources. Each sets up its intake path, its enricher, its way of sending and its listeners here.
const enrichers: Record<string, Enricher> = { github: inlineCommentReader(config.githubToken) };
const insertEvent = (event: ClotEvent) => store.insertEvent(event);

// Email: one connection per watched mailbox, held open and reopened when it drops.
for (const account of config.sources.email) {
  for (const mailbox of account.mailboxes) {
    const listener = new MailboxListener({ account, mailbox, client: () => imapflowClient(account), store, deliver, now: () => Date.now(), ownAddresses: config.sources.email.flatMap((a) => [a.address, ...a.addresses]) });
    supervisor.start({ name: `email ${account.account} (${mailbox})`, everyMs: 0, tell: tellAccount(account), run: (ready) => listener.run(ready) });
  }
}
if (config.sources.email.length > 0) {
  toolDeps.email = { accounts: config.sources.email, save: saveDraft };
  toolDeps.senders.email_reply = emailReplySender({ accounts: config.sources.email, store, send: sendMail });
}

// Composio: Stripe, Linear, Notion, the calendar, PostHog and any other toolkit. One path takes every delivery;
// each source keeps its enricher and its way of sending, now over Composio's tools. Notion's events still come on
// its own path, since Composio's Notion triggers need an OAuth app (spec section 9).
const feeds = new Map<string, CalendarFeed>();
let recipeEnrich: Enricher | undefined;
if (composio !== undefined) {
  composioIntake = composioHandler({
    composio,
    secret: () => store.getState(WEBHOOK_SECRET_KEY),
    mappers: { linear: linearMapper, stripe: stripeMapper, posthog: posthogMapper, generic: genericMapper },
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
  const genericToolkits = [...new Set(config.sources.composio.map((a) => a.toolkit).filter((t) => !isBuiltinToolkit(t)))];
  const recipesChanged = () => genericToolkits.forEach((toolkit) => composio.recipeChanged(toolkit));
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
    const ownAddresses = config.sources.email.flatMap((a) => [a.address, ...a.addresses]);
    const feed = new CalendarFeed({ account, timeZone: config.timeZone, store, deliver: (event) => deliver(event), now: () => Date.now(), ownAddresses, source: calendars.get(account.account)! });
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

// The daemon's MCP servers. A server that needs a login gets a link in chat, at most once an hour.
const mcpNames = Object.keys(config.mcpServers);
/** Who hears about a server: each Clot with a recipe on it in its own file; otherwise the home Clot, or every Clot when there is none. */
const tellServer = async (server: string, text: string) => {
  const owners = [...new Set(rulebook.watches().filter((entry) => watchTarget(entry.recipe) === server && entry.recipe.account === undefined && entry.file !== "global").map((entry) => entry.file))];
  for (const name of owners.length > 0 ? owners : config.home ? [HOME_CLOT] : names) await say(name, text);
};
const lastLink = new Map<string, number>();
const oauthFor = new Map(
  mcpNames
    .filter((name) => {
      const s = config.mcpServers[name];
      return s.kind === "http" && s.oauth;
    })
    .map((name) => [
      name,
      new StoredOAuth({
        server: name,
        store,
        redirectUrl: `${config.publicUrl}/oauth/callback`,
        now: () => Date.now(),
        onLink: (url) => {
          if (Date.now() - (lastLink.get(name) ?? 0) < 3_600_000) return;
          lastLink.set(name, Date.now());
          void tellServer(name, `Log in to the MCP server ${name} so the daemon can use it. The link works once, for ten minutes: ${url}`);
        },
      }),
    ]),
);
const hub = new McpHub({ names: mcpNames, opener: sdkOpener({ servers: config.mcpServers, auth: (name) => oauthFor.get(name) }), tell: tellServer });
if (mcpNames.length > 0) {
  handlers.set("/oauth/callback", oauthCallbackHandler({ store, now: () => Date.now(), finish: (server, code) => hub.finishLogin(server, code) }));
  toolDeps.mcp = { describe: () => hub.describe(), listTools: (server) => hub.listTools(server), callTool: (server, tool, args) => hub.callTool(server, tool, args) };
  // A server the daemon has not seen before is pointed out to the Clots, which may propose a recipe for it.
  const known = new Set(JSON.parse(store.getState("mcp-known-servers") ?? "[]") as string[]);
  for (const name of mcpNames.filter((server) => !known.has(server))) {
    for (const clot of config.home ? [HOME_CLOT] : names) store.addNote(clot, `A new MCP server is set up for the daemon: ${name}. Look at its tools with mcp_list; if one of its read-only tools would show something worth hearing about, propose a watch recipe with rulebook_watch.`);
  }
  store.setState("mcp-known-servers", JSON.stringify(mcpNames));
  void hub.start();
}

// Watch recipes, from the rulebook: started, and restarted or stopped when the files change.
const mcpHub: Hub = { listTools: (server) => hub.listTools(server), callTool: (server, tool, args) => hub.callTool(server, tool, args) };
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
    const watcher = new Watcher({ recipe, hubFor: (r) => (r.account === undefined ? mcpHub : composioWatchHub!), store, deliver: (event) => deliver(event), now: () => Date.now(), tell, ...(active ? { active } : {}) });
    // A watch on a Composio account counts every call against the allowance, so a failure is not retried faster than it runs.
    const stop = supervisor.start({ name: `watch recipe ${name}`, everyMs: recipe.every * 60_000, tell, run: () => watcher.run(), ...(recipe.account === undefined ? {} : { minRetryMs: recipe.every * 60_000 }) });
    running.set(name, { definition: JSON.stringify(recipe), stop });
  }
};
rulebook.onLoad(syncWatches);
syncWatches();

// Webhook recipes: their secrets are the RECIPE_ keys of .env, read again whenever the rulebook changes.
let recipeSecrets = readEnvFile(".env");
rulebook.onLoad(() => {
  recipeSecrets = readEnvFile(".env");
});
recipeHandlers = recipeHandler({
  recipe: (name) => rulebook.webhook(name),
  secret: (key) => (key.startsWith("RECIPE_") ? (recipeSecrets[key] ?? process.env[key]) : undefined),
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
    accounts: [
      ...config.sources.email.map((account) => ({ ...account, source: "email" })),
      ...config.sources.composio.map((account): AccountBase & { source: string } => ({ account: account.account, clot: account.clot, shared: account.shared, source: defFor(account.toolkit).source })),
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
  chat,
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
await pipeline.resume();
console.log("[events] ready");
