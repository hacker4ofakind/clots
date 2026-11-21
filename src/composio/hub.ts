import type { ToolResult } from "../mcp/hub.js";
import type { Hub } from "../watch.js";
import type { Composio } from "./component.js";
import { isRead } from "./rating.js";

/**
 * A watch recipe's view of a Composio account, in the shape of an MCP server's: the recipe names the account
 * (`reddit:me`) where it would name a server. `listTools` answers the one tool the recipe uses, marked read-only
 * when Composio's tags and the daemon's own rating say it only reads, so the watch's check of its tool works
 * unchanged; `callTool` runs it on the account (counted by the meter) and gives the data as structured content.
 */
export function composioHub(c: Pick<Composio, "account" | "tool" | "run">): Hub {
  return {
    async listTools(name, tool) {
      const account = c.account(name);
      if (account === undefined || tool === undefined) return [];
      const info = await c.tool(tool);
      if (info === undefined || info.toolkit !== account.toolkit) return [];
      return [{ name: info.slug, description: info.description, readOnly: isRead(info) }];
    },
    async callTool(name, tool, args): Promise<ToolResult> {
      const account = c.account(name);
      if (account === undefined) return { text: `there is no Composio account ${name}`, isError: true };
      const result = await c.run(account, tool, args);
      if (!result.ok) return { text: result.error, isError: true };
      return { structured: result.data, text: JSON.stringify(result.data ?? null), isError: false };
    },
  };
}
