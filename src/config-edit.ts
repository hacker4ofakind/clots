import fs from "node:fs";
import { CONFIG_KEYS, loadConfigLeaving } from "./config.js";

/** Keys a Clot may never change: who the daemon is, where it is reached, and which bot and server it runs on. */
export const BLOCKED_KEYS = ["home", "publicUrl", "discord", "image"];

/** Plain tunables that reach no one and name no secret: a change to one applies at once. Any other key is put to the user first. */
export const SAFE_KEYS = ["timeZone", "hold", "rolloverPercent", "maxProposals", "maxWorkers", "choiceTimeoutMinutes", "gates", "sweep", "spend"];

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const clone = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));

/** `sources.composio` as ["sources", "composio"]; a key of one or two parts, the first a key of the file. */
export function parseKey(key: string): string[] | string {
  const path = key.split(".");
  if (path.length > 2 || path.some((p) => p === "")) return "A key is a top-level key of the file, or one inside it, such as sources.composio or mcpServers.elevenlabs.";
  if (!CONFIG_KEYS.includes(path[0]!)) return `There is no key ${path[0]}. The keys are: ${CONFIG_KEYS.filter((k) => !BLOCKED_KEYS.includes(k)).join(", ")}.`;
  if (BLOCKED_KEYS.includes(path[0]!)) return `${path[0]} cannot be changed by a Clot. The user edits it themselves.`;
  return path;
}

export const needsAsk = (path: string[]): boolean => !SAFE_KEYS.includes(path[0]!);

export function getAt(json: Json, path: string[]): unknown {
  let at: unknown = json;
  for (const part of path) {
    if (!isObject(at)) return undefined;
    at = at[part];
  }
  return at;
}

function setAt(json: Json, path: string[], value: unknown): Json {
  const out = clone(json);
  if (path.length === 1) out[path[0]!] = value;
  else {
    const inner = isObject(out[path[0]!]) ? (out[path[0]!] as Json) : {};
    inner[path[1]!] = value;
    out[path[0]!] = inner;
  }
  return out;
}

/** A stdio MCP server runs a command on the machine itself: the tool may add or change remote (http) servers only. */
function mcpProblem(current: Json, candidate: Json): string | undefined {
  const before = isObject(current.mcpServers) ? current.mcpServers : {};
  const after = isObject(candidate.mcpServers) ? candidate.mcpServers : {};
  for (const [name, server] of Object.entries(after)) {
    if (isObject(server) && "command" in server && JSON.stringify(server) !== JSON.stringify(before[name])) return `the MCP server ${name} runs a command on the machine. A Clot may set only remote (url) servers; the user adds this one by hand.`;
  }
  return undefined;
}

/** `.env` is not read here: a key the change names that is not set yet is not a problem, it is a thing for the user to add. */
const lenientEnv = (): Record<string, string | undefined> => new Proxy(process.env, { get: (target, key) => (typeof key === "string" ? (target[key] || "placeholder") : undefined) });

const entryName = (s: { entry: string }) => s.entry;

/** What a change would break that was not already broken, by the daemon's own loader. */
function loaderProblem(current: Json, candidate: Json): string | undefined {
  try {
    const before = new Set(loadConfigLeaving(current, lenientEnv()).skipped.map(entryName));
    const after = loadConfigLeaving(candidate, lenientEnv()).skipped.filter((s) => !before.has(s.entry));
    if (after.length > 0) return after.map((s) => `${s.entry}: ${s.problem}`).join("; ");
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export interface Checked {
  path: string[];
  candidate: Json;
}

/** The whole file as it would be with `value` at `key`, or why it may not be. */
export function check(current: Json, key: string, value: unknown): Checked | string {
  const path = parseKey(key);
  if (typeof path === "string") return path;
  const candidate = setAt(current, path, value);
  const problem = mcpProblem(current, candidate) ?? loaderProblem(current, candidate);
  return problem === undefined ? { path, candidate } : `Not changed: ${problem}`;
}

/** The `.env` keys the configuration names that nothing sets yet, from the entries the loader would leave out for that. */
export function missingEnvKeys(candidate: Json, env: Record<string, string | undefined> = process.env): string[] {
  try {
    const found = loadConfigLeaving(candidate, env).skipped.flatMap((s) => [...s.problem.matchAll(/\b([A-Z][A-Z0-9_]*) is not set in \.env/g)].map((m) => m[1]!));
    return [...new Set(found)];
  } catch {
    return [];
  }
}

export interface Applied {
  ok: boolean;
  text: string;
}

/**
 * Sets one key in the file. The file is read again here, so a change made since the user was asked is not lost;
 * the old file is kept beside it as `.bak`, and the new one is written whole and moved into place.
 */
export function applyChange(file: string, key: string, value: unknown): Applied {
  let current: Json;
  try {
    current = JSON.parse(fs.readFileSync(file, "utf8")) as Json;
  } catch (error) {
    return { ok: false, text: `Not changed: the configuration could not be read (${error instanceof Error ? error.message : String(error)}).` };
  }
  const checked = check(current, key, value);
  if (typeof checked === "string") return { ok: false, text: checked };
  fs.copyFileSync(file, `${file}.bak`);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(checked.candidate, null, 2)}\n`);
  fs.renameSync(tmp, file);
  const missing = missingEnvKeys(checked.candidate);
  const env = missing.length === 0 ? "" : ` The user still has to add ${missing.map((k) => `\`${k}\``).join(", ")} to the \`.env\` file in the daemon's folder (${process.cwd()}) before the entry can load.`;
  return { ok: true, text: `Saved ${key}. It takes effect when the daemon restarts.${env}` };
}
