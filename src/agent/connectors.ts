import type { McpServerStatus } from "@anthropic-ai/claude-agent-sdk";
import { mcpToolName } from "./command-check.js";

/** The claude.ai login's connectors a session has, as far as they may be read from. */
export interface Connectors {
  /** The tools that only read, by the name a hook sees. */
  tools: Set<string>;
  /** The names of the connectors that have at least one such tool, as the MCP status gives them. */
  servers: string[];
}

/**
 * A server is a claude.ai connector when its scope or its source says so. A server from a project's
 * settings, a plugin or the SDK host never is, whatever it is called.
 */
export function isClaudeAiConnector(server: Pick<McpServerStatus, "scope" | "source">): boolean {
  return server.scope === "claudeai" || server.source === "claudeai";
}

/**
 * The tools a connector-only session may call: those of connected claude.ai connectors that declare
 * themselves read-only and not destructive. A tool with no annotation is not trusted to read.
 */
export function connectorTools(statuses: McpServerStatus[]): Connectors {
  const tools = new Set<string>();
  const servers: string[] = [];
  for (const server of statuses) {
    if (server.status !== "connected" || !isClaudeAiConnector(server)) continue;
    let any = false;
    for (const tool of server.tools ?? []) {
      if (tool.annotations?.readOnly !== true || tool.annotations.destructive === true) continue;
      tools.add(mcpToolName(server.name, tool.name));
      any = true;
    }
    if (any) servers.push(server.name);
  }
  return { tools, servers };
}

/** Polls the MCP status until no server is still connecting, for up to `timeoutMs`. Returns the last status. */
export async function settledStatus(read: () => Promise<McpServerStatus[]>, o: { timeoutMs?: number; everyMs?: number; sleep?: (ms: number) => Promise<void> } = {}): Promise<McpServerStatus[]> {
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const every = o.everyMs ?? 500;
  let waited = 0;
  let status = await read();
  while (status.some((server) => server.status === "pending") && waited < (o.timeoutMs ?? 30_000)) {
    await sleep(every);
    waited += every;
    status = await read();
  }
  return status;
}
