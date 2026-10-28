import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import { addWorktree, containerName, defaultBranch, ensureContainer, hasOwnLogin, killStrayClaude, prsForBranch, refreshMainCheckout, removeWorktree, sessionEnv, sessionExistsAsync, worktreeExists } from "./agent/container.js";
import { DockerMemoryFolders } from "./agent/memory-folder.js";
import { HOME_SYSTEM_PROMPT } from "./agent/prompts.js";
import { SdkRunner } from "./agent/runner.js";
import { DiscordChat } from "./chat/discord.js";
import { Clot } from "./clot.js";
import { HOME_CLOT, loadConfig, type AccountBase } from "./config.js";
import { githubCommentSender } from "./events/github-comment.js";
import { isSelfCaused, repoSlug } from "./events/github.js";
import { enricherBySource, type Enricher } from "./enrich.js";
import { SdkRoutingCall } from "./routing-call.js";
import { bindingResolver, EventRouter } from "./routing.js";
import type { ClotEvent } from "./events/types.js";
import { inlineCommentReader } from "./events/review-comments.js";
import { McpHub, oauthCallbackHandler, sdkOpener } from "./mcp/hub.js";
import { Watcher } from "./watch.js";
import { readEnvFile } from "./env-file.js";
import { recipeHandler } from "./webhook-recipe.js";
import { StoredOAuth } from "./mcp/oauth.js";
import { CalendarFeed } from "./sources/calendar.js";
import { calendarScript, describeScriptEvent } from "./sources/calendar-script.js";
import { draftFates, imapflowClient, MailboxListener, saveDraft, saveSent } from "./sources/imap.js";
import { closeAllReviews, SendReviews } from "./send-review.js";
import { DraftTracker } from "./drafts.js";
import { linearCommentSender, linearEnricher, linearHandler, linearMember } from "./sources/linear.js";
import { notionBot, notionCommentSender, notionEnricher, notionHandler } from "./sources/notion.js";
import { emailReplySender, mailer, smtpTransport } from "./sources/smtp.js";
import { stripeEnricher, stripeHandler } from "./sources/stripe.js";
import { GlobalMemory } from "./global-memory.js";
import { handOver } from "./hand-over.js";
import { Supervisor } from "./listeners.js";
import { githubHandler, startIntake, type Handler, type PullRequestChange } from "./intake.js";
import { Pipeline } from "./pipeline.js";
import { Proposals } from "./proposals.js";
import { SdkRouter } from "./router.js";
import { RuleWriter } from "./rule-writer.js";
import { Rulebook } from "./rulebook.js";
import { matchStanding } from "./standing.js";
import { Store } from "./store.js";
import { makeTools, showRules, type ToolDeps } from "./tools.js";
import { SdkTriage } from "./triage.js";
import { Workers } from "./workers.js";

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

const chat = new DiscordChat(config.discordToken, config.guildId);
const router = new SdkRouter();
const clots = new Map<string, Clot>();
const runners = new Map<string, SdkRunner>();
const repoOf = new Map(definitions.map((c) => [c.name, c.repoUrl === undefined ? null : (repoSlug(c.repoUrl) ?? null)]));

/** Posts in a Clot's live channel. What the daemon says there never enters the Clot's session. */
const say = async (clot: string, text: string): Promise<void> => {
  const session = store.activeSession(clot);
  if (session) await chat.post(session.channelId, text).catch(() => undefined);
};

const rulebook = new Rulebook(config.rulebookDir, names, (file, problem) => {
  console.error(`[rulebook] ${file} is not usable: ${problem}`);
  // A Clot's own file is reported in its channel; the global file in every Clot's.
  const affected = file === "global.yaml" ? names : [file.replace(/\.yaml$/, "")];
  for (const name of affected) void say(name, `\`${file}\` in the rulebook could not be used, so its last good version stays in force.\n${problem}`);
});
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
  toMain: async (clot, row) => clots.get(clot)?.queueFromWorker(row),
  pause: async (clot, resetsAt) => clots.get(clot)?.pauseFor(resetsAt),
  say,
  postActivity: async (clot, activity) => {
    const session = store.activeSession(clot);
    if (session) await chat.postActivity(session.channelId, activity);
  },
});
onPullRequest = (a) => workers.onPullRequest(a);
// Database only, and before any Clot starts: their first turns can start workers.
workers.recover();

