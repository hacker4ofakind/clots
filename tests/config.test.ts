import { describe, expect, it } from "vitest";
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
    maxWorkers: 3,
    choiceTimeoutMinutes: 10,
    publicUrl: "",
    sendReview: { enabled: true, maxMs: 3 * 86_400_000 },
    gates: expect.any(Object),
    sweep: { enabled: true, everyMinutes: 90 },
    spend: { weeklyWarnUsd: 50 },
    sources: { email: [], composio: [] },
    composioApiKey: undefined,
    mcpServers: {},
  });
});

it("reads the send review switch and how many days a review waits", () => {
  expect(loadConfig({ ...json, sendReview: { enabled: false, days: 0.5 } }, env).sendReview).toEqual({ enabled: false, maxMs: 43_200_000 });
  expect(loadConfig({ ...json, sendReview: { days: 7 } }, env).sendReview).toEqual({ enabled: true, maxMs: 7 * 86_400_000 });
  expect(() => loadConfig({ ...json, sendReview: { days: 0 } }, env)).toThrow();
});

it("reads the home Clot and the limit on open proposals", () => {
  expect(loadConfig({ ...json, home: true, maxProposals: 5 }, env)).toMatchObject({ home: true, maxProposals: 5 });
  expect(loadConfig(json, env).maxProposals).toBe(3);
});

it("rejects a limit on open proposals that is not a whole number of at least one", () => {
  for (const bad of [0, -1, 2.5, "many"]) expect(() => loadConfig({ ...json, maxProposals: bad }, env)).toThrow("maxProposals");
});

it("keeps the names home and global for the daemon's own use", () => {
  for (const name of ["home", "global"]) expect(() => loadConfig({ ...json, clots: [{ name, repoUrl: "https://github.com/o/r.git" }] }, env)).toThrow();
});

