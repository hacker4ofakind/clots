// Global memory assumption check: does a session the daemon starts read MEMORY.md and follow a
// line in the daemon's block to the file, and does a resumed session see a block the daemon
// rewrote between its turns?
// Run: node --env-file=.env --import tsx scripts/spike-memory.ts
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { SdkRunner } from "../src/agent/runner.js";
import { containerName } from "../src/agent/container.js";

const clot = "spikememory";
const name = containerName(clot);
const MEMORY = "/home/clot/.claude/projects/-workspace-repo/memory";

/** Writes a file in the container as the daemon would: through `docker exec`, with the text on stdin. */
function put(path: string, text: string): void {
  execFileSync("docker", ["exec", "-i", name, "sh", "-c", 'mkdir -p "$(dirname "$1")" && cat > "$1"', "sh", path], { input: text });
}

const block = (lines: string[]) =>
  ["<!-- clots: global memories, kept by the daemon. Do not edit. -->", ...lines, "<!-- clots: end of global memories -->", ""].join("\n");

try { execFileSync("docker", ["rm", "-f", name], { stdio: "ignore" }); } catch { /* not running */ }
execFileSync("docker", ["run", "-d", "--name", name, "clots-clot:dev"], { stdio: "ignore" });
execFileSync("docker", ["exec", name, "mkdir", "-p", "/workspace/repo"]);

put(`${MEMORY}/global-clot-colour.md`, "---\nname: Favourite colour\ndescription: the user's favourite colour\ntype: user\n---\n\nThe user's favourite colour is teal.\n");
put(`${MEMORY}/MEMORY.md`, block(["- [Favourite colour](global-clot-colour.md) — the user's favourite colour"]) + "- [Own note](own-note.md) — a line the Clot wrote itself\n");

const runner = new SdkRunner({ clot, env: { CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN! } });
const id = randomUUID();
const ask = async (prompt: string, resume: boolean) => {
  const result = await runner.startTurn({ ...(resume ? { resume: id } : { newSessionId: id }), prompt, effort: "low", locked: true, onText: (t) => console.log("[clot]", t) }).done;
  console.log("ok:", result.ok);
};

console.log("== new session");
await ask("First, without using any tool, copy out the lines of your memory index (MEMORY.md) exactly as they appear in your context, or say you have none. Then: what is the user's favourite colour? You may read files.", false);

put(`${MEMORY}/global-clot-pet.md`, "---\nname: Pet\ndescription: the user's pet\ntype: user\n---\n\nThe user's pet is a ferret named Bolt.\n");
put(
  `${MEMORY}/MEMORY.md`,
  block(["- [Favourite colour](global-clot-colour.md) — the user's favourite colour", "- [Pet](global-clot-pet.md) — the user's pet"]) + "- [Own note](own-note.md) — a line the Clot wrote itself\n",
);

console.log("== resumed session, after the block was rewritten");
await ask("Without using any tool, copy out the lines of your memory index (MEMORY.md) exactly as they appear in your context now, and say whether they differ from what you saw at the start.", true);

execFileSync("docker", ["rm", "-f", name], { stdio: "ignore" });