const writer = new RuleWriter({ rulebook, store });
const proposals = new Proposals({ store, chat, writer, userId: config.userId, max: config.maxProposals, say });
const toolDeps: ToolDeps = {
  rulebook,
  writer,
  proposals,
  store,
  senders: { github_comment: githubCommentSender(config.githubToken) },
  say,
  handOver: (from, eventId, to) => handOver({ store, clots, say }, from, eventId, to),
  workers,
};

const memory = new GlobalMemory({
  store,
  chat,
  // A Clot's memory folder is named after the directory its turns start in: the home Clot has no clone.
  folders: new DockerMemoryFolders((name) => (name === HOME_CLOT ? "/workspace" : "/workspace/repo")),
  home: HOME_CLOT,
  clots: names,
  userId: config.userId,
  max: config.maxProposals,
  say,
  isBusy: (name) => clots.get(name)?.isBusy() ?? false,
});

/** Sends as the user: standing-rule replies and approved emails, each with a copy in Sent where the server does not file one. */
const sendMail = mailer({ store, transport: smtpTransport, saveSent, log: (text, error) => console.warn(text, error) });
/** Emails the Clots ask to send, each sent on the user's yes in a review channel. Set up with the email sources, unless switched off. */
const sendReviews =
  config.sources.email.length === 0 || !config.sendReview.enabled
    ? undefined
    : new SendReviews({
        store,
        chat,
        userId: config.userId,
        accounts: config.sources.email,
        max: config.maxProposals,
        maxMs: config.sendReview.maxMs,
        now: () => Date.now(),
        send: sendMail,
        saveDraft,
        // The user's feedback reaches the Clot as if typed in its live channel: a turn now, or into the running one.
        feedback: async (name, text) => {
          const session = store.activeSession(name);
          const clot = clots.get(name);
          if (!session || !clot) return false;
          // Not waited for: it may start a whole turn. Stored as the Clot's message before the first await, so it is not lost.
          void clot.onMessage({ id: `send-feedback:${randomUUID()}`, channelId: session.channelId, authorId: config.userId, text, at: new Date() }).catch((error) => console.error(`[${name}]`, error));
          return true;
        },
        say,
      });

await chat.start((m) => {
  void (async () => {
    // A reply in a temporary channel is an answer to the daemon's question there, not a message for the Clot.
    if (await proposals.onReply(m)) return;
    if (await sendReviews?.onReply(m)) return;
    if (await memory.onReply(m)) return;
    const session = store.sessionByChannel(m.channelId);
    const clot = session && clots.get(session.clot);
    if (clot) await clot.onMessage(m);
  })().catch((error) => console.error("[chat]", error));
});

// A question about a global memory whose channel was removed while the daemon was down can no longer
// be answered. Closed before the home Clot's startup check, which then asks it again.
await memory.closeOrphans();
// Questions an earlier version opened about events have no one to answer them any more.
for (const channelId of store.leftoverAskChannels()) await chat.deleteChannel(channelId).catch(() => undefined);
store.clearLeftoverAsks();
/** Follows the drafts the Clots save, and before each turn tells the Clot which the user sent or deleted. Made before the Clots start, so that their first turns already check. */
/** Follows the drafts the Clots save, and before each turn tells the Clot which the user sent or deleted. Set up with the email sources. */
const drafts = config.sources.email.length === 0 ? undefined : new DraftTracker({ store, accounts: config.sources.email, lookup: draftFates, timeZone: config.timeZone, now: () => Date.now(), log: (text, error) => console.warn(text, error) });

