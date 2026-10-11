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
  });
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
