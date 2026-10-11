import { describe, expect, it } from "vitest";
import { isTurnActivity, TurnTracker } from "../src/agent/turn-tracker.js";
import { parseRateLimit } from "../src/agent/usage.js";
import { buildPrompt, CLOT_SYSTEM_PROMPT, PR_ATTRIBUTION } from "../src/agent/prompts.js";
import { containerName, dockerExecArgs, gitIdentity, noreplyEmail, pickSdkEnv, sessionEnv, toContainerCommand } from "../src/agent/container.js";

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
  const base = { text: "fix the footer", mode: "action" as const, modeChanged: false, seed: null, interrupted: false };

  it("passes plain text through in action mode", () => {
    expect(buildPrompt(base)).toBe("fix the footer");
  });

  it("adds the brainstorm note on every brainstorm turn", () => {
    const prompt = buildPrompt({ ...base, mode: "brainstorm" });
    expect(prompt).toContain("Brainstorm mode is ON");
    expect(prompt).toContain("the same thing");
    expect(prompt.endsWith("fix the footer")).toBe(true);
  });

  it("adds the action note only when the mode just changed back", () => {
    expect(buildPrompt({ ...base, modeChanged: true })).toContain("Brainstorm mode is OFF");
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
});
