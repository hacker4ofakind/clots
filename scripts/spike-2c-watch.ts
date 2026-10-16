// Stage 2c watch-recipe assumption check: calls one read-only tool of an MCP server the daemon
// is logged in to, and shows whether its result can be read as JSON items with IDs.
// Run: node --env-file=.env --import tsx scripts/spike-2c-watch.ts <server> <tool> '<arguments as JSON>'
import fs from "node:fs";
import { loadConfig } from "../src/config.js";
import { McpHub, sdkOpener } from "../src/mcp/hub.js";
import { StoredOAuth } from "../src/mcp/oauth.js";
import { Store } from "../src/store.js";

const [server, tool, args = "{}"] = process.argv.slice(2);
const config = loadConfig(JSON.parse(fs.readFileSync("clots.config.json", "utf8")), process.env);
const store = new Store("data/clots.db");
const auth = new StoredOAuth({ server, store, redirectUrl: `${config.publicUrl}/oauth/callback`, now: () => Date.now(), onLink: (url) => console.log("NEEDS LOGIN:", url) });
const hub = new McpHub({ names: [server], opener: sdkOpener({ servers: config.mcpServers, auth: () => auth }), tell: async () => undefined });
const tools = await hub.listTools(server);
console.log("tools:", tools.map((t) => `${t.name}${t.readOnly ? " (read-only)" : ""}`).join(", "));
const result = await hub.callTool(server, tool, JSON.parse(args));
console.log("structured content:", result.structured === undefined ? "none" : JSON.stringify(result.structured).slice(0, 2000));
console.log("text:", result.text.slice(0, 3000));
let parsed: unknown;
try {
  parsed = result.structured ?? JSON.parse(result.text);
  console.log("JSON: yes, top-level keys:", typeof parsed === "object" && parsed !== null ? Object.keys(parsed).join(", ") : typeof parsed);
} catch {
  console.log("JSON: NO");
}
process.exit(0);
