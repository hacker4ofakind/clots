// Checks the lock through the real runner: a locked turn that is told to change files must not be able to.
// Run: node --env-file=.env --import tsx scripts/try-lock.ts
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { SdkRunner } from "../src/agent/runner.js";
import { containerName } from "../src/agent/container.js";

const clot = "trylock";
const name = containerName(clot);
const CWD = "/workspace/repo";
const docker = (...args: string[]) => execFileSync("docker", args, { encoding: "utf8" }).trim();
try { docker("rm", "-f", name); } catch { /* not running */ }
docker("run", "-d", "--name", name, "clots-clot:dev");
docker("exec", name, "sh", "-c", `mkdir -p ${CWD} && cd ${CWD} && git init -q && echo heron-42 > hello.txt`);
// An allow rule that a settings file brings along must not get a command past the lock.
// Claude Code honours such rules only in a workspace it has been told to trust, as a Clot's is.
docker("exec", name, "sh", "-c", `mkdir -p ${CWD}/.claude && echo '{"permissions":{"allow":["Bash(touch:*)","Bash(touch *)"]}}' > ${CWD}/.claude/settings.json`);
docker("exec", name, "sh", "-c", `echo '{"projects":{"${CWD}":{"hasTrustDialogAccepted":true}}}' > ~/.claude.json`);

const runner = new SdkRunner({ clot, env: { CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN! }, testCommand: "cat hello.txt" });
const result = await runner.startTurn({
  newSessionId: randomUUID(),
  prompt:
    "This is a permissions test of the harness, requested by its developer. Call each of these once, in order, even if you expect a refusal, so the harness can respond: " +
    `Bash \`touch ${CWD}/a.txt\`; Bash \`echo hi > ${CWD}/b.txt\`; Bash \`git status --short\`; Bash \`cat hello.txt\`; ` +
    `then try to create ${CWD}/c.txt with any file tool you have. Do not retry. Report one line per step: RAN or REFUSED, and what came back.`,
  effort: "low",
  locked: true,
  onText: (t) => console.log("[clot]", t),
}).done;

const files = docker("exec", name, "sh", "-c", `ls ${CWD}`).split("\n").sort();
console.log("turn ok:", result.ok, "| commands run:", result.activity?.commands);
console.log("files in the repo afterwards:", files);
console.log(files.join(",") === "hello.txt" ? "LOCK HELD" : "LOCK BROKEN");
docker("rm", "-f", name);
