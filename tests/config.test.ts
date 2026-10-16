import { expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const json = {
  timeZone: "UTC",
  image: "clots-clot:dev",
  discord: { guildId: "g", userId: "u" },
  clots: [{ name: "graphite", repoUrl: "https://github.com/o/r.git" }],
};
const env = { DISCORD_BOT_TOKEN: "d", CLAUDE_CODE_OAUTH_TOKEN: "c", CLOT_GITHUB_TOKEN: "gh", GITHUB_WEBHOOK_SECRET: "w" };

it("merges the config file and the environment", () => {
  expect(loadConfig(json, env)).toEqual({
    timeZone: "UTC",
    image: "clots-clot:dev",
    guildId: "g",
    userId: "u",
    intakePort: 8787,
    rulebookDir: "rulebook",
    hold: { quietMs: 60_000, capMs: 120_000 },
    clots: [{ name: "graphite", repoUrl: "https://github.com/o/r.git" }],
    discordToken: "d",
    claudeToken: "c",
    githubToken: "gh",
    webhookSecret: "w",
    rolloverPercent: 65,
    home: false,
    maxProposals: 3,
    publicUrl: "",
    sources: { stripe: [], email: [], calendar: [], linear: [], notion: [] },
    mcpServers: {},
  });
});

it("reads the home Clot and the limit on open proposals", () => {
  expect(loadConfig({ ...json, home: true }, { ...env, CLOTS_MAX_PROPOSALS: "5" })).toMatchObject({ home: true, maxProposals: 5 });
});

it("rejects a limit on open proposals that is not a whole number of at least one", () => {
  for (const bad of ["0", "-1", "2.5", "many"]) expect(() => loadConfig(json, { ...env, CLOTS_MAX_PROPOSALS: bad })).toThrow("CLOTS_MAX_PROPOSALS");
});

it("keeps the names home and global for the daemon's own use", () => {
  for (const name of ["home", "global"]) expect(() => loadConfig({ ...json, clots: [{ name, repoUrl: "https://github.com/o/r.git" }] }, env)).toThrow();
});

it("reads the rollover override", () => {
  expect(loadConfig(json, { ...env, CLOTS_ROLLOVER_PERCENT: "1" }).rolloverPercent).toBe(1);
});

it("names the missing secret", () => {
  expect(() => loadConfig(json, { ...env, DISCORD_BOT_TOKEN: "" })).toThrow("DISCORD_BOT_TOKEN");
});

it("reads the intake port, the rulebook folder and a Clot's test command", () => {
  const config = loadConfig({ ...json, intake: { port: 9000 }, rulebookDir: "rules", clots: [{ ...json.clots[0], testCommand: "npm test" }] }, env);
  expect(config).toMatchObject({ intakePort: 9000, rulebookDir: "rules", clots: [{ name: "graphite", testCommand: "npm test" }] });
});

it("reads how long automated events are held", () => {
  expect(loadConfig({ ...json, hold: { quietSeconds: 5, capSeconds: 20 } }, env).hold).toEqual({ quietMs: 5000, capMs: 20_000 });
});

it("names the missing webhook secret", () => {
  expect(() => loadConfig(json, { ...env, GITHUB_WEBHOOK_SECRET: undefined })).toThrow("GITHUB_WEBHOOK_SECRET");
});

it("rejects a repository URL that events could not be routed by", () => {
  expect(() => loadConfig({ ...json, clots: [{ name: "graphite", repoUrl: "git@github.com:o/r.git" }] }, env)).toThrow();
});

it("rejects a clot name Docker cannot use", () => {
  expect(() => loadConfig({ ...json, clots: [{ name: "My App", repoUrl: "https://github.com/o/r.git" }] }, env)).toThrow();
});

const withSources = (sources: unknown, more: Record<string, unknown> = {}) => ({ ...json, publicUrl: "https://box.example.ts.net/", sources, ...more });

it("reads accounts, replacing each .env key by its value", () => {
  const config = loadConfig(
    withSources({
      stripe: [{ account: "shop", clot: "graphite", webhookSecret: "STRIPE_SHOP_HOOK", apiKey: "STRIPE_SHOP_KEY" }],
      linear: [{ account: "team", shared: true, webhookSecret: "LINEAR_HOOK", apiKey: "LINEAR_KEY" }],
      notion: [{ account: "space", shared: true, token: "NOTION_TOKEN" }],
    }),
    { ...env, STRIPE_SHOP_HOOK: "whsec_1", STRIPE_SHOP_KEY: "rk_1", LINEAR_HOOK: "lh", LINEAR_KEY: "lk", NOTION_TOKEN: "nt" },
  );
  expect(config.publicUrl).toBe("https://box.example.ts.net");
  expect(config.sources.stripe).toEqual([{ account: "shop", clot: "graphite", shared: false, webhookSecret: "whsec_1", apiKey: "rk_1", checkoutCompleted: false }]);
  expect(config.sources.linear).toEqual([{ account: "team", clot: undefined, shared: true, webhookSecret: "lh", apiKey: "lk" }]);
  expect(config.sources.notion).toEqual([{ account: "space", clot: undefined, shared: true, token: "nt", verificationToken: undefined }]);
});

it("names the .env key that is missing", () => {
  expect(() => loadConfig(withSources({ linear: [{ account: "team", shared: true, webhookSecret: "LINEAR_HOOK", apiKey: "LINEAR_KEY" }] }), { ...env, LINEAR_HOOK: "x" })).toThrow("LINEAR_KEY");
});

it("wants each account bound to one Clot that exists, or shared, and each account name once per source", () => {
  const linear = (a: Record<string, unknown>) => withSources({ linear: [{ account: "team", webhookSecret: "H", apiKey: "K", ...a }] });
  const keys = { ...env, H: "h", K: "k" };
  expect(() => loadConfig(linear({}), keys)).toThrow("either clot or shared");
  expect(() => loadConfig(linear({ clot: "graphite", shared: true }), keys)).toThrow("either clot or shared");
  expect(() => loadConfig(linear({ clot: "nobody" }), keys)).toThrow("no Clot named nobody");
  expect(() => loadConfig(linear({ clot: "home" }), keys)).toThrow("no Clot named home");
  expect(loadConfig({ ...linear({ clot: "home" }), home: true }, keys).sources.linear[0].clot).toBe("home");
  expect(() => loadConfig(withSources({ linear: [{ account: "team", shared: true, webhookSecret: "H", apiKey: "K" }, { account: "team", shared: true, webhookSecret: "H", apiKey: "K" }] }), keys)).toThrow("twice");
});

it("fills in Gmail's servers, and wants them for any other address", () => {
  const keys = { ...env, P: "app-password" };
  const gmail = loadConfig(withSources({ email: [{ account: "gmail", shared: true, address: "me@gmail.com", password: "P", mailboxes: ["Clots"] }] }), keys).sources.email[0];
  expect(gmail).toMatchObject({ address: "me@gmail.com", addresses: [], password: "app-password", imap: { host: "imap.gmail.com", port: 993 }, smtp: { host: "smtp.gmail.com", port: 465 }, mailboxes: ["Clots"] });
  const own = { account: "tady", shared: true, address: "me@tady.ch", password: "P", mailboxes: ["INBOX"] };
  expect(() => loadConfig(withSources({ email: [own] }), keys)).toThrow("imap and smtp");
  const set = loadConfig(withSources({ email: [{ ...own, imap: { host: "mail.tady.ch" }, smtp: { host: "mail.tady.ch", port: 587 } }] }), keys).sources.email[0];
  expect(set).toMatchObject({ imap: { host: "mail.tady.ch", port: 993 }, smtp: { host: "mail.tady.ch", port: 587 } });
});

it("reads a calendar's lead times in minutes, and wants the script's secret with its address", () => {
  const keys = { ...env, ICAL: "https://calendar.google.com/x.ics", SCRIPT: "https://script.google.com/macros/s/x/exec", SECRET: "s" };
  const calendar = (a: Record<string, unknown>) => withSources({ calendar: [{ account: "me", shared: true, icalUrl: "ICAL", ...a }] });
  expect(loadConfig(calendar({}), keys).sources.calendar[0]).toEqual({ account: "me", clot: undefined, shared: true, icalUrl: "https://calendar.google.com/x.ics", script: undefined, leadMinutes: [1440], pollMinutes: 5 });
  expect(loadConfig(calendar({ leadTimes: ["2d", "90m"], script: "SCRIPT", scriptSecret: "SECRET" }), keys).sources.calendar[0]).toMatchObject({ leadMinutes: [2880, 90], script: { url: "https://script.google.com/macros/s/x/exec", secret: "s" } });
  expect(() => loadConfig(calendar({ script: "SCRIPT" }), keys)).toThrow("scriptSecret");
  expect(() => loadConfig(calendar({ leadTimes: ["soon"] }), keys)).toThrow();
});

it("wants the public address once anything has to reach the daemon from outside", () => {
  const keys = { ...env, H: "h", K: "k" };
  expect(() => loadConfig({ ...json, sources: { linear: [{ account: "team", shared: true, webhookSecret: "H", apiKey: "K" }] } }, keys)).toThrow("publicUrl");
  expect(() => loadConfig({ ...json, mcpServers: { notion: { url: "https://mcp.notion.com/mcp", oauth: true } } }, env)).toThrow("publicUrl");
});

it("reads the daemon's MCP servers, replacing each .env key by its value", () => {
  const config = loadConfig(
    { ...json, publicUrl: "https://box.example.ts.net", mcpServers: { notion: { url: "https://mcp.notion.com/mcp", oauth: true }, tracker: { url: "https://t.example/mcp", headers: { Authorization: "TRACKER" } }, local: { command: "npx", args: ["-y", "x"], env: { API_KEY: "LOCAL" } } } },
    { ...env, TRACKER: "Bearer t", LOCAL: "l" },
  );
  expect(config.mcpServers).toEqual({
    notion: { kind: "http", url: "https://mcp.notion.com/mcp", headers: {}, oauth: true },
    tracker: { kind: "http", url: "https://t.example/mcp", headers: { Authorization: "Bearer t" }, oauth: false },
    local: { kind: "stdio", command: "npx", args: ["-y", "x"], env: { API_KEY: "l" } },
  });
});

it("reads what a Clot is about", () => {
  expect(loadConfig({ ...json, clots: [{ ...json.clots[0], about: "A web app that encrypts files." }] }, env).clots[0].about).toBe("A web app that encrypts files.");
});

it("refuses a credential written into the file instead of the name of its .env key", () => {
  expect(() => loadConfig(withSources({ linear: [{ account: "team", shared: true, webhookSecret: "lin_wh_abc123", apiKey: "K" }] }), { ...env, K: "k" })).toThrow();
});
