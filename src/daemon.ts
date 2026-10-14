import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { containerName, ensureContainer, hasOwnLogin, sessionEnv } from "./agent/container.js";
import { DockerMemoryFolders } from "./agent/memory-folder.js";
import { HOME_SYSTEM_PROMPT } from "./agent/prompts.js";
import { SdkRunner } from "./agent/runner.js";
import { DiscordChat } from "./chat/discord.js";
import { Clot } from "./clot.js";
import { HOME_CLOT, loadConfig } from "./config.js";
import { githubCommentSender } from "./events/github-comment.js";
import { repoSlug } from "./events/github.js";
import type { ClotEvent } from "./events/types.js";
import { inlineCommentReader } from "./events/review-comments.js";
import { SdkExplainer } from "./explainer.js";
import { GlobalMemory } from "./global-memory.js";
import { startIntake } from "./intake.js";
import { Pipeline, routeByRepo } from "./pipeline.js";
import { Proposals } from "./proposals.js";
import { SdkRouter } from "./router.js";
import { RuleWriter } from "./rule-writer.js";
import { Rulebook } from "./rulebook.js";
import { matchStanding } from "./standing.js";
import { Steering } from "./steering.js";
import { Store } from "./store.js";
import { makeTools, showRules, type ToolDeps } from "./tools.js";
import { SdkTriage } from "./triage.js";

const config = loadConfig(JSON.parse(fs.readFileSync("clots.config.json", "utf8")), process.env);

// The intake port is taken first, before anything is read or changed. It is what keeps a second
// daemon from starting beside this one, and it lets GitHub's deliveries be stored while the rest
// starts up, which can take as long as finishing a turn that a restart cut off.
fs.mkdirSync("data", { recursive: true });
const store = new Store("data/clots.db");
let onEvent: (event: ClotEvent) => void = () => undefined;
const intake = startIntake({
  port: config.intakePort,
  secret: config.webhookSecret,
  insertEvent: (event) => store.insertEvent(event),
  now: () => Date.now(),
  onEvent: (event) => onEvent(event),
});
await new Promise<void>((resolve) => {
  intake.once("listening", resolve);
  intake.once("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EADDRINUSE") console.error(`Port ${config.intakePort} is in use: another daemon is probably running. Stop it before starting this one.`);
    else console.error("[events] the intake server could not start:", error);
    process.exit(1);
  });
});
console.log(`[events] listening for GitHub webhooks on http://127.0.0.1:${config.intakePort}/webhooks/github`);

/**
 * Every Clot the daemon runs: one per project, and the home Clot when the configuration asks for it.
 * The home Clot comes first: its startup check of the global memories runs before any project Clot's turn.
 */
const definitions: { name: string; repoUrl?: string; testCommand?: string }[] = [...(config.home ? [{ name: HOME_CLOT }] : []), ...config.clots];
const names = definitions.map((c) => c.name);

const chat = new DiscordChat(config.discordToken, config.guildId);
const router = new SdkRouter();
const clots = new Map<string, Clot>();
const steering = new Steering({ store, chat, explainer: new SdkExplainer(), userId: config.userId, timeZone: config.timeZone, clots });

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

const writer = new RuleWriter({ rulebook, store });
const proposals = new Proposals({ store, chat, writer, userId: config.userId, max: config.maxProposals, say });
const toolDeps: ToolDeps = { rulebook, writer, proposals, store, senders: { github_comment: githubCommentSender(config.githubToken) }, say };

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

await chat.start((m) => {
  void (async () => {
    // A reply in a temporary channel is an answer to the daemon's question there, not a message for the Clot.
    if (await steering.onReply(m)) return;
    if (await proposals.onReply(m)) return;
    if (await memory.onReply(m)) return;
    const session = store.sessionByChannel(m.channelId);
    const clot = session && clots.get(session.clot);
    if (clot) await clot.onMessage(m);
  })().catch((error) => console.error("[chat]", error));
});

// A question about a global memory whose channel was removed while the daemon was down can no longer
// be answered. Closed before the home Clot's startup check, which then asks it again.
await memory.closeOrphans();

/** The Clots share one GitHub account; its login is what marks an event as caused by a Clot. */
let clotLogin = "";
const repoToClot = new Map<string, string>();

for (const c of definitions) {
  console.log(`[${c.name}] preparing container`);
  const login = await ensureContainer({ clot: c.name, image: config.image, repoUrl: c.repoUrl, githubToken: config.githubToken });
  if (login) clotLogin = login;
  if (c.repoUrl !== undefined) repoToClot.set(repoSlug(c.repoUrl)!, c.name);
  const ownLogin = hasOwnLogin(containerName(c.name));
  console.log(`[${c.name}] signing in with ${ownLogin ? "the container's own login" : "the token from .env"}`);
  const clot = new Clot({
    name: c.name,
    store,
    chat,
    router,
    runner: new SdkRunner({
      clot: c.name,
      env: sessionEnv({ claudeToken: config.claudeToken, githubToken: config.githubToken, ownLogin }),
      testCommand: c.testCommand,
      // The home Clot has no clone to start in, and a system prompt that names no project.
      ...(c.repoUrl === undefined ? { cwd: "/workspace", systemPrompt: HOME_SYSTEM_PROMPT } : {}),
    }),
    timeZone: config.timeZone,
    userId: config.userId,
    rolloverPercent: config.rolloverPercent,
    now: () => new Date(),
    newId: randomUUID,
    schedule: (ms, fn) => void setTimeout(fn, ms),
    // When no turn is running, a question about "the running turn" has lapsed. After the home Clot's
    // turns, and once at startup, its global memories are looked at.
    onTurnEnd: async (name) => {
      await steering.lapse(name);
      if (name === HOME_CLOT) await memory.afterHomeTurn();
    },
    beforeTurn: (name) => memory.beforeTurn(name),
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

// A proposal whose channel was removed while the daemon was down can no longer be answered.
await proposals.closeOrphans();

if (clotLogin === "") console.warn("[events] could not read the Clots' GitHub login; events the Clots cause themselves will not be recognised");
else console.log(`[events] the Clots act on GitHub as ${clotLogin}`);

const pipeline = new Pipeline({
  store,
  chat,
  rulebook,
  triage: new SdkTriage(),
  steering,
  clots,
  clotForRepo: routeByRepo(repoToClot, config.home ? HOME_CLOT : undefined),
  clotLogin,
  readInline: inlineCommentReader(config.githubToken),
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
