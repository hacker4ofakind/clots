import { describe, expect, it } from "vitest";
import { isTurnActivity, TurnTracker } from "../src/agent/turn-tracker.js";
import { parseRateLimit } from "../src/agent/usage.js";
import { buildPrompt, CLOT_SYSTEM_PROMPT, PR_ATTRIBUTION } from "../src/agent/prompts.js";
import { stepOf, turnOptions, workerHookAnswer } from "../src/agent/runner.js";
import { workerExec, worktreePath } from "../src/agent/container.js";
import { prLink, ReportBuffer, workerBranch, workerPrompt } from "../src/worker-turn.js";
import { containerName, containerStep, dockerExecArgs, gitIdentity, noreplyEmail, pickSdkEnv, sessionEnv, toContainerCommand } from "../src/agent/container.js";

describe("TurnTracker", () => {
  it("finishes on a result when nothing was pushed", () => {
    expect(new TurnTracker().onResult()).toBe("finish");
  });

  it("allows a grace period once after a push, then finishes", () => {
    const t = new TurnTracker();
    t.onPush();
    expect(t.onResult()).toBe("grace");
    expect(t.onResult()).toBe("finish");
  });

  it("waits for another result while the SDK reports queued turns", () => {
    const t = new TurnTracker();
    t.onPush();
    t.onPush();
    expect(t.onResult(2)).toBe("wait");
    expect(t.onResult(1)).toBe("wait");
    expect(t.onResult(0)).toBe("finish");
  });

  it("waits on queued turns even when it saw no push", () => {
    expect(new TurnTracker().onResult(1)).toBe("wait");
  });

  it("falls back to push counting when the SDK reports no queue", () => {
    const t = new TurnTracker();
    t.onPush();
    expect(t.onResult(undefined)).toBe("grace");
    expect(t.onResult(0)).toBe("finish");
  });
});

describe("isTurnActivity", () => {
  it("counts model and tool messages as activity", () => {
    expect(isTurnActivity("assistant")).toBe(true);
    expect(isTurnActivity("user")).toBe(true);
    expect(isTurnActivity("stream_event")).toBe(true);
  });

  it("does not count the bookkeeping that follows a result", () => {
    expect(isTurnActivity("system")).toBe(false);
    expect(isTurnActivity("rate_limit_event")).toBe(false);
    expect(isTurnActivity("result")).toBe(false);
  });
});

describe("parseRateLimit", () => {
  it("reads a rejected event with camelCase fields", () => {
    const message = { type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: 1760100000, utilization: 1 } };
    expect(parseRateLimit(message)).toEqual({ status: "rejected", resetsAt: 1760100000, utilization: 1 });
  });

  it("reads snake_case fields", () => {
    const message = { type: "rate_limit_event", rate_limit_info: { status: "allowed_warning", resets_at: 5, utilization: 0.9 } };
    expect(parseRateLimit(message)).toEqual({ status: "allowed_warning", resetsAt: 5, utilization: 0.9 });
  });

  it("ignores other messages", () => {
    expect(parseRateLimit({ type: "assistant" })).toBeUndefined();
    expect(parseRateLimit(null)).toBeUndefined();
  });
});

