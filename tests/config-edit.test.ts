import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { applyChange, check, getAt, missingEnvKeys, needsAsk, parseKey } from "../src/config-edit.js";
import { makeTools, type ToolDeps } from "../src/tools.js";

const base = {
  timeZone: "UTC",
  image: "clots-clot:dev",
  ui: { owner: "me@example.com" },
  clots: [{ name: "app", repoUrl: "https://github.com/o/r.git" }],
  home: true,
  publicUrl: "https://x.ts.net",
};
const posthog = { toolkit: "posthog", account: "prod", clot: "app", apiKey: "PH_NEW_KEY", connect: { subdomain: "eu" }, triggers: [{ slug: "POSTHOG_EVENT_CAPTURED", config: { project_id: 1, event_names: ["signup"] } }] };
// The shape PostHog's entry had before it became a generic entry.
const oldPosthog = { toolkit: "posthog", account: "prod", clot: "app", apiKey: "PH_NEW_KEY", region: "eu", projectId: 1, events: ["signup"] };

let dir: string;
let file: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "clots-config-edit-"));
  file = path.join(dir, "clots.config.json");
  fs.writeFileSync(file, JSON.stringify(base));
  for (const [k, v] of Object.entries({ DISCORD_BOT_TOKEN: "d", CLAUDE_CODE_OAUTH_TOKEN: "c", CLOT_GITHUB_TOKEN: "g", GITHUB_WEBHOOK_SECRET: "w", COMPOSIO_API_KEY: "ck" })) process.env[k] = v;
  delete process.env.PH_NEW_KEY;
});

describe("keys", () => {
  it("refuses home, publicUrl, ui and image, and keys the file does not have", () => {
    for (const key of ["home", "publicUrl", "ui", "image", "ui.owner"]) expect(parseKey(key)).toContain("cannot be changed");
    expect(parseKey("nonsense")).toContain("no key nonsense");
    expect(parseKey("a.b.c")).toContain("top-level");
    expect(parseKey("sources.composio")).toEqual(["sources", "composio"]);
  });

  it("puts every change to the user", () => {
    // Every key is put to the user: nothing a Clot proposes is saved without a yes.
    for (const key of ["rolloverPercent", "maxWorkers", "gates", "spend", "timeZone"]) expect(needsAsk(parseKey(key) as string[])).toBe(true);
    for (const key of ["sources.composio", "mcpServers.x", "clots", "sendReview", "intake", "rulebookDir"]) expect(needsAsk(parseKey(key) as string[])).toBe(true);
  });
});

describe("check and apply", () => {
  it("saves a valid entry, keeps the old file as .bak, and names the .env key still to add", () => {
    const done = applyChange(file, "sources.composio", [posthog]);
    expect(done.ok).toBe(true);
    expect(done.text).toContain("PH_NEW_KEY");
    expect(getAt(JSON.parse(fs.readFileSync(file, "utf8")), ["sources", "composio"])).toEqual([posthog]);
    expect(JSON.parse(fs.readFileSync(`${file}.bak`, "utf8"))).toEqual(base);
  });

  it("refuses an entry the loader would not take, and leaves the file as it was", () => {
    const done = applyChange(file, "sources.composio", [oldPosthog]);
    expect(done.ok).toBe(false);
    expect(done.text).toContain("PostHog is a generic entry now");
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual(base);
    expect(fs.existsSync(`${file}.bak`)).toBe(false);
  });

  it("refuses a value outside a plain tunable's range", () => {
    expect(applyChange(file, "rolloverPercent", 500).ok).toBe(false);
    expect(applyChange(file, "rolloverPercent", 80).ok).toBe(true);
    expect(JSON.parse(fs.readFileSync(file, "utf8")).rolloverPercent).toBe(80);
  });

  it("refuses a blocked key even when called directly", () => {
    expect(applyChange(file, "publicUrl", "https://evil.example").ok).toBe(false);
    expect(JSON.parse(fs.readFileSync(file, "utf8")).publicUrl).toBe("https://x.ts.net");
  });

  it("allows a remote MCP server but not one that runs a command, and keeps an existing one", () => {
    const remote = { url: "https://mcp.example/sse" };
    expect(check(base, "mcpServers.docs", remote)).not.toBeTypeOf("string");
    expect(check(base, "mcpServers.shell", { command: "rm", args: ["-rf", "/"] })).toContain("runs a command");
    expect(check(base, "mcpServers", { x: { command: "node", args: ["a.js"] } })).toContain("runs a command");
    const withStdio = { ...base, mcpServers: { local: { command: "node", args: ["a.js"] } } };
    expect(check(withStdio, "mcpServers.docs", remote)).not.toBeTypeOf("string");
  });

  it("does not blame a change for an entry that was already unusable", () => {
    const broken = { ...base, sources: { composio: [{ ...oldPosthog, account: "old", apiKey: "PH_OLD" }] } };
    expect(check(broken, "rolloverPercent", 70)).not.toBeTypeOf("string");
    expect(check(broken, "sources.composio", [...broken.sources.composio, { ...oldPosthog, account: "bad" }])).toBeTypeOf("string");
  });

  it("finds the .env keys a candidate still needs", () => {
    const candidate = (check(base, "sources.composio", [posthog]) as { candidate: Record<string, unknown> }).candidate;
    expect(missingEnvKeys(candidate)).toEqual(["PH_NEW_KEY"]);
    process.env.PH_NEW_KEY = "k";
    expect(missingEnvKeys(candidate)).toEqual([]);
  });
});

describe("who gets the tools", () => {
  const deps = { daemonConfig: { get: () => "", set: async () => "", restart: async () => "", toHome: async () => "" }, rulebook: {}, writer: {}, asks: {}, store: {}, senders: {}, say: async () => {}, handOver: async () => "" } as unknown as ToolDeps;
  const tools = (clot: string, kind: "chat" | "event", outsider = false) => makeTools(deps, { clot, kind, outsider });

  it("gives the home Clot the three, in a turn the user's message started", () => {
    const t = tools("home", "chat");
    expect([t.configGet, t.configSet, t.daemonRestart].every((f) => f !== undefined)).toBe(true);
    expect(t.handToHome).toBeUndefined();
  });

  it("gives any other Clot only the way to pass a request on", () => {
    const t = tools("app", "chat");
    expect(t.handToHome).toBeDefined();
    expect([t.configGet, t.configSet, t.daemonRestart].every((f) => f === undefined)).toBe(true);
  });

  it("gives none of them in an event turn or an outsider's turn", () => {
    for (const t of [tools("home", "event"), tools("home", "chat", true), tools("app", "event"), tools("app", "chat", true)]) expect([t.configGet, t.configSet, t.daemonRestart, t.handToHome].every((f) => f === undefined)).toBe(true);
  });
});
