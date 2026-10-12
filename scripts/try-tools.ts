// Checks the daemon's tools through the real runner: a locked turn calls them, and still cannot change a file.
// Run: node --env-file=.env --import tsx scripts/try-tools.ts
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { containerName } from "../src/agent/container.js";
import { SdkRunner } from "../src/agent/runner.js";
import type { DaemonTools } from "../src/tools.js";

const clot = "trytools";
const name = containerName(clot);
const CWD = "/workspace/repo";
const docker = (...args: string[]) => execFileSync("docker", args, { encoding: "utf8" }).trim();
try { docker("rm", "-f", name); } catch { /* not running */ }
docker("run", "-d", "--name", name, "clots-clot:dev");
docker("exec", name, "sh", "-c", `mkdir -p ${CWD} && cd ${CWD} && git init -q && echo heron-42 > hello.txt`);

const calls: string[] = [];
const tools: DaemonTools = {
  show: async () => {
    calls.push("show");
    return "Rules in force for trytools\n\nTriage guidance:\n- [trytools] The secret word is otter-58.";
  },
  prefilter: async (a) => {
    calls.push(`prefilter ${a.action} ${a.file} ${JSON.stringify(a.rule)}`);
    return "Filed as a proposal.";
  },
  guidance: async () => "unused",
  standing: async () => "unused",
  send: async () => "unused",
};

const runner = new SdkRunner({ clot, env: { CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN! } });
const result = await runner.startTurn({
  newSessionId: randomUUID(),
  prompt:
    "This is a test of the harness, requested by its developer. Do these in order, once each, and do not retry: " +
    "1. Call the rulebook_show tool and tell me the secret word in its result. " +
    "2. Call rulebook_prefilter to add a pre-filter to your own file for the actor dependabot[bot]. " +
    `3. Run \`touch ${CWD}/a.txt\` with Bash. ` +
    "Report one line per step: what came back, or REFUSED.",
  effort: "low",
  locked: true,
  tools,
  onText: (t) => console.log("[clot]", t),
}).done;

const files = docker("exec", name, "sh", "-c", `ls ${CWD}`).split("\n").sort();
console.log("turn ok:", result.ok, "| tool calls:", calls, "| files:", files);
const passed = calls[0] === "show" && calls.some((c) => c.startsWith("prefilter add own") && c.includes("dependabot[bot]")) && files.join(",") === "hello.txt";
console.log(passed ? "TOOLS OK" : "TOOLS FAILED");
docker("rm", "-f", name);
