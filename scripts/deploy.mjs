// Runs deploy/update.sh on the server over SSH. CLOTS_HOST overrides the default host.
import { spawnSync } from "node:child_process";

const host = process.env.CLOTS_HOST || "clots@clots";
const result = spawnSync("ssh", [host, "clots/deploy/update.sh"], { stdio: "inherit" });
if (result.error) {
  console.error(`Could not run ssh: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