describe("buildPrompt", () => {
  const base = { text: "fix the footer", seed: null, interrupted: false };

  it("passes plain text through", () => {
    expect(buildPrompt(base)).toBe("fix the footer");
  });

  it("marks an event as untrusted and says what to do with it", () => {
    const prompt = buildPrompt({ ...base, text: "<event>...</event>", event: true });
    expect(prompt).toContain("An event arrived from outside this chat");
    expect(prompt).toContain("start a worker right away");
    expect(prompt).not.toContain("Brainstorm");
    expect(prompt).not.toContain("OUTSIDE");
    expect(prompt).not.toContain("someone outside the project");
    expect(prompt.endsWith("<event>...</event>")).toBe(true);
  });

  it("adds the outsider note to an outsider's event only", () => {
    expect(buildPrompt({ ...base, text: "<event>", event: true, outsider: true })).toContain("This event comes from someone outside the project.");
    expect(buildPrompt({ ...base, outsider: true })).not.toContain("someone outside the project");
  });

  it("lists the workers after the notes, and leaves the block out when there are none", () => {
    const prompt = buildPrompt({ ...base, notes: ["N"], workers: ['- 1a2b3c4d "Fix X": idle, Sonnet 5.5 high, branch clot/fix-x-1a2b, pull request none yet'] });
    expect(prompt).toContain('[Your workers:\n- 1a2b3c4d "Fix X"');
    expect(prompt.indexOf("Since your last turn")).toBeLessThan(prompt.indexOf("Your workers"));
    expect(buildPrompt({ ...base, workers: [] })).toBe("fix the footer");
  });

  it("tells a new session why it was started", () => {
    expect(buildPrompt({ ...base, seed: "RECAP TEXT" })).toContain("reached its context limit");
    expect(buildPrompt({ ...base, seed: "RECAP TEXT", seedReason: "user" })).toContain("the user asked for a fresh one");
  });

  it("puts the recap first and the interruption note second", () => {
    const prompt = buildPrompt({ ...base, seed: "RECAP TEXT", interrupted: true });
    expect(prompt.indexOf("RECAP TEXT")).toBeLessThan(prompt.indexOf("cut off"));
    expect(prompt.indexOf("cut off")).toBeLessThan(prompt.indexOf("fix the footer"));
  });
});

describe("PR_ATTRIBUTION", () => {
  it("credits the Clot and links to the Clots repository", () => {
    expect(PR_ATTRIBUTION).toBe("Created with a [Clot](https://github.com/hacker4ofakind/clots).");
  });
});

describe("CLOT_SYSTEM_PROMPT", () => {
  it("tells the Clot to ask questions as plain text", () => {
    expect(CLOT_SYSTEM_PROMPT).toContain("ask them as plain text");
  });
});

describe("container helpers", () => {
  it("commits as <name>-clot with the token account's address", () => {
    expect(gitIdentity("graphite", "42+octo@users.noreply.github.com")).toEqual({ name: "graphite-clot", email: "42+octo@users.noreply.github.com" });
  });

  it("falls back to an address no GitHub account owns when the account is unknown", () => {
    expect(gitIdentity("graphite")).toEqual({ name: "graphite-clot", email: "graphite-clot@clots.invalid" });
  });

  it("builds the GitHub no-reply address of an account", () => {
    expect(noreplyEmail(42, "octo")).toBe("42+octo@users.noreply.github.com");
  });

  it("names the container after the clot", () => {
    expect(containerName("graphite")).toBe("clot-graphite");
  });

  it("drops the host runtime and script path", () => {
    expect(toContainerCommand("/usr/bin/node", ["/host/sdk/cli.js", "--output-format", "stream-json"])).toEqual(["claude", "--output-format", "stream-json"]);
  });

  it("replaces a host binary path", () => {
    expect(toContainerCommand("C:\\sdk\\claude.exe", ["--print"])).toEqual(["claude", "--print"]);
  });

  it("keeps only the SDK's own environment variables", () => {
    expect(pickSdkEnv({ PATH: "/bin", CLAUDE_CODE_ENTRYPOINT: "sdk-ts", CLAUDE_AGENT_SDK_VERSION: "1", HOME: "/h", X: undefined })).toEqual({
      CLAUDE_CODE_ENTRYPOINT: "sdk-ts",
      CLAUDE_AGENT_SDK_VERSION: "1",
    });
  });

  it("never forwards the daemon's own Claude token; credentials are passed explicitly", () => {
    expect(pickSdkEnv({ CLAUDE_CODE_OAUTH_TOKEN: "secret", CLAUDE_CODE_ENTRYPOINT: "sdk-ts" })).toEqual({ CLAUDE_CODE_ENTRYPOINT: "sdk-ts" });
  });

  it("gives a session the token when the container has no login of its own", () => {
    expect(sessionEnv({ claudeToken: "c", githubToken: "gh", ownLogin: false })).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: "c", GH_TOKEN: "gh" });
  });

  it("leaves the token out when the container is logged in, so its login and connectors are used", () => {
    expect(sessionEnv({ claudeToken: "c", githubToken: "gh", ownLogin: true })).toEqual({ GH_TOKEN: "gh" });
  });

  it("builds docker exec arguments that pass env by name only", () => {
    expect(dockerExecArgs({ container: "clot-g", cwd: "/workspace/repo", envKeys: ["A", "B"], command: ["claude", "-p"] })).toEqual([
      "exec", "-i", "-w", "/workspace/repo", "-e", "A", "-e", "B", "clot-g", "claude", "-p",
    ]);
  });

  it("creates a missing container", () => {
    expect(containerStep(undefined, "sha256:new")).toBe("create");
  });

  it("recreates a container made from an older build of the image, running or not", () => {
    expect(containerStep("true sha256:old", "sha256:new")).toBe("recreate");
    expect(containerStep("false sha256:old", "sha256:new")).toBe("recreate");
  });

  it("starts a stopped container on the current image and leaves a running one alone", () => {
    expect(containerStep("false sha256:new", "sha256:new")).toBe("start");
    expect(containerStep("true sha256:new", "sha256:new")).toBe("none");
  });

  it("keeps the container when the image cannot be read", () => {
    expect(containerStep("true sha256:old", undefined)).toBe("none");
  });
});