/** The Clots share one GitHub account; its login is what marks an event as caused by a Clot. */
let clotLogin = "";
const repoToClot = new Map<string, string>();

for (const c of definitions) {
  console.log(`[${c.name}] preparing container`);
  const login = await ensureContainer({ clot: c.name, image: config.image, repoUrl: c.repoUrl, githubToken: config.githubToken });
  if (login) clotLogin = login;
  if (c.repoUrl !== undefined) repoToClot.set(repoSlug(c.repoUrl)!, c.name);
  // A session a `docker exec` kept alive past the last daemon must not run beside the one resumed now.
  await killStrayClaude(containerName(c.name));
  const ownLogin = hasOwnLogin(containerName(c.name));
  console.log(`[${c.name}] signing in with ${ownLogin ? "the container's own login" : "the token from .env"}`);
  const runner = new SdkRunner({
    clot: c.name,
    env: sessionEnv({ claudeToken: config.claudeToken, githubToken: config.githubToken, ownLogin }),
    testCommand: c.testCommand,
    // The home Clot has no clone to start in, and a system prompt that names no project.
    ...(c.repoUrl === undefined ? { cwd: "/workspace", systemPrompt: HOME_SYSTEM_PROMPT } : {}),
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
    timeZone: config.timeZone,
    userId: config.userId,
    rolloverPercent: config.rolloverPercent,
    now: () => new Date(),
    newId: randomUUID,
    schedule: (ms, fn) => void setTimeout(fn, ms),
    // After the home Clot's turns, and once at startup, its global memories are looked at.
    onTurnEnd: async (name) => {
      if (name === HOME_CLOT) await memory.afterHomeTurn();
    },
    beforeTurn: async (name) => {
      await drafts?.check(name);
      await memory.beforeTurn(name);
      // The main session cannot pull, so the daemon keeps its clone on the latest default branch. Old code is better than none.
      if (repoOf.get(name)) await refreshMainCheckout(containerName(name), config.githubToken).catch((error) => console.warn(`[${name}] refreshing the clone failed; reading the code as it was:`, error));
    },
    memory: { list: () => memory.list(), undo: () => memory.undo() },
    makeTools: (ctx) => makeTools(toolDeps, ctx),
    standingFor: (name, event) => matchStanding(rulebook.standingFor(name), event, event.kind === "batch" ? store.eventsMergedInto(event.id) : []),
    rules: {
      list: (name) => showRules(toolDeps, name),
      undo: (name) => {
        const done = writer.undo(name);
        return done.ok ? `${done.summary} (\`${done.file}.yaml\`)` : done.reason;
      },
    },
    onSessionClosed: (name) => proposals.closeForSession(name),
  });
  clots.set(c.name, clot);
  await clot.init();
  console.log(`[${c.name}] ready`);
}

// Every Clot is ready: the workers' queue starts, after a check of their worktrees and pull requests.
await workers.startUp();

// A proposal whose channel was removed while the daemon was down can no longer be answered.
await proposals.closeOrphans();
// Emails that waited too long for an answer, or whose channel is gone, are withdrawn: now, then every hour.
// With send review off, or no email account left, nothing can answer the reviews still open: they are closed.
if (!sendReviews) await closeAllReviews({ store, chat, say });
else {
  await sendReviews.closeStale(true);
  setInterval(() => void sendReviews.closeStale().catch((error) => console.error("[email] closing stale send reviews failed:", error)), 60 * 60_000);
}

if (clotLogin === "") console.warn("[events] could not read the Clots' GitHub login; events the Clots cause themselves will not be recognised");
else console.log(`[events] the Clots act on GitHub as ${clotLogin}`);

// Sources. Each sets up its intake path, its enricher, its way of sending and its listeners here.
const enrichers: Record<string, Enricher> = { github: inlineCommentReader(config.githubToken) };
const supervisor = new Supervisor({
  schedule: (ms, fn) => {
    const timer = setTimeout(fn, ms);
    return () => clearTimeout(timer);
  },
});
/** Tells the user about an account: in its Clot's channel, or in every Clot's channel when it is shared. */
const tellAccount =
  (account: { clot?: string }) =>
  async (text: string): Promise<void> => {
    for (const name of account.clot === undefined ? names : [account.clot]) await say(name, text);
  };
