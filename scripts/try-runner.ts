import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { SdkRunner } from "../src/agent/runner.js";
import { containerName } from "../src/agent/container.js";

const clot = "tryrunner";
const name = containerName(clot);
try { execFileSync("docker", ["rm", "-f", name], { stdio: "ignore" }); } catch { /* not running */ }
execFileSync("docker", ["run", "-d", "--name", name, "clots-clot:dev"], { stdio: "ignore" });
execFileSync("docker", ["exec", name, "mkdir", "-p", "/workspace/repo"]);

const runner = new SdkRunner({ clot, env: { CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN! } });
const id = randomUUID();

const first = await runner.startTurn({
  newSessionId: id,
  prompt: "Use Bash to run `pwd` and tell me the result. Remember the word 'heron'.",
  effort: "low",
  role: "main",
  model: "claude-opus-5-5",
  onText: (t) => console.log("[clot]", t),
}).done;
console.log("first:", first);

const second = await runner.startTurn({
  resume: id,
  prompt: "Which word did I ask you to remember?",
  effort: "low",
  role: "main",
  model: "claude-opus-5-5",
  onText: (t) => console.log("[clot]", t),
}).done;
console.log("second:", second);

const still = execFileSync("docker", ["exec", name, "sh", "-c", "grep -l '[c]laude' /proc/[0-9]*/cmdline 2>/dev/null || echo none"], { encoding: "utf8" }).trim();
console.log("claude processes left in the container:", still);
execFileSync("docker", ["rm", "-f", name], { stdio: "ignore" });
