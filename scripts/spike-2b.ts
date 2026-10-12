// Stage 2b assumption check: can a session whose process runs in the container call a tool that
// lives in this process, in a turn that is locked, and does a resumed session use the handlers
// of the turn that resumed it?
// Run: node --env-file=.env --import tsx scripts/spike-2b.ts
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createSdkMcpServer, query, tool, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { makeSpawn } from "../src/agent/container.js";
import { InputQueue } from "../src/agent/input-queue.js";

const CONTAINER = "clot-spike2b";
const CWD = "/workspace/repo";
const docker = (...args: string[]) => execFileSync("docker", args, { encoding: "utf8" }).trim();
const msg = (text: string): SDKUserMessage => ({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null });

async function turn(o: { sessionId: string; resume: boolean; secret: string }): Promise<{ text: string; hookSaw: string[]; called: number }> {
  const hookSaw: string[] = [];
  let called = 0;
  const server = createSdkMcpServer({
    name: "clots",
    version: "1.0.0",
    tools: [
      tool(
        "daemon_value",
        "Returns a value that only the daemon process knows.",
        {},
        async () => {
          called += 1;
          return { content: [{ type: "text" as const, text: o.secret }] };
        },
        { alwaysLoad: true },
      ),
    ],
  });
  const input = new InputQueue<SDKUserMessage>([msg("Call the daemon_value tool once, then reply with exactly the value it returned and nothing else.")]);
  let text = "";
  const session = query({
    prompt: input,
    options: {
      model: "claude-haiku-5-5",
      cwd: CWD,
      // The lock's shape: the default mode, a hook asked before every call, and a callback.
      permissionMode: "default",
      ...(o.resume ? { resume: o.sessionId } : { sessionId: o.sessionId }),
      disallowedTools: ["AskUserQuestion", "Edit", "Write", "NotebookEdit"],
      mcpServers: { clots: server },
      hooks: {
        PreToolUse: [
          {
            hooks: [
              async (hook) => {
                if (hook.hook_event_name === "PreToolUse") hookSaw.push(hook.tool_name);
                return {};
              },
            ],
          },
        ],
      },
      canUseTool: async (toolName, toolInput) =>
        toolName.startsWith("mcp__clots__") ? { behavior: "allow" as const, updatedInput: toolInput } : { behavior: "deny" as const, message: "locked" },
      spawnClaudeCodeProcess: makeSpawn({ container: CONTAINER, cwd: CWD, env: { CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN! } }),
    },
  });
  for await (const m of session) {
    if (m.type === "assistant") for (const b of m.message.content) if (b.type === "text") text += b.text;
    if (m.type === "result") input.close();
  }
  return { text, hookSaw, called };
}

try { docker("rm", "-f", CONTAINER); } catch { /* not running */ }
docker("run", "-d", "--name", CONTAINER, "clots-clot:dev");
docker("exec", CONTAINER, "sh", "-c", `mkdir -p ${CWD}`);

const sessionId = randomUUID();
const first = await turn({ sessionId, resume: false, secret: "heron-17" });
const second = await turn({ sessionId, resume: true, secret: "otter-58" });
docker("rm", "-f", CONTAINER);

const checks = {
  "1. a tool in the daemon was called from the container": first.called === 1 && first.text.includes("heron-17"),
  "2. the lock's hook saw it by name and the call ran": first.hookSaw.includes("mcp__clots__daemon_value"),
  "3. the resumed session used the new turn's handler": second.called === 1 && second.text.includes("otter-58") && !second.text.includes("heron-17"),
};
console.log("hook saw:", first.hookSaw, second.hookSaw);
for (const [name, passed] of Object.entries(checks)) console.log(passed ? "PASS" : "FAIL", name);
console.log(Object.values(checks).every(Boolean) ? "SPIKE OK" : "SPIKE FAILED");
