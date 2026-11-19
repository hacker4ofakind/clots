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
 * themselves read-only, not destructive and not open-world. A tool with no annotation is not trusted to read.
 */
export function connectorTools(statuses: McpServerStatus[]): Connectors {
  const tools = new Set<string>();
  const servers: string[] = [];
  for (const server of statuses) {
    if (server.status !== "connected" || !isClaudeAiConnector(server)) continue;
    let any = false;
    for (const tool of server.tools ?? []) {
      // openWorld tools reach arbitrary outside addresses (a scrape, a search): text a stranger wrote could make one carry data out in a URL.
      if (tool.annotations?.readOnly !== true || tool.annotations.destructive === true || tool.annotations.openWorld === true) continue;
      tools.add(mcpToolName(server.name, tool.name));
      any = true;
    }
    if (any) servers.push(server.name);
  }
  return { tools, servers };
}

/**
 * Polls the MCP status until no server is still connecting, for up to `timeoutMs`. With `expectServers`, an empty list
 * counts as not settled too: a login's connectors are fetched after the session starts, and the list is empty until then.
 * Returns the last status.
 */
export async function settledStatus(read: () => Promise<McpServerStatus[]>, o: { timeoutMs?: number; everyMs?: number; expectServers?: boolean; sleep?: (ms: number) => Promise<void> } = {}): Promise<McpServerStatus[]> {
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const every = o.everyMs ?? 500;
  let waited = 0;
  let status = await read();
  const unsettled = (list: McpServerStatus[]) => list.some((server) => server.status === "pending") || (o.expectServers === true && list.length === 0);
  while (unsettled(status) && waited < (o.timeoutMs ?? 30_000)) {
    await sleep(every);
    waited += every;
    status = await read();
  }
  return status;
}
