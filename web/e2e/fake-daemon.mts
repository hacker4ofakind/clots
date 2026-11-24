/**
 * The daemon for the end-to-end tests: the real UI API, conversation store, asks and Clot, with a fake session runner, a fake
 * mailer and no Docker. Run with `node --import tsx web/e2e/fake-daemon.mts`. A second small server (port + 1) lets a test open
 * asks and stop the daemon: POST /ask {kind}, POST /say {text}.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Asks } from "../../src/asks.js";
import { emailKind, askEmail } from "../../src/asks/email.js";
import { choiceKind, askChoice } from "../../src/asks/choice.js";
import { mergeKind } from "../../src/asks/merge.js";
import { Clot } from "../../src/clot.js";
import { ConversationService } from "../../src/conversation/conversation.js";
import { Store } from "../../src/store.js";
import type { AgentRunner, TurnHandle, TurnRequest } from "../../src/agent/runner.js";
import { EventBus } from "../../src/ui-api/events.js";
import { registerClotRoutes } from "../../src/ui-api/routes/clots.js";
import { registerPrefsRoutes } from "../../src/ui-api/routes/prefs.js";
import { registerWorkerRoutes } from "../../src/ui-api/routes/workers.js";
import { registerPushRoutes } from "../../src/ui-api/routes/push.js";
import { registerClotAdminRoutes } from "../../src/ui-api/routes/clots-admin.js";
import { onboardingMessage } from "../../src/onboarding/create.js";
import { registerSettingsRoutes } from "../../src/ui-api/routes/settings.js";
import { registerFakeIntegrations } from "./fake-integrations.mts";
import { ConfigStore } from "../../src/config-store.js";
import { LiveEnv } from "../../src/live-env.js";
import { Push } from "../../src/push.js";
import { UiApi } from "../../src/ui-api/server.js";
import type { Config } from "../../src/config.js";

const PORT = Number(process.env.FAKE_DAEMON_PORT ?? 8791);
const SECRET = process.env.CLOTS_UI_SECRET ?? "e2e-secret";
const HOST = process.env.CLOTS_UI_DEV_HOST ?? "localhost";
const NAMES = ["home", "Truecast", "Encryptify"];

const store = new Store(":memory:");
const bus = new EventBus();
const conv = new ConversationService({ store, bus, now: () => Date.now(), newId: randomUUID });
const sent: string[] = [];
const emailAccount = { account: "tady", shared: true, address: "me@tady.ch", addresses: [], password: "p", imap: { host: "i", port: 993 }, smtp: { host: "s", port: 465 }, mailboxes: ["INBOX"], tellAddress: true };
const email = emailKind({ store, accounts: () => [emailAccount as never], send: async (_a, mail) => (sent.push(mail.text), { ok: true }) });
const choice = choiceKind();
let timeoutMinutes = 10;
const clots = new Map<string, Clot>();
const asks = new Asks({ store, conv, now: () => Date.now(), kick: (clot) => clots.get(clot)?.kick(), after: (ms, fn) => { const t = setTimeout(fn, ms); return () => clearTimeout(t); }, kinds: [email, choice, mergeKind({ token: "x" })], emit: (t, d) => void bus.emit(t, d), timeoutMs: () => timeoutMinutes * 60_000 });

/** A session that answers by streaming the words of "You said: <message>" a few at a time. */
class FakeRunner implements AgentRunner {
  startTurn(req: TurnRequest): TurnHandle {
    const text = `You said: ${req.prompt.split("\n").pop()}`;
    const done = (async () => {
      const key = `msg_${randomUUID()}:0`;
      for (const part of text.match(/.{1,6}/g) ?? [text]) {
        req.onTextDelta?.(key, part);
        await new Promise((r) => setTimeout(r, 40));
      }
      req.onText(text, key);
      return { sessionId: req.newSessionId ?? req.resume ?? "", contextPercent: 5, ok: true, responded: true };
    })();
    return { push: () => false, stop: () => undefined, done };
  }
}

const config = { ui: { owner: process.env.CLOTS_UI_DEV_OWNER ?? "owner@example.com" }, publicUrl: `https://${HOST}`, clots: NAMES.filter((n) => n !== "home").map((name) => ({ name, repoUrl: `https://github.com/octo/${name}.git` })), sources: { email: [emailAccount], composio: [] } } as unknown as Config;
for (const name of NAMES) {
  const clot = new Clot({ name, store, conv, router: { decide: async () => ({ effort: "low" as const }) }, runner: new FakeRunner(), timeZone: "UTC", rolloverPercent: 65, now: () => new Date(), newId: randomUUID, schedule: (ms, fn) => void setTimeout(fn, ms) });
  clots.set(name, clot);
  await clot.init();
}

