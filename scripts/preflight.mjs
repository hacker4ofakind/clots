import os from "node:os";
import fs from "node:fs";
import { execFileSync } from "node:child_process";

const need = { cpus: 4, memGb: 8, diskGb: 20, node: 22 };
const problems = [];

const cpus = os.cpus().length;
const memGb = os.totalmem() / 1024 ** 3;
const stat = fs.statfsSync(process.cwd());
const diskGb = (stat.bavail * stat.bsize) / 1024 ** 3;
const node = Number(process.versions.node.split(".")[0]);

if (cpus < need.cpus) problems.push(`CPUs: ${cpus} (need ${need.cpus})`);
if (memGb < need.memGb) problems.push(`Memory: ${memGb.toFixed(1)} GB (need ${need.memGb})`);
if (diskGb < need.diskGb) problems.push(`Free disk: ${diskGb.toFixed(1)} GB (need ${need.diskGb})`);
if (node < need.node) problems.push(`Node: ${process.versions.node} (need ${need.node}+)`);

try {
  execFileSync("docker", ["info"], { stdio: "ignore" });
  execFileSync("docker", ["run", "--rm", "hello-world"], { stdio: "ignore" });
} catch {
  problems.push("Docker: cannot start a container (is Docker running?)");
}

console.log(`CPUs ${cpus} | memory ${memGb.toFixed(1)} GB | free disk ${diskGb.toFixed(1)} GB | node ${process.versions.node}`);
if (problems.length > 0) {
  console.error("PREFLIGHT FAILED:\n- " + problems.join("\n- "));
  process.exit(1);
}
console.log("PREFLIGHT OK");
