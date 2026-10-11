import { expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const json = {
  timeZone: "UTC",
  image: "clots-clot:dev",
  discord: { guildId: "g", userId: "u" },
  clots: [{ name: "graphite", repoUrl: "https://github.com/o/r.git" }],
};
const env = { DISCORD_BOT_TOKEN: "d", CLAUDE_CODE_OAUTH_TOKEN: "c", CLOT_GITHUB_TOKEN: "gh" };

it("merges the config file and the environment", () => {
  expect(loadConfig(json, env)).toEqual({
    timeZone: "UTC",
    image: "clots-clot:dev",
    guildId: "g",
    userId: "u",
    clots: [{ name: "graphite", repoUrl: "https://github.com/o/r.git" }],
    discordToken: "d",
    claudeToken: "c",
    githubToken: "gh",
    rolloverPercent: 65,
  });
});

it("reads the rollover override", () => {
  expect(loadConfig(json, { ...env, CLOTS_ROLLOVER_PERCENT: "1" }).rolloverPercent).toBe(1);
});

it("names the missing secret", () => {
  expect(() => loadConfig(json, { ...env, DISCORD_BOT_TOKEN: "" })).toThrow("DISCORD_BOT_TOKEN");
});

it("rejects a clot name Docker cannot use", () => {
  expect(() => loadConfig({ ...json, clots: [{ name: "My App", repoUrl: "https://github.com/o/r.git" }] }, env)).toThrow();
});
