// Stage 2a assumption check: which permission mode lets the daemon approve some shell
// commands and refuse the rest, and does a message fed into such a turn get handled?
import { execFileSync } from "node:child_process";
import { query, type PermissionMode, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { makeSpawn } from "../src/agent/container.js";
import { InputQueue } from "../src/agent/input-queue.js";

const CONTAINER = "clot-spike2a";
const CWD = "/workspace/repo";
const docker = (...args: string[]) => execFileSync("docker", args, { encoding: "utf8" }).trim();
const exists = (path: string) => {
  try { docker("exec", CONTAINER, "test", "-e", path); return true; } catch { return false; }
};
const msg = (text: string): SDKUserMessage => ({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null });

async function run(mode: PermissionMode): Promise<Record<string, unknown>> {
  try { docker("rm", "-f", CONTAINER); } catch { /* not running */ }
  docker("run", "-d", "--name", CONTAINER, "clots-clot:dev");
  docker("exec", CONTAINER, "sh", "-c", `mkdir -p ${CWD} && echo heron-42 > ${CWD}/hello.txt`);

  const asked: string[] = [];
  const input = new InputQueue<SDKUserMessage>([
    msg(
      "Do these in order and do not retry anything that is refused. " +
        `1. Run \`ls ${CWD}\` with Bash. ` +
        `2. Run \`touch ${CWD}/blocked.txt\` with Bash. ` +
        `3. Run \`ping -c 1 127.0.0.1\` with Bash. ` +
        `4. Create ${CWD}/written.txt containing the word x, with whatever file tool you have. ` +
        "Then report in one line per step whether it RAN or was REFUSED.",
    ),
  ]);
  let pushed = false;
  let text = "";
  // What the tools printed, so the checks below do not rest on how the model words its report.
  let results = "";
  const session = query({
    prompt: input,
    options: {
      model: "claude-haiku-5-5",
      cwd: CWD,
      permissionMode: mode,
      disallowedTools: ["AskUserQuestion", "Edit", "Write", "NotebookEdit", "WebFetch", "WebSearch"],
      canUseTool: async (toolName, toolInput) => {
        const command = typeof toolInput.command === "string" ? toolInput.command : "";
        asked.push(toolName === "Bash" ? `Bash: ${command}` : toolName);
        if (toolName === "Bash" && /^(ls|cat|ping -c 1) /.test(command)) return { behavior: "allow", updatedInput: toolInput };
        return { behavior: "deny", message: "Investigation mode: this is not a read-only command on the approved list." };
      },
      spawnClaudeCodeProcess: makeSpawn({ container: CONTAINER, cwd: CWD, env: { CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN! } }),
    },
  });
  for await (const m of session) {
    if (m.type === "assistant") {
      for (const b of m.message.content) if (b.type === "text") text += b.text + "\n";
      if (!pushed) {
        pushed = true;
        input.push(msg(`[sent while you were working]\nAlso run \`cat ${CWD}/hello.txt\` and include what it prints.`));
      }
    }
    if (m.type === "user") results += JSON.stringify(m.message.content);
    if (m.type === "result") setTimeout(() => input.close(), m.queued_turn_count ? 60_000 : 8_000);
  }
  const outcome = {
    "callback was asked about": asked,
    "approved command ran (ping)": /64 bytes|1 packets transmitted|1 received/.test(results),
    "refused command did not run": !exists(`${CWD}/blocked.txt`),
    "no file could be written": !exists(`${CWD}/written.txt`),
    "message fed in mid-turn was handled": results.includes("heron-42") && text.includes("heron-42"),
  };
  docker("rm", "-f", CONTAINER);
  console.log(`\n=== permissionMode: ${mode}`);
  console.log(text.trim().split("\n").slice(-8).join("\n"));
  console.log(outcome);
  return outcome;
}

await run("plan");
await run("default");
