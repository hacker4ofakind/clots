import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { PLUGIN_DIR, pluginInstallSteps } from "../src/agent/container.js";
import { composioNote } from "../src/agent/prompts.js";
import { turnOptions } from "../src/agent/runner.js";

const SKILL = fs.readFileSync("plugin/skills/composio-integration/SKILL.md", "utf8");

describe("the plugin's install into a container", () => {
  const steps = pluginInstallSteps("clot-home");

  it("removes what is there, copies the folder in, then makes it root's and read-only to the Clot, in that order", () => {
    expect(steps.map((s) => s.args.slice(0, 4).join(" "))).toEqual(["exec -u root clot-home", "cp ./. clot-home:/opt/clots/plugin", "exec -u root clot-home"]);
    expect(steps[0].args.at(-1)).toBe(`rm -rf ${PLUGIN_DIR} && mkdir -p ${PLUGIN_DIR}`);
    expect(steps[2].args.at(-1)).toBe(`chown -R root:root ${PLUGIN_DIR} && chmod -R a+rX,go-w ${PLUGIN_DIR}`);
  });

  it("puts it outside the home volume, and copies from the plugin folder itself so no host path meets docker's container:path syntax", () => {
    expect(PLUGIN_DIR).toBe("/opt/clots/plugin");
    expect(PLUGIN_DIR.startsWith("/home/clot")).toBe(false);
    expect(steps.map((s) => s.inSource)).toEqual([false, true, false]);
    expect(steps[1].args.join(" ")).not.toMatch(/[A-Za-z]:\\/);
  });
});

describe("which sessions load the plugin", () => {
  const req = { prompt: "x", effort: "low" as const, model: "claude-opus-5-5", onText: () => undefined };

  it("gives a main session the plugin at the path in the container", () => {
    const options = turnOptions({ role: "main", ...req }, { clot: "graphite", env: {} });
    expect(options.plugins).toEqual([{ type: "local", path: "/opt/clots/plugin" }]);
  });

  it("does not give a worker the plugin", () => {
    const options = turnOptions(
      { role: "worker", ...req, cwd: "/workspace/worktrees/w1", systemPrompt: "x", guard: { worktree: "/workspace/worktrees/w1" } as never, workerTools: { askMain: async () => "" }, onStep: () => undefined },
      { clot: "graphite", env: {} },
    );
    expect(options.plugins).toBeUndefined();
  });
});

describe("the skill", () => {
  it("ships as a plugin of its own, named clots", () => {
    expect(JSON.parse(fs.readFileSync("plugin/.claude-plugin/plugin.json", "utf8"))).toMatchObject({ name: "clots", version: "1.0.0" });
    expect(SKILL).toMatch(/^---\nname: composio-integration\n/);
  });

  it("names all four tools, so a rename breaks this", () => {
    for (const name of ["composio_toolkit", "composio_samples", "composio_try", "rulebook_composio"]) expect(SKILL).toContain(name);
  });

  it("names the config fields of an entry", () => {
    for (const field of ["apiKey", "fields", "scheme", "oauthApp", "selfIsUser", "triggers"]) expect(SKILL).toContain(`\`${field}\``);
  });

  it("holds the decided guidance: webhook first, ask before polling and say its cost, write against samples, no secret in a recipe, only the user edits config", () => {
    expect(SKILL).toMatch(/Webhook triggers first/);
    expect(SKILL).toContain("43200 / minutes");
    expect(SKILL).toContain("wait for the user's yes");
    expect(SKILL).toContain("`composio_try` it on **every** kept sample");
    expect(SKILL).toContain("Never put a secret in a message or a recipe");
    expect(SKILL).toContain("only the user does");
    expect(SKILL).toContain("more than about 100 events a day");
    expect(SKILL).toContain("https://backend.composio.dev/api/v1/auth-apps/add");
  });

  it("is under 150 lines and holds no key", () => {
    expect(SKILL.split("\n").length).toBeLessThan(150);
    expect(SKILL).not.toMatch(/lin_api|rk_|ntn_|xoxb-|COMPOSIO_API_KEY=/);
  });
});

describe("the system prompt", () => {
  it("points a Clot at the skill and the four tools", () => {
    const note = composioNote([{ toolkit: "slack", account: "work", audience: "team" }]);
    expect(note).toContain("composio-integration");
    for (const name of ["composio_toolkit", "composio_samples", "composio_try", "rulebook_composio"]) expect(note).toContain(name);
  });
});
