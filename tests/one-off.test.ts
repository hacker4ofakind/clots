import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  statuses: [] as unknown[],
  messages: [] as unknown[],
  hang: false,
  options: undefined as any,
  pushed: [] as string[],
  spawn: undefined as any,
  killed: [] as string[],
  deleted: [] as string[],
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: ({ prompt, options }: { prompt: AsyncIterable<any>; options: any }) => {
    fake.options = options;
    return {
      mcpServerStatus: async () => fake.statuses,
      async *[Symbol.asyncIterator]() {
        for await (const m of prompt) {
          fake.pushed.push(m.message.content);
          break;
        }
        if (fake.hang) await new Promise((_, reject) => options.abortController.signal.addEventListener("abort", () => reject(new Error("aborted"))));
        for (const m of fake.messages) yield m;
      },
    };
  },
}));

vi.mock("../src/agent/container.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/agent/container.js")>()),
  killSession: async (_container: string, id: string) => void fake.killed.push(id),
  deleteSession: async (_container: string, id: string) => void fake.deleted.push(id),
  makeSpawn: (o: unknown) => ((fake.spawn = o), () => ({})),
}));

import { SdkRunner, type OneOffRequest } from "../src/agent/runner.js";

const req = (over: Partial<OneOffRequest> = {}): OneOffRequest => ({ kind: "sweep", prompt: (c) => `connectors: ${c.join(",")}`, systemPrompt: "s", model: "m", effort: "low", schema: { type: "object" }, timeoutMs: 60_000, ...over });
const docs = { name: "claude.ai Docs", status: "connected", scope: "claudeai", tools: [{ name: "search", annotations: { readOnly: true } }] };
const success = (output: unknown, cost = 0.3) => ({ type: "result", subtype: "success", is_error: false, structured_output: output, total_cost_usd: cost });
const runner = (o: Partial<ConstructorParameters<typeof SdkRunner>[0]> = {}) => new SdkRunner({ clot: "home", env: { GH_TOKEN: "ghp_secret" }, cwd: "/workspace", ...o });

beforeEach(() => {
  fake.statuses = [docs];
  fake.messages = [success({ findings: [], record: "r" })];
  fake.hang = false;
  fake.pushed = [];
  fake.killed = [];
  fake.deleted = [];
  fake.options = undefined;
  fake.spawn = undefined;
});

describe("runOneOff", () => {
  it("answers with the structured output and the cost, tells the prompt the connectors, and deletes its transcript", async () => {
    const got = await runner().runOneOff(req());
    expect(got).toMatchObject({ ok: true, output: { findings: [], record: "r" }, totalCostUsd: 0.3, connectors: ["claude.ai Docs"] });
    expect(fake.pushed).toEqual(["connectors: claude.ai Docs"]);
    expect(fake.deleted).toHaveLength(1);
    expect(fake.options.maxTurns).toBe(30);
    expect(fake.options.outputFormat).toEqual({ type: "json_schema", schema: { type: "object" } });
    expect(fake.options.mcpServers).toBeUndefined();
  });

  it("gives the sweep no built-in tools and no GitHub token, and re-grounding the token", async () => {
    await runner().runOneOff(req());
    expect(fake.options.tools).toEqual([]);
    expect(fake.spawn.env.GH_TOKEN).toBeUndefined();
    expect(fake.spawn.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe("1");
    await runner().runOneOff(req({ kind: "reground" }));
    expect(fake.options.tools).toBeUndefined();
    expect(fake.spawn.env.GH_TOKEN).toBe("ghp_secret");
  });

  it("answers the lock's refusals in its hook, after the connectors are known", async () => {
    await runner().runOneOff(req());
    const hook = fake.options.hooks.PreToolUse[0].hooks[0];
    expect(await hook({ hook_event_name: "PreToolUse", tool_name: "mcp__claude_ai_Docs__search", tool_input: {} })).toEqual({});
    expect((await hook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } })).hookSpecificOutput.permissionDecision).toBe("deny");
    expect((await fake.options.canUseTool("Read", {})).behavior).toBe("deny");
    expect((await fake.options.canUseTool("mcp__claude_ai_Docs__search", { q: 1 })).behavior).toBe("allow");
  });

  it("fails a sweep with no connector, sends no prompt, and still cleans up", async () => {
    fake.statuses = [{ name: "project-server", status: "connected", scope: "project", tools: [{ name: "x", annotations: { readOnly: true } }] }];
    const got = await runner().runOneOff(req());
    expect(got).toMatchObject({ ok: false, error: "no connector available" });
    expect(fake.pushed).toEqual([]);
    expect(fake.deleted).toHaveLength(1);
  });

  it("lets re-grounding go on with no connector", async () => {
    fake.statuses = [];
    expect(await runner({ env: { GH_TOKEN: "g", CLAUDE_CODE_OAUTH_TOKEN: "t" } }).runOneOff(req({ kind: "reground" }))).toMatchObject({ ok: true });
  });

  it("stops the process in the container and deletes the transcript when it runs out of time", async () => {
    fake.hang = true;
    const got = await runner().runOneOff(req({ timeoutMs: 20 }));
    expect(got).toMatchObject({ ok: false, error: "timed out" });
    expect(fake.killed).toHaveLength(1);
    expect(fake.deleted).toEqual(fake.killed);
  });

  it("is not ok on an error result or a success without structured output, and passes the limit on", async () => {
    fake.messages = [{ type: "result", subtype: "error_max_turns", is_error: true, total_cost_usd: 0.1 }];
    expect(await runner().runOneOff(req())).toMatchObject({ ok: false, error: "error_max_turns", totalCostUsd: 0.1 });
    fake.messages = [success(undefined)];
    expect(await runner().runOneOff(req())).toMatchObject({ ok: false, error: "no structured output" });
    fake.messages = [{ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: 99 } }, { type: "result", subtype: "error_during_execution", is_error: true }];
    expect(await runner().runOneOff(req())).toMatchObject({ ok: false, limit: { resetsAt: 99 } });
  });

  it("hands every rate-limit event to the meter", async () => {
    const seen: unknown[] = [];
    fake.messages = [{ type: "rate_limit_event", rate_limit_info: { status: "allowed", rateLimitType: "five_hour", utilization: 0.5, resetsAt: 10 } }, success({ findings: [], record: "" })];
    await runner({ onRateLimit: (s) => void seen.push(s) }).runOneOff(req());
    expect(seen).toEqual([{ status: "allowed", resetsAt: 10, utilization: 50, type: "five_hour" }]);
  });
});
