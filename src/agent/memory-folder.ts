import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { isGlobalFile } from "../memory-index.js";
import { containerName } from "./container.js";

const run = promisify(execFile);

/** Where Claude Code keeps the auto memory of a session that starts in this directory. */
export function memoryDir(cwd: string): string {
  return `/home/clot/.claude/projects/${cwd.replace(/[^a-zA-Z0-9]/g, "-")}/memory`;
}

/** The global memories in one Clot's memory folder, and its index. */
export interface FolderState {
  /** File name to text, for every global memory in the folder. */
  files: Map<string, string>;
  /** `MEMORY.md`, or null when there is none. */
  index: string | null;
}

/** Files to write and remove in one Clot's memory folder, and its new index when that changes. */
export interface FolderChange {
  put: Record<string, string>;
  remove: string[];
  index?: string;
}

export interface MemoryFolders {
  /** Reads a Clot's global memories and index. Undefined when the folder does not exist; throws when it cannot be read. */
  read(clot: string): Promise<FolderState | undefined>;
  /** Writes, removes and re-indexes in one step, creating the folder when needed. Throws when it fails. */
  write(clot: string, change: FolderChange): Promise<void>;
}

/**
 * Prints the folder as lines: `F <name> <base64>` for each global memory, `I - <base64>` for the index.
 * Fails when the folder or a file in it cannot be read: an unlisted file would look deleted.
 */
export const READ_SCRIPT = `d="$1"
[ -d "$d" ] || { echo MISSING; exit 0; }
cd "$d" && [ -r . ] || exit 1
for f in global-clot-*.md; do
  [ -f "$f" ] || continue
  b=$(base64 -w0 < "$f") || exit 1
  echo "F $f $b"
done
if [ -f MEMORY.md ]; then b=$(base64 -w0 < MEMORY.md) || exit 1; echo "I - $b"; fi
exit 0`;

/** Reads lines from stdin: `P <name> <base64>` writes a file, `R <name> -` removes one, `I - <base64>` writes the index. */
export const WRITE_SCRIPT = `set -e
d="$1"
mkdir -p "$d"
while read -r op name data; do
  case "$op" in
    P) printf '%s' "$data" | base64 -d > "$d/.$name.tmp"; mv "$d/.$name.tmp" "$d/$name" ;;
    R) rm -f "$d/$name" ;;
    I) printf '%s' "$data" | base64 -d > "$d/.MEMORY.md.tmp"; mv "$d/.MEMORY.md.tmp" "$d/MEMORY.md" ;;
  esac
done`;

const decode = (data: string | undefined) => Buffer.from(data ?? "", "base64").toString("utf8");
const encode = (text: string) => Buffer.from(text, "utf8").toString("base64");

/** Reads what READ_SCRIPT printed. A file whose name is not a global memory's is left out. */
export function parseRead(out: string): FolderState | undefined {
  const lines = out.split("\n").filter((line) => line !== "");
  if (lines[0] === "MISSING") return undefined;
  const state: FolderState = { files: new Map(), index: null };
  for (const line of lines) {
    const [op, name, data] = line.split(" ");
    if (op === "F" && isGlobalFile(name)) state.files.set(name, decode(data));
    if (op === "I") state.index = decode(data);
  }
  return state;
}

/** The input for WRITE_SCRIPT. Refuses a name that is not a global memory's, so nothing else in the folder can be touched. */
export function encodeChange(change: FolderChange): string {
  const lines: string[] = [];
  for (const [name, text] of Object.entries(change.put)) {
    if (!isGlobalFile(name)) throw new Error(`not a global memory: ${name}`);
    lines.push(`P ${name} ${encode(text)}`);
  }
  for (const name of change.remove) {
    if (!isGlobalFile(name)) throw new Error(`not a global memory: ${name}`);
    lines.push(`R ${name} -`);
  }
  if (change.index !== undefined) lines.push(`I - ${encode(change.index)}`);
  return lines.map((line) => `${line}\n`).join("");
}

/** Runs a command with text on its stdin. Rejects when it exits with anything but 0. */
function runWithInput(args: string[], input: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, { stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    child.on("error", reject);
    // Docker exiting while the input is still being written breaks the pipe: the write fails, the daemon carries on.
    child.stdin.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`docker exited with ${code}: ${stderr.trim()}`))));
    child.stdin.end(input);
  });
}

/** Each Clot's memory folder, in its container, through `docker exec` as the container's own user. */
export class DockerMemoryFolders implements MemoryFolders {
  /** cwdOf gives the directory a Clot's turns start in, which names its memory folder. */
  constructor(private cwdOf: (clot: string) => string) {}

  async read(clot: string): Promise<FolderState | undefined> {
    const { stdout } = await run("docker", ["exec", containerName(clot), "sh", "-c", READ_SCRIPT, "sh", memoryDir(this.cwdOf(clot))], { maxBuffer: 64 * 1024 * 1024 });
    return parseRead(stdout);
  }

  async write(clot: string, change: FolderChange): Promise<void> {
    await runWithInput(["exec", "-i", containerName(clot), "sh", "-c", WRITE_SCRIPT, "sh", memoryDir(this.cwdOf(clot))], encodeChange(change));
  }
}