const insertEvent = (event: ClotEvent) => store.insertEvent(event);

// Stripe: one path per business, each with its own signing secret.
for (const account of config.sources.stripe) handlers.set(`/webhooks/stripe/${account.account}`, stripeHandler(account, { insertEvent, now: () => Date.now() }));
if (config.sources.stripe.length > 0) enrichers.stripe = stripeEnricher(config.sources.stripe);

// Email: one connection per watched mailbox, held open and reopened when it drops.
for (const account of config.sources.email) {
  for (const mailbox of account.mailboxes) {
    const listener = new MailboxListener({ account, mailbox, client: () => imapflowClient(account), store, deliver, now: () => Date.now(), ownAddresses: config.sources.email.flatMap((a) => [a.address, ...a.addresses]) });
    supervisor.start({ name: `email ${account.account} (${mailbox})`, everyMs: 0, tell: tellAccount(account), run: (ready) => listener.run(ready) });
  }
}
if (config.sources.email.length > 0) {
  toolDeps.email = { accounts: config.sources.email, save: saveDraft, ...(sendReviews ? { review: sendReviews } : {}) };
  toolDeps.senders.email_reply = emailReplySender({ accounts: config.sources.email, store, send: sendMail });
}

// Calendar: each feed polled for reminders, and read for calendar_list.
const feeds = new Map<string, CalendarFeed>();
for (const account of config.sources.calendar) {
  const feed = new CalendarFeed({ account, timeZone: config.timeZone, store, deliver: (event) => deliver(event), now: () => Date.now() });
  feeds.set(account.account, feed);
  supervisor.start({ name: `calendar ${account.account}`, everyMs: account.pollMinutes * 60_000, tell: tellAccount(account), run: () => feed.poll() });
}
/**
 * Learns who the Clots are at a source, to drop what they did themselves. A lookup that fails is
 * tried again with a growing wait, up to an hour; until it works, that source's standing sends are refused.
 */
function learnIdentity(what: string, lookup: () => Promise<string>, learnt: (id: string) => void, waitMs = 5_000): void {
  lookup().then(learnt, (error) => {
    console.warn(`[events] could not read ${what}; its standing sends wait until it is read. Trying again in ${Math.round(waitMs / 1000)} s:`, error);
    setTimeout(() => learnIdentity(what, lookup, learnt, Math.min(waitMs * 2, 3_600_000)), waitMs).unref();
  });
}

// Linear: one path per workspace. The Clots' member is learnt from its key, to drop what it did itself.
const linearMembers = new Map<string, string>();
const linearMemberOf = (account: string) => linearMembers.get(account) ?? "";
for (const account of config.sources.linear) {
  handlers.set(`/webhooks/linear/${account.account}`, linearHandler(account, { insertEvent, now: () => Date.now(), memberId: () => linearMemberOf(account.account) }));
  learnIdentity(`the Clots' Linear member for ${account.account}`, () => linearMember(account.apiKey), (id) => {
    linearMembers.set(account.account, id);
    console.log(`[events] the Clots act on Linear (${account.account}) as member ${id}`);
  });
}
if (config.sources.linear.length > 0) {
  enrichers.linear = linearEnricher(config.sources.linear);
  toolDeps.senders.linear_comment = linearCommentSender(config.sources.linear, linearMemberOf);
}

