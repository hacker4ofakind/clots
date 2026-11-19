import type { McpServerStatus } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it, vi } from "vitest";
import { connectorTools, isClaudeAiConnector, settledStatus } from "../src/agent/connectors.js";

const tool = (name: string, annotations?: { readOnly?: boolean; destructive?: boolean }) => ({ name, ...(annotations ? { annotations } : {}) });
const server = (name: string, o: Partial<McpServerStatus>): McpServerStatus => ({ name, status: "connected", ...o });

describe("connectorTools", () => {
  it("keeps only read, non-destructive tools of connected claude.ai connectors, by the name a hook sees", () => {
    const got = connectorTools([
      server("claude.ai Docs", { scope: "claudeai", tools: [tool("search", { readOnly: true }), tool("read doc", { readOnly: true, destructive: false }), tool("delete", { readOnly: false, destructive: true }), tool("odd", { readOnly: true, destructive: true }), tool("unmarked")] }),
      server("claude.ai Empty", { scope: "claudeai", tools: [tool("write", { readOnly: false })] }),
      server("project-server", { scope: "project", tools: [tool("search", { readOnly: true })] }),
      server("claude.ai Down", { scope: "claudeai", status: "failed", tools: [tool("search", { readOnly: true })] }),
      server("claude.ai Via Source", { source: "claudeai", tools: [tool("list", { readOnly: true })] }),
    ]);
    expect([...got.tools].sort()).toEqual(["mcp__claude_ai_Docs__read_doc", "mcp__claude_ai_Docs__search", "mcp__claude_ai_Via_Source__list"]);
    expect(got.servers).toEqual(["claude.ai Docs", "claude.ai Via Source"]);
  });

  it("is empty with no connector at all", () => {
    expect(connectorTools([]).tools.size).toBe(0);
    expect(connectorTools([server("mine", { scope: "local", tools: [tool("x", { readOnly: true })] })]).tools.size).toBe(0);
  });

  it("tells a connector from a project server by scope or source, and trusts no name", () => {
    expect(isClaudeAiConnector({ scope: "claudeai" })).toBe(true);
    expect(isClaudeAiConnector({ source: "claudeai" })).toBe(true);
    expect(isClaudeAiConnector({ scope: "project", source: "project" })).toBe(false);
    expect(isClaudeAiConnector({})).toBe(false);
  });
});

describe("settledStatus", () => {
  it("waits while a server is still connecting, and then answers", async () => {
    const answers = [[server("a", { status: "pending" })], [server("a", { status: "pending" })], [server("a", {})]];
    const read = vi.fn(async () => answers.shift()!);
    const sleeps: number[] = [];
    const got = await settledStatus(read, { sleep: async (ms) => void sleeps.push(ms) });
    expect(got[0].status).toBe("connected");
    expect(read).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([500, 500]);
  });

  it("gives up after the time limit and answers what it last saw", async () => {
    const read = vi.fn(async () => [server("a", { status: "pending" })]);
    const got = await settledStatus(read, { timeoutMs: 2000, everyMs: 500, sleep: async () => undefined });
    expect(got[0].status).toBe("pending");
    expect(read).toHaveBeenCalledTimes(5);
  });
});