it("reads the rollover percent, from 1 to 100, and names rolloverPercent when it is wrong", () => {
  expect(loadConfig(json, env).rolloverPercent).toBe(65);
  expect(loadConfig({ ...json, rolloverPercent: 1 }, env).rolloverPercent).toBe(1);
  for (const bad of [0, 101, "high"]) expect(() => loadConfig({ ...json, rolloverPercent: bad }, env)).toThrow("rolloverPercent");
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

const composioKeys = { ...env, COMPOSIO_API_KEY: "ck", LINEAR_KEY: "lk", NOTION_KEY: "nk", STRIPE_KEY: "rk_1", PH_KEY: "phx_1" };
const composio = (...accounts: Record<string, unknown>[]) => withSources({ composio: accounts });

it("reads Composio accounts of every kind, replacing each .env key by its value and defaulting the audience to public", () => {
  const config = loadConfig(
    composio(
      { toolkit: "linear", account: "team", clot: "graphite", apiKey: "LINEAR_KEY", audience: "team" },
      { toolkit: "notion", account: "space", shared: true, apiKey: "NOTION_KEY", audience: "private" },
      { toolkit: "stripe", account: "shop", clot: "graphite", apiKey: "STRIPE_KEY" },
      { toolkit: "googlecalendar", account: "me", shared: true, audience: "private", leadTimes: ["2d", "90m"], pollMinutes: 10 },
      { toolkit: "posthog", account: "app", clot: "graphite", apiKey: "PH_KEY", projectId: 42, events: ["signup"] },
    ),
    composioKeys,
  );
  expect(config.publicUrl).toBe("https://box.example.ts.net");
  expect(config.composioApiKey).toBe("ck");
  const [linear, notion, stripe, calendar, posthog] = config.sources.composio;
  expect(linear).toEqual({ toolkit: "linear", account: "team", clot: "graphite", shared: false, audience: "team", apiKey: "lk", apiKeyName: "LINEAR_KEY", triggers: [], selfIsUser: false });
  expect(notion).toMatchObject({ toolkit: "notion", shared: true, audience: "private", apiKey: "nk" });
  expect(stripe).toMatchObject({ toolkit: "stripe", audience: "public", apiKey: "rk_1", checkoutCompleted: false });
  expect(calendar).toMatchObject({ toolkit: "googlecalendar", audience: "private", leadMinutes: [2880, 90], pollMinutes: 10 });
  expect(calendar.apiKey).toBeUndefined();
  expect(posthog).toMatchObject({ toolkit: "posthog", region: "us", projectId: 42, events: ["signup"] });
});

it("reads a calendar's lead times and poll interval with their defaults", () => {
  const calendar = loadConfig(composio({ toolkit: "googlecalendar", account: "me", shared: true }), composioKeys).sources.composio[0];
  expect(calendar).toMatchObject({ leadMinutes: [1440], pollMinutes: 5, audience: "public" });
  expect(() => loadConfig(composio({ toolkit: "googlecalendar", account: "me", shared: true, leadTimes: ["soon"] }), composioKeys)).toThrow();
});

it("refuses the source keys that moved to sources.composio, naming the key", () => {
  for (const old of ["stripe", "linear", "notion", "calendar"]) {
    expect(() => loadConfig(withSources({ [old]: [] }), composioKeys)).toThrow(`sources.${old} moved to sources.composio in stage 2e`);
  }
});

it("refuses a field the toolkit does not take, and a key the toolkit needs, naming the field", () => {
  expect(() => loadConfig(composio({ toolkit: "googlecalendar", account: "me", shared: true, apiKey: "LINEAR_KEY" }), composioKeys)).toThrow("apiKey");
  expect(() => loadConfig(composio({ toolkit: "linear", account: "team", shared: true }), composioKeys)).toThrow("apiKey");
  expect(() => loadConfig(composio({ toolkit: "linear", account: "team", shared: true, apiKey: "LINEAR_KEY", triggers: [{ slug: "X" }] }), composioKeys)).toThrow("triggers");
  expect(() => loadConfig(composio({ toolkit: "linear", account: "team", shared: true, apiKey: "LINEAR_KEY", leadTimes: ["1h"] }), composioKeys)).toThrow("leadTimes");
  expect(() => loadConfig(composio({ toolkit: "notion", account: "s", shared: true, apiKey: "NOTION_KEY", checkoutCompleted: true }), composioKeys)).toThrow("checkoutCompleted");
  expect(() => loadConfig(composio({ toolkit: "stripe", account: "s", shared: true, apiKey: "STRIPE_KEY", region: "eu" }), composioKeys)).toThrow("region");
  expect(() => loadConfig(composio({ toolkit: "posthog", account: "s", shared: true, apiKey: "PH_KEY", events: ["x"] }), composioKeys)).toThrow("projectId");
  expect(() => loadConfig(composio({ toolkit: "posthog", account: "s", shared: true, apiKey: "PH_KEY", projectId: 1 }), composioKeys)).toThrow("events");
});

it("names the .env key that is missing, and wants COMPOSIO_API_KEY once there are Composio accounts", () => {
  const account = { toolkit: "linear", account: "team", shared: true, apiKey: "LINEAR_KEY" };
  expect(() => loadConfig(composio(account), { ...composioKeys, LINEAR_KEY: undefined })).toThrow("LINEAR_KEY");
  expect(() => loadConfig(composio(account), { ...composioKeys, COMPOSIO_API_KEY: undefined })).toThrow("COMPOSIO_API_KEY");
  expect(loadConfig(withSources({ composio: [] }), env).composioApiKey).toBeUndefined();
});

it("wants each account bound to one Clot that exists, or shared, and each account name once per toolkit", () => {
  const linear = (a: Record<string, unknown>) => composio({ toolkit: "linear", account: "team", apiKey: "LINEAR_KEY", ...a });
  expect(() => loadConfig(linear({}), composioKeys)).toThrow("either clot or shared");
  expect(() => loadConfig(linear({ clot: "graphite", shared: true }), composioKeys)).toThrow("either clot or shared");
  expect(() => loadConfig(linear({ clot: "nobody" }), composioKeys)).toThrow("no Clot named nobody");
  expect(() => loadConfig(linear({ clot: "home" }), composioKeys)).toThrow("no Clot named home");
  expect(loadConfig({ ...linear({ clot: "home" }), home: true }, composioKeys).sources.composio[0].clot).toBe("home");
  const twice = { toolkit: "linear", account: "team", shared: true, apiKey: "LINEAR_KEY" };
  expect(() => loadConfig(composio(twice, twice), composioKeys)).toThrow("twice");
  expect(loadConfig(composio(twice, { ...twice, toolkit: "notion", apiKey: "NOTION_KEY" }), composioKeys).sources.composio).toHaveLength(2);
});

it("takes triggers for a toolkit with no built-in mapper, once each", () => {
  const slack = { toolkit: "slack", account: "work", shared: true, apiKey: "LINEAR_KEY", triggers: [{ slug: "SLACK_RECEIVE_MESSAGE", config: { channel: "C1" } }] };
  expect(loadConfig(composio(slack), composioKeys).sources.composio[0]).toMatchObject({ toolkit: "slack", triggers: [{ slug: "SLACK_RECEIVE_MESSAGE", config: { channel: "C1" } }] });
  expect(() => loadConfig(composio({ ...slack, triggers: [slack.triggers[0], slack.triggers[0]] }), composioKeys)).toThrow("SLACK_RECEIVE_MESSAGE");
});

describe("a toolkit without built-in support connects from one entry", () => {
  const keys = { ...composioKeys, SB_URL: "https://x.supabase.co", SB_KEY: "sb-secret", OA_ID: "client-id", OA_SECRET: "client-secret", SLACK_KEY: "xoxb", RECIPE_X: "r" };
  const entry = (a: Record<string, unknown>) => composio({ toolkit: "slack", account: "work", shared: true, ...a });
  const only = (a: Record<string, unknown>, env = keys) => loadConfig(entry(a), env).sources.composio[0];

  it("with no key at all, which is Composio's managed sign-in", () => {
    expect(only({})).toMatchObject({ toolkit: "slack", selfIsUser: false, triggers: [] });
    expect(only({}).apiKey).toBeUndefined();
  });

  it("with fields, each field mapped to the .env key that holds it, read to its value", () => {
    expect(only({ toolkit: "supabase", fields: { full: "SB_URL", bearer_token: "SB_KEY" } })).toMatchObject({ fieldKeys: { full: "SB_URL", bearer_token: "SB_KEY" }, fields: { full: "https://x.supabase.co", bearer_token: "sb-secret" } });
  });

  it("with an apiKey and a scheme", () => {
    expect(only({ apiKey: "SLACK_KEY", scheme: "BEARER_TOKEN" })).toMatchObject({ apiKey: "xoxb", apiKeyName: "SLACK_KEY", scheme: "BEARER_TOKEN" });
  });

  it("with the user's own OAuth app: the keys are kept by name and by value", () => {
    expect(only({ oauthApp: { clientId: "OA_ID", clientSecret: "OA_SECRET" } })).toMatchObject({ oauthApp: { clientId: "OA_ID", clientSecret: "OA_SECRET" }, oauthValues: { clientId: "client-id", clientSecret: "client-secret" } });
  });

  it("with selfIsUser, which defaults to false", () => {
    expect(only({ selfIsUser: true }).selfIsUser).toBe(true);
  });

  it("refuses combinations that do not make sense, naming the field", () => {
    const oauthApp = { clientId: "OA_ID", clientSecret: "OA_SECRET" };
    expect(() => only({ oauthApp, apiKey: "SLACK_KEY" })).toThrow("oauthApp cannot go with apiKey or fields");
    expect(() => only({ oauthApp, fields: { a: "SB_URL" } })).toThrow("oauthApp cannot go with apiKey or fields");
    expect(() => only({ apiKey: "SLACK_KEY", fields: { a: "SB_URL" } })).toThrow("give apiKey or fields, not both");
    expect(() => only({ scheme: "API_KEY" })).toThrow("scheme goes with apiKey or fields");
    expect(() => only({ fields: {} })).toThrow("fields names at least one field");
    expect(() => only({ apiKey: "not an env key" })).toThrow("names a key in .env");
  });

  it("refuses an .env key the daemon uses for something else", () => {
    for (const key of ["COMPOSIO_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "DISCORD_BOT_TOKEN", "CLOT_GITHUB_TOKEN", "GITHUB_WEBHOOK_SECRET", "RECIPE_X"]) {
      const withKey = { ...keys, [key]: "value" };
      expect(() => only({ apiKey: key }, withKey)).toThrow(key);
      expect(() => only({ fields: { a: key } }, withKey)).toThrow(key);
      expect(() => only({ oauthApp: { clientId: key, clientSecret: "OA_SECRET" } }, withKey)).toThrow(key);
    }
  });

  it("refuses a key another part of the configuration names: a built-in account's, a mail account's, another toolkit's", () => {
    expect(() => loadConfig(composio({ toolkit: "linear", account: "team", shared: true, apiKey: "LINEAR_KEY" }, { toolkit: "slack", account: "work", shared: true, apiKey: "LINEAR_KEY" }), keys)).toThrow("LINEAR_KEY is already used by linear account team");
    expect(() => loadConfig(composio({ toolkit: "slack", account: "a", shared: true, apiKey: "SLACK_KEY" }, { toolkit: "reddit", account: "b", shared: true, fields: { x: "SLACK_KEY" } }), keys)).toThrow("already used by slack account a");
    const mail = { ...withSources({ email: [{ account: "gmail", shared: true, address: "me@gmail.com", password: "SLACK_KEY", mailboxes: ["Clots"] }], composio: [{ toolkit: "slack", account: "work", shared: true, apiKey: "SLACK_KEY" }] }) };
    expect(() => loadConfig(mail, keys)).toThrow("already used by email account gmail");
  });

  it("names the .env key that is missing", () => {
    expect(() => only({ fields: { a: "NOT_THERE" } })).toThrow("NOT_THERE");
  });
});

it("refuses calendars that would poll more than 10,000 times a month in all", () => {
  const calendar = (account: string, pollMinutes: number) => ({ toolkit: "googlecalendar", account, shared: true, pollMinutes });
  expect(() => loadConfig(composio(calendar("a", 5), calendar("b", 5)), composioKeys)).toThrow("10,000");
  expect(loadConfig(composio(calendar("a", 5), calendar("b", 60)), composioKeys).sources.composio).toHaveLength(2);
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

it("tells the Clots an email account's addresses unless told not to", () => {
  const keys = { ...env, P: "app-password" };
  const account = { account: "gmail", shared: true, address: "me@gmail.com", password: "P", mailboxes: ["Clots"] };
  expect(loadConfig(withSources({ email: [account] }), keys).sources.email[0].tellAddress).toBe(true);
  expect(loadConfig(withSources({ email: [{ ...account, tellAddress: false }] }), keys).sources.email[0].tellAddress).toBe(false);
});

it("wants the public address once anything has to reach the daemon from outside", () => {
  expect(() => loadConfig({ ...json, sources: { composio: [{ toolkit: "linear", account: "team", shared: true, apiKey: "LINEAR_KEY" }] } }, composioKeys)).toThrow("publicUrl");
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
  expect(() => loadConfig(composio({ toolkit: "linear", account: "team", shared: true, apiKey: "lin_api_abc123" }), composioKeys)).toThrow();
});

it("reads the worker limit, from 1 to 20, and names maxWorkers when it is wrong", () => {
  expect(loadConfig(json, env).maxWorkers).toBe(3);
  expect(loadConfig({ ...json, maxWorkers: 1 }, env).maxWorkers).toBe(1);
  expect(loadConfig({ ...json, maxWorkers: 20 }, env).maxWorkers).toBe(20);
  for (const bad of [0, 21, 2.5, "many"]) expect(() => loadConfig({ ...json, maxWorkers: bad }, env)).toThrow("maxWorkers");
});

it("reads the choice timeout, from 1 to 1440 minutes, and names choiceTimeoutMinutes when it is wrong", () => {
  expect(loadConfig(json, env).choiceTimeoutMinutes).toBe(10);
  expect(loadConfig({ ...json, choiceTimeoutMinutes: 1 }, env).choiceTimeoutMinutes).toBe(1);
  expect(loadConfig({ ...json, choiceTimeoutMinutes: 1440 }, env).choiceTimeoutMinutes).toBe(1440);
  for (const bad of [0, 1441, 2.5, "soon"]) expect(() => loadConfig({ ...json, choiceTimeoutMinutes: bad }, env)).toThrow("choiceTimeoutMinutes");
});

const defaultWindows = (window: { start: number; end: number }) => Object.fromEntries(["mon", "tue", "wed", "thu", "fri"].map((day) => [day, window]));

it("defaults the gates, the sweep and the spend warning", () => {
  const config = loadConfig(json, env);
  expect(config.gates).toEqual({ scarce: defaultWindows({ start: 900, end: 1080 }), leadIn: defaultWindows({ start: 600, end: 900 }), leadInPercent: 50 });
  expect(config.sweep).toEqual({ enabled: true, everyMinutes: 90 });
  expect(config.spend).toEqual({ weeklyWarnUsd: 50 });
});

it("replaces a whole default window set when one is given, and {} means no windows", () => {
  const config = loadConfig({ ...json, gates: { scarce: { sat: "09:30-11:00" }, leadIn: {} } }, env);
  expect(config.gates.scarce).toEqual({ sat: { start: 570, end: 660 } });
  expect(config.gates.leadIn).toEqual({});
  expect(config.gates.leadInPercent).toBe(50);
});

it("rejects gate settings that cannot work", () => {
  for (const gates of [{ scarce: { mon: "9-10" } }, { scarce: { mon: "18:00-15:00" } }, { leadIn: { mon: "10:00-10:00" } }, { leadInPercent: 0 }, { leadInPercent: 101 }, { scarce: { someday: "10:00-11:00" } }]) {
    expect(() => loadConfig({ ...json, gates }, env)).toThrow();
  }
  expect(() => loadConfig({ ...json, sweep: { everyMinutes: 10 } }, env)).toThrow();
  expect(() => loadConfig({ ...json, spend: { weeklyWarnUsd: 0 } }, env)).toThrow();
});

it("reads the sweep and an explicit empty spend setting as no warning", () => {
  expect(loadConfig({ ...json, sweep: { enabled: false, everyMinutes: 15 } }, env).sweep).toEqual({ enabled: false, everyMinutes: 15 });
  expect(loadConfig({ ...json, spend: {} }, env).spend).toEqual({});
  expect(loadConfig({ ...json, spend: { weeklyWarnUsd: 12.5 } }, env).spend).toEqual({ weeklyWarnUsd: 12.5 });
});

it("keeps the names daemon and sweep for the spend log", () => {
  for (const name of ["daemon", "sweep"]) expect(() => loadConfig({ ...json, clots: [{ name, repoUrl: "https://github.com/o/r.git" }] }, env)).toThrow();
});