// Notion: one path per workspace. The integration's bot is learnt from its token, to drop what it did itself.
const notionBots = new Map<string, string>();
const notionBotOf = (account: string) => notionBots.get(account) ?? "";
for (const account of config.sources.notion) {
  handlers.set(`/webhooks/notion/${account.account}`, notionHandler(account, { store, now: () => Date.now(), botId: () => notionBotOf(account.account), log: (text) => console.log(text) }));
  learnIdentity(`the Notion integration's bot for ${account.account}`, () => notionBot(account.token), (id) => notionBots.set(account.account, id));
}
if (config.sources.notion.length > 0) {
  enrichers.notion = notionEnricher(config.sources.notion);
  toolDeps.senders.notion_comment = notionCommentSender(config.sources.notion, notionBotOf);
}

// The daemon's MCP servers. A server that needs a login gets a link in chat, at most once an hour.
const mcpNames = Object.keys(config.mcpServers);
/** Who hears about a server: each Clot with a recipe on it in its own file; otherwise the home Clot, or every Clot when there is none. */
const tellServer = async (server: string, text: string) => {
  const owners = [...new Set(rulebook.watches().filter((entry) => entry.recipe.server === server && entry.file !== "global").map((entry) => entry.file))];
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
const running = new Map<string, { definition: string; stop: () => void }>();
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
    const tell = file === "global" ? (text: string) => tellServer(recipe.server, text) : (text: string) => say(file, text);
    const watcher = new Watcher({ recipe, hub, store, deliver: (event) => deliver(event), now: () => Date.now(), tell });
    const stop = supervisor.start({ name: `watch recipe ${name}`, everyMs: recipe.every * 60_000, tell, run: () => watcher.run() });
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

const scripts = new Map(config.sources.calendar.filter((account) => account.script !== undefined).map((account) => [account.account, calendarScript(account.script!)]));
if (feeds.size > 0) {
  toolDeps.calendar = {
    accounts: config.sources.calendar,
    timeZone: config.timeZone,
    now: () => Date.now(),
    list: (account, from, to) => feeds.get(account)!.list(from, to),
    ...(scripts.size > 0 ? { call: (account: string, req: Parameters<ReturnType<typeof calendarScript>["call"]>[0]) => scripts.get(account)!.call(req) } : {}),
  };
}
if (scripts.size > 0) {
  // A removal is put to the user as a proposal; these are what it shows and what it does on yes.
  proposals.useCalendar({
    preview: async ({ account, uid }) => {
      const found = await scripts.get(account)!.call({ action: "check", uid });
      if (!found.ok) return { ok: false, reason: found.reason };
      if (found.event.guests > 0) return { ok: false, reason: "the event has guests, and removing it would notify them; ask the user to remove it" };
      return { ok: true, summary: `Remove from the calendar (${account}): ${describeScriptEvent(found.event, config.timeZone)}` };
    },
    remove: async ({ account, uid }) => {
      const done = await scripts.get(account)!.call({ action: "remove", uid });
      if (done.ok) return { ok: true, summary: describeScriptEvent(done.event, config.timeZone) };
      return done.reached ? { ok: false, reason: done.reason } : { ok: false, reason: done.reason, retry: true };
    },
  });
}
// End of sources.

const eventRouter = new EventRouter({
  bindingOf: bindingResolver({
    repos: repoToClot,
    accounts: (Object.entries(config.sources) as [string, AccountBase[]][]).flatMap(([source, accounts]) => accounts.map((account) => ({ ...account, source }))),
    recipes: (name) => rulebook.recipeBinding(name),
  }),
  rules: () => rulebook.routing(),
  call: new SdkRoutingCall(),
  clots: () => config.clots.map((c) => ({ name: c.name, about: c.about ?? `the project in the repository ${repoSlug(c.repoUrl)}` })),
  guidance: () => rulebook.guidance("global"),
  home: config.home ? HOME_CLOT : undefined,
});

const pipeline = new Pipeline({
  store,
  chat,
  rulebook,
  triage: new SdkTriage(),
  clots,
  route: (event) => eventRouter.route(event),
  selfCaused: (event) => event.source === "github" && isSelfCaused(event, clotLogin),
  enrich: enricherBySource(enrichers),
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
await pipeline.resume();
console.log("[events] ready");
