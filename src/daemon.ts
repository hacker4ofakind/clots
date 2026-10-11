import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { containerName, ensureContainer, hasOwnLogin, sessionEnv } from "./agent/container.js";
import { SdkRunner } from "./agent/runner.js";
import { DiscordChat } from "./chat/discord.js";
import { Clot } from "./clot.js";
import { loadConfig } from "./config.js";
import { SdkRouter } from "./router.js";
import { Store } from "./store.js";

const config = loadConfig(JSON.parse(fs.readFileSync("clots.config.json", "utf8")), process.env);

fs.mkdirSync("data", { recursive: true });
const store = new Store("data/clots.db");
const chat = new DiscordChat(config.discordToken, config.guildId);
const router = new SdkRouter();
const clots = new Map<string, Clot>();

await chat.start((m) => {
  const session = store.sessionByChannel(m.channelId);
  const clot = session && clots.get(session.clot);
  if (clot) void clot.onMessage(m).catch((error) => console.error(`[${session.clot}]`, error));
});

for (const c of config.clots) {
  console.log(`[${c.name}] preparing container`);
  await ensureContainer({ clot: c.name, image: config.image, repoUrl: c.repoUrl, githubToken: config.githubToken });
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
    }),
    timeZone: config.timeZone,
    userId: config.userId,
    rolloverPercent: config.rolloverPercent,
    now: () => new Date(),
    newId: randomUUID,
    schedule: (ms, fn) => void setTimeout(fn, ms),
  });
  clots.set(c.name, clot);
  await clot.init();
  console.log(`[${c.name}] ready`);
}