describe("the runner's worker turns", () => {
  const guard = { branch: "clot/fix-a1b2", base: "main", repo: "o/r" };

  it("names a step by the command's first two words, or by the tool", () => {
    expect(stepOf({ name: "Bash", input: { command: "npm test -- --run\nsecond line" } })).toBe("npm test");
    expect(stepOf({ name: "Bash", input: { command: `psql postgres://user:secret@db/x -c "select 1"` } })).toBe("psql postgres://user:secret@db/x");
    expect(stepOf({ name: "Bash", input: { command: `${"x".repeat(200)} y` } })).toHaveLength(120);
    expect(stepOf({ name: "Edit", input: { file_path: "a.ts" } })).toBe("Edit");
  });

  it("denies what the guard refuses, and lets the rest through", () => {
    expect(workerHookAnswer("Bash", { command: "gh pr merge 3" }, guard).hookSpecificOutput).toMatchObject({ permissionDecision: "deny", permissionDecisionReason: expect.stringContaining("gh pr merge") });
    expect(workerHookAnswer("Bash", { command: "npm test" }, guard)).toEqual({});
    expect(workerHookAnswer("Edit", { file_path: "a.ts" }, guard)).toEqual({});
  });

  it("denies every MCP tool but the worker's own", () => {
    expect(workerHookAnswer("mcp__claude_ai_Slack__send_message", {}, guard).hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(workerHookAnswer("mcp__clots__start_session", {}, guard).hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(workerHookAnswer("mcp__clots_worker__ask_main", { question: "?" }, guard)).toEqual({});
  });

  it("runs a worker without permission prompts, on its own model and effort, in its own directory, with auto memory off", () => {
    const options = turnOptions(
      { role: "worker", prompt: "x", effort: "xhigh", model: "claude-opus-5-5", cwd: "/workspace/worktrees/w1", systemPrompt: "WORKER", guard, workerTools: { askMain: async () => "" }, onText: () => undefined, onStep: () => undefined },
      { clot: "graphite", env: {} },
    );
    expect(options).toMatchObject({ permissionMode: "bypassPermissions", model: "claude-opus-5-5", effort: "xhigh", cwd: "/workspace/worktrees/w1", disallowedTools: ["AskUserQuestion"] });
    expect(options.systemPrompt).toMatchObject({ append: "WORKER" });
    expect(options.settings).toMatchObject({ autoMemoryEnabled: false });
    expect(Object.keys(options.mcpServers ?? {})).toEqual(["clots_worker"]);
    expect(options.canUseTool).toBeUndefined();
  });

  it("runs a main session turn under the lock, with only NotebookEdit removed", () => {
    const options = turnOptions({ role: "main", prompt: "x", effort: "low", model: "claude-opus-5-5", onText: () => undefined }, { clot: "graphite", env: {} });
    expect(options).toMatchObject({ permissionMode: "default", model: "claude-opus-5-5", cwd: "/workspace/repo", disallowedTools: ["AskUserQuestion", "NotebookEdit"] });
    expect(options.canUseTool).toBeDefined();
  });
});

describe("worker steps in the container", () => {
  it("passes the branch and the path as the script's arguments, never in its text", () => {
    const args = workerExec.addWorktree("clot-g", "/workspace/worktrees/w1", "clot/x-$(rm -rf)-1a2b", "main");
    expect(args.slice(0, 4)).toEqual(["exec", "clot-g", "sh", "-c"]);
    expect(args[4]).toBe('git -C /workspace/repo fetch origin && git -C /workspace/repo worktree add --no-track -b "$1" "$2" "origin/$3"');
    expect(args.slice(5)).toEqual(["sh", "clot/x-$(rm -rf)-1a2b", "/workspace/worktrees/w1", "main"]);
    expect(workerExec.removeWorktree("clot-g", "/workspace/worktrees/w1").slice(-2)).toEqual(["sh", "/workspace/worktrees/w1"]);
    expect(workerExec.refreshMain("clot-g", "main").slice(-2)).toEqual(["sh", "main"]);
    expect(workerExec.defaultBranch("clot-g")).toEqual(["exec", "clot-g", "git", "-C", "/workspace/repo", "symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  });

  it("gives a home Clot worker a plain directory", () => {
    expect(worktreePath("w1", true)).toBe("/workspace/workers/w1");
    expect(worktreePath("w1", false)).toBe("/workspace/worktrees/w1");
    expect(workerExec.addDirectory("clot-home", "/workspace/workers/w1")).toEqual(["exec", "clot-home", "mkdir", "-p", "/workspace/workers/w1"]);
  });
});

describe("worker turn helpers", () => {
  it("names a branch after the title", () => {
    expect(workerBranch("Fix the login redirect!!", () => "a1b2")).toBe("clot/fix-the-login-redirect-a1b2");
    const long = workerBranch("word ".repeat(20), () => "a1b2");
    const slug = long.slice("clot/".length, -"-a1b2".length);
    expect(slug.length).toBeLessThanOrEqual(40);
    expect(slug.endsWith("-")).toBe(false);
  });

  it("keeps only what was written after the last step as the report", () => {
    const buffer = new ReportBuffer();
    buffer.onText("Looking.");
    buffer.onStep();
    buffer.onText("Changed\n- a.ts");
    buffer.onText("Pull request\nhttps://github.com/o/r/pull/3");
    expect(buffer.report()).toBe("Changed\n- a.ts\n\nPull request\nhttps://github.com/o/r/pull/3");
    expect(prLink(buffer.report())).toBe("https://github.com/o/r/pull/3");
    buffer.onStep();
    expect(buffer.report()).toBe("Pull request\nhttps://github.com/o/r/pull/3");
    expect(buffer.lastLine()).toBe("Pull request");
  });

  it("builds the next prompt from the cut-off note, the brief and the stored messages", () => {
    expect(workerPrompt({ interrupted: false, brief: "Do X.", messages: ["Also Y."] })).toBe("Do X.\n\n[From the main session]\nAlso Y.");
    expect(workerPrompt({ interrupted: true, messages: [], continueText: "Continue." }).endsWith("Continue.")).toBe(true);
    expect(workerPrompt({ interrupted: true, messages: [] }).startsWith("[Your previous turn was cut off")).toBe(true);
  });
});
