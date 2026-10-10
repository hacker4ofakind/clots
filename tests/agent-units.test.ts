import { describe, expect, it } from "vitest";
import { TurnTracker } from "../src/agent/turn-tracker.js";
import { parseRateLimit } from "../src/agent/usage.js";
import { buildPrompt } from "../src/agent/prompts.js";
import { containerName, dockerExecArgs, pickSdkEnv, toContainerCommand } from "../src/agent/container.js";

describe("TurnTracker", () => {
  it("finishes on a result when nothing was pushed", () => {
    expect(new TurnTracker().onResult()).toBe("finish");
  });

  it("waits once after a push, then finishes", () => {
    const t = new TurnTracker();
    t.onPush();
    expect(t.onResult()).toBe("wait");
    expect(t.onResult()).toBe("finish");
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
    expect(prompt.endsWith("fix the footer")).toBe(true);
  });

  it("adds the action note only when the mode just changed back", () => {
    expect(buildPrompt({ ...base, modeChanged: true })).toContain("Brainstorm mode is OFF");
  });

  it("puts the recap first and the interruption note second", () => {
    const prompt = buildPrompt({ ...base, seed: "RECAP TEXT", interrupted: true });
    expect(prompt.indexOf("RECAP TEXT")).toBeLessThan(prompt.indexOf("cut off"));
    expect(prompt.indexOf("cut off")).toBeLessThan(prompt.indexOf("fix the footer"));
  });
});

describe("container helpers", () => {
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

  it("builds docker exec arguments that pass env by name only", () => {
    expect(dockerExecArgs({ container: "clot-g", cwd: "/workspace/repo", envKeys: ["A", "B"], command: ["claude", "-p"] })).toEqual([
      "exec", "-i", "-w", "/workspace/repo", "-e", "A", "-e", "B", "clot-g", "claude", "-p",
    ]);
  });
});