const api = new UiApi({ secret: () => SECRET, bus });
// The test's control can make the lists the app loads on first paint slow, to look at the skeletons.
let slowMs = 0;
const addRoute = api.route.bind(api);
api.route = (method, route, handler, o) =>
  addRoute(method, route, async (req) => {
    if (slowMs > 0 && method === "GET" && (route === "/clots" || route === "/clots/:clot/messages")) await new Promise((r) => setTimeout(r, slowMs));
    return handler(req);
  }, o);
registerClotRoutes(api, { store, conv, asks, config: () => config, clots: () => clots, names: () => NAMES, now: () => Date.now() });
registerWorkerRoutes(api, { store });
// A configuration of its own in a temporary folder, so the settings pages work and never touch a real one.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clots-fake-"));
fs.writeFileSync(path.join(dir, ".env"), ["CLAUDE_CODE_OAUTH_TOKEN=c", "CLOT_GITHUB_TOKEN=g", "GITHUB_WEBHOOK_SECRET=w", ""].join("\n"));
fs.writeFileSync(path.join(dir, "clots.config.json"), JSON.stringify({ timeZone: "UTC", image: "clots-clot:dev", ui: { owner: process.env.CLOTS_UI_DEV_OWNER ?? "owner@example.com" }, publicUrl: `https://${HOST}`, home: true, clots: config.clots }, null, 2));
const configStore = new ConfigStore({ file: path.join(dir, "clots.config.json"), envFile: path.join(dir, ".env"), env: new LiveEnv(path.join(dir, ".env"), {}) });
registerSettingsRoutes(api, { config: configStore, announce: () => undefined, reorder: () => undefined, removeClot: async () => undefined });
// The integrations are fake too (a fake Composio and configurer), so the dialog can be driven end to end.
const integrations = registerFakeIntegrations(api, bus);
// A new Clot's checklist: the steps start undone, and the test's controls tick them.
const onboardingDone = new Set<string>();
registerClotAdminRoutes(api, {
  creator: {} as never,
  icons: {} as never,
  config: configStore,
  webhookSecret: () => "whsec_fake_secret",
  onboarding: () => [
    { id: "webhook", done: onboardingDone.has("webhook"), detail: onboardingDone.has("webhook") ? "GitHub's ping arrived." : "Waiting for GitHub's ping from octo/Truecast." },
    { id: "tools", done: onboardingDone.has("tools"), detail: "No tool is connected yet." },
    { id: "push-branch", done: onboardingDone.has("push-branch"), detail: "Done once the Clot has pushed a branch with its own token." },
  ],
});
registerPrefsRoutes(api, { store, emit: (prefs) => void bus.emit("config.changed", { ui: prefs }) });
store.onWorkerChange((w) => w.turnId !== null && bus.emit("workers.updated", { clot: w.clot, turnId: w.turnId }));
registerPushRoutes(api, { push: new Push({ store: store.push, now: () => Date.now(), send: async () => ({ status: 201 }) }), subscriptions: store.push, publicKey: () => "BPlaceholderKeyForTests", now: () => Date.now() });
let server = await api.listen(PORT);

// The test's own controls.
const control = http.createServer(async (req, res) => {
  const body = await new Promise<string>((resolve) => { let t = ""; req.on("data", (c) => (t += c)); req.on("end", () => resolve(t)); });
  const data = body ? JSON.parse(body) : {};
  const url = req.url ?? "";
  let out: unknown = { ok: true };
  if (url === "/ask") {
    if (data.kind === "choice") out = await askChoice(asks, choice, data.clot ?? "home", { question: "Which test runner?", options: ["Vitest", "Jest"], pick: 1 }, false);
    else out = await askEmail(asks, email, 3, data.clot ?? "home", { account: "tady", mail: { from: "me@tady.ch", to: ["jane@x.com"], subject: "Order 7", text: data.text ?? "Thanks, we are on it.", references: [], messageId: `<${randomUUID()}@tady.ch>` } }, false);
  } else if (url === "/say") await conv.post(data.clot ?? "home", data.text ?? "Hello.");
  else if (url === "/onboard") {
    const { text, data: card } = onboardingMessage({ name: data.clot ?? "Truecast", repo: "octo/Truecast", webhookUrl: "https://box.example.ts.net/webhooks/github" });
    await conv.post(data.clot ?? "Truecast", text, { kind: "onboarding", data: card });
  } else if (url === "/onboard-done") onboardingDone.add(data.step);
  else if (url === "/integrations/activate") out = integrations.activate(data.jobId);
  else if (url === "/integrations/reset") integrations.reset();
  else if (url === "/timeout") timeoutMinutes = data.minutes;
  else if (url === "/slow") slowMs = data.ms ?? 0;
  else if (url === "/sent") out = sent;
  else if (url === "/stop") await api.close();
  else if (url === "/start") server = await api.listen(PORT);
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(out));
});
control.listen(PORT + 1, "127.0.0.1");
console.log(`fake daemon on ${PORT}, controls on ${PORT + 1}`);
