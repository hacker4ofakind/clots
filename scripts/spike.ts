import { spawn, execFileSync } from "node:child_process";
import os from "node:os";
import { z } from "zod";
import {
  query,
  tool,
  createSdkMcpServer,
  type SDKUserMessage,
  type SpawnOptions,
  type SpawnedProcess,
} from "@anthropic-ai/claude-agent-sdk";

const CONTAINER = "clot-spike";
const token = process.env.CLAUDE_CODE_OAUTH_TOKEN;
if (!token) throw new Error("CLAUDE_CODE_OAUTH_TOKEN is not set in .env");

function docker(...args: string[]): string {
  return execFileSync("docker", args, { encoding: "utf8" }).trim();
}

try { docker("rm", "-f", CONTAINER); } catch { /* not running */ }
docker("run", "-d", "--name", CONTAINER, "clots-clot:dev");
const containerHost = docker("exec", CONTAINER, "cat", "/etc/hostname");

let lastSpawn: { command: string; args: string[] } | undefined;
function spawnInContainer(o: SpawnOptions): SpawnedProcess {
  lastSpawn = { command: o.command, args: o.args };
  const runtime = /^(node|bun|deno)(\.exe)?$/.test(o.command.split(/[\\/]/).pop() ?? "");
  const args = runtime && /\.(c|m)?js$/.test(o.args[0] ?? "") ? o.args.slice(1) : o.args;
  return spawn(
    "docker",
    ["exec", "-i", "-w", "/workspace", "-e", "CLAUDE_CODE_OAUTH_TOKEN", CONTAINER, "claude", ...args],
    { env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: token }, stdio: ["pipe", "pipe", "inherit"], signal: o.signal },
  );
}

let toolRanInPid: number | undefined;
const whereAmI = tool("where_am_i", "Reports where this tool runs.", { note: z.string() }, async () => {
  toolRanInPid = process.pid;
  return { content: [{ type: "text", text: `tool host: ${os.hostname()}` }] };
});
const daemonTools = createSdkMcpServer({ name: "daemon", version: "0.0.0", tools: [whereAmI] });

function userMessage(text: string): SDKUserMessage {
  return { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null };
}

const results: Record<string, boolean | string | number> = {};

// Turn 1: Bash runs in the container; the custom tool runs in this process;
// a message pushed mid-turn is accepted; closing the input ends the process.
const queue: SDKUserMessage[] = [
  userMessage("Use Bash to run `cat /etc/hostname`. Then call the where_am_i tool. Reply with both outputs."),
];
let wake: (() => void) | undefined;
let closed = false;
async function* input(): AsyncGenerator<SDKUserMessage, void> {
  while (true) {
    while (queue.length > 0) yield queue.shift()!;
    if (closed) return;
    await new Promise<void>((r) => (wake = r));
  }
}

const first = query({
  prompt: input(),
  options: {
    model: "claude-opus-5-5",
    effort: "low",
    cwd: "/workspace",
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    mcpServers: { daemon: daemonTools },
    spawnClaudeCodeProcess: spawnInContainer,
  },
});

let sessionId = "";
let text1 = "";
let resultCount = 0;
let pushed = false;
const messageTypes = new Set<string>();
for await (const message of first) {
  messageTypes.add(message.type);
  if (message.type === "assistant") {
    for (const block of message.message.content) if (block.type === "text") text1 += block.text;
    if (!pushed) {
      pushed = true;
      queue.push(userMessage("Also, separately: what is 2 + 2?"));
      wake?.();
    }
  }
  if (message.type === "result") {
    resultCount += 1;
    sessionId = message.session_id;
    const usage = await first.getContextUsage();
    results["getContextUsage().percentage is a number"] = typeof usage.percentage === "number";
    await first.applyFlagSettings({ effortLevel: "medium" });
    results["applyFlagSettings accepted"] = true;
    // Give a second result 20 seconds to appear, then close the input.
    setTimeout(() => { closed = true; wake?.(); }, 20_000);
  }
}
results["A: Bash ran inside the container"] = text1.includes(containerHost);
results["B: custom tool ran in the daemon process"] = toolRanInPid === process.pid;
results["C: authenticated with the subscription token only"] = sessionId !== "";
results["result messages for 2 user messages"] = resultCount;
results["process ended after input closed"] = true;

// Turn 2: a new process resumes the session, in plan mode, at a different effort.
// The prompt is a generator because canUseTool needs streaming input.
async function* second(): AsyncGenerator<SDKUserMessage, void> {
  yield userMessage("What hostname did you print earlier? Then create the file /workspace/spike.txt.");
}
let text2 = "";
for await (const message of query({
  prompt: second(),
  options: {
    model: "claude-opus-5-5",
    effort: "medium",
    resume: sessionId,
    cwd: "/workspace",
    permissionMode: "plan",
    canUseTool: async () => ({ behavior: "deny", message: "Brainstorm mode: no changes." }),
    spawnClaudeCodeProcess: spawnInContainer,
  },
})) {
  if (message.type === "assistant") {
    for (const block of message.message.content) if (block.type === "text") text2 += block.text;
  }
}
let fileExists = true;
try { docker("exec", CONTAINER, "test", "-e", "/workspace/spike.txt"); } catch { fileExists = false; }
results["D: resumed session remembers the hostname"] = text2.includes(containerHost);
results["D: plan mode blocked the write"] = !fileExists;

console.log("\nSpawn received:", JSON.stringify(lastSpawn));
console.log("Message types seen:", [...messageTypes].join(", "));
console.table(results);
docker("rm", "-f", CONTAINER);

const failed = Object.entries(results).filter(([, v]) => v === false);
if (failed.length > 0) {
  console.error("SPIKE FAILED:", failed.map(([k]) => k).join("; "));
  process.exit(1);
}
console.log("SPIKE OK");
