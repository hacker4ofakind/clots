import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ZodError } from "zod";
import { loadConfigLeaving, type Config, type SkippedAccount } from "./config.js";
import { readEnvFile, removeEnvKey, setEnvKey } from "./env-file.js";
import type { LiveEnv } from "./live-env.js";

/** Keys the daemon reads once at startup: a change is saved and reported, and takes effect at the next restart. */
export const RESTART_KEYS = ["intake", "image", "ui"];

/** `.env` keys the UI never writes or removes: the daemon's own secrets and the push keys. */
export const PROTECTED_ENV_KEYS = ["CLOTS_UI_SECRET", "VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "CLOT_GITHUB_TOKEN", "GITHUB_WEBHOOK_SECRET", "COMPOSIO_API_KEY"];

export const ENV_KEY_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;

type Json = Record<string, unknown>;
type Apply = (next: Config, prev: Config) => void | Promise<void>;

export type SaveResult = { ok: true; applied: string[]; needsRestart: string[] } | { ok: false; errors: Record<string, string> };

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Owns `clots.config.json` and `.env`. It validates every change with the existing schema, writes atomically (a temp file, then
 * a rename) and keeps the previous file as a backup. It watches the directory (an atomic rename replaces the file's inode, so
 * watching the file itself loses it), ignores its own writes by comparing content, and applies a hand edit as it applies one from
 * the UI: an invalid file is ignored, the last good configuration stays in force, and the error is reported.
 */
export class ConfigStore {
  private raw: Json;
  private config: Config;
  skipped: SkippedAccount[];
  private handlers: { keys: string[]; apply: Apply }[] = [];
  private lastWritten: string;
  private timer?: NodeJS.Timeout;
  private watcher?: fs.FSWatcher;
  /** The error of the file as it stands now, or undefined while it is good. */
  error: string | undefined;

  constructor(
    private d: {
      file: string;
      envFile: string;
      env: LiveEnv;
      /** Told after every change that was applied, with the keys, and whether it came from the file. */
      onChanged?: (e: { keys: string[]; needsRestart: string[]; fromFile: boolean; error?: string }) => void;
      log?: (text: string) => void;
    },
  ) {
    const text = fs.readFileSync(d.file, "utf8");
    this.lastWritten = hash(text);
    this.envSnapshot = readEnvFile(d.envFile);
    this.raw = JSON.parse(text) as Json;
    const loaded = loadConfigLeaving(this.raw, d.env.all());
    this.config = loaded.config;
    this.skipped = loaded.skipped;
  }

  /** The configuration in force. */
  get current(): Config {
    return this.config;
  }

  /** The file as JSON, for the settings pages and the Clots' config tools. */
  json(): Json {
    return JSON.parse(JSON.stringify(this.raw)) as Json;
  }

  /** Registers what applies a change to some top-level keys, live. */
  onChange(keys: string[], apply: Apply): void {
    this.handlers.push({ keys, apply });
  }

  /** Starts watching the directory. */
  watch(): void {
    const dir = path.dirname(path.resolve(this.d.file));
    const names = new Set([path.basename(this.d.file), path.basename(this.d.envFile)]);
    this.watcher = fs.watch(dir, (_event, name) => {
      if (name === null || !names.has(String(name))) return;
      clearTimeout(this.timer);
      this.timer = setTimeout(() => void this.reload(), 300);
    });
    this.watcher.on("error", () => undefined);
  }

  close(): void {
    clearTimeout(this.timer);
    this.watcher?.close();
  }

  /** Reads both files again, as after a hand edit. A file that does not load changes nothing. */
  async reload(): Promise<void> {
    let text: string;
    try {
      text = fs.readFileSync(this.d.file, "utf8");
    } catch {
      return;
    }
    const envChanged = JSON.stringify(readEnvFile(this.d.envFile)) !== JSON.stringify(this.envSnapshot);
    if (hash(text) === this.lastWritten && !envChanged) return;
    this.d.env.reload();
    this.envSnapshot = readEnvFile(this.d.envFile);
    try {
      const raw = JSON.parse(text) as Json;
      const loaded = loadConfigLeaving(raw, this.d.env.all());
      this.error = undefined;
      this.lastWritten = hash(text);
      await this.adopt(raw, loaded.config, loaded.skipped, true);
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
      this.d.log?.(`[config] clots.config.json was not picked up, and the last good configuration stays in force: ${this.error}`);
      this.d.onChanged?.({ keys: [], needsRestart: [], fromFile: true, error: this.error });
    }
  }
  private envSnapshot: Record<string, string> = {};

  private async adopt(raw: Json, next: Config, skipped: SkippedAccount[], fromFile: boolean): Promise<{ applied: string[]; needsRestart: string[] }> {
    const prevRaw = this.raw;
    const prev = this.config;
    this.raw = raw;
    this.config = next;
    this.skipped = skipped;
    const changed = [...new Set([...Object.keys(prevRaw), ...Object.keys(raw)])].filter((key) => !same(prevRaw[key], raw[key]));
    const needsRestart = changed.filter((key) => RESTART_KEYS.includes(key));
    const applied: string[] = [];
    for (const key of changed.filter((k) => !RESTART_KEYS.includes(k))) {
      const handlers = this.handlers.filter((h) => h.keys.includes(key));
      if (handlers.length === 0) {
        needsRestart.push(key);
        continue;
      }
      for (const handler of handlers) await handler.apply(next, prev);
      applied.push(key);
    }
    this.d.onChanged?.({ keys: changed, needsRestart, fromFile });
    return { applied, needsRestart };
  }

  /**
   * Changes top-level keys of the file. The result is validated as a whole first; nothing is written when it does not load.
   * Written atomically with the old file kept as `.bak`. Returns what applied at once and what waits for a restart.
   */
  async save(patch: Json): Promise<SaveResult> {
    const candidate: Json = { ...this.raw, ...patch };
    for (const [key, value] of Object.entries(patch)) if (value === undefined) delete candidate[key];
    // The old name of the ask timeout goes from the file once it is written again, its value kept under the new name.
    if ("choiceTimeoutMinutes" in candidate) {
      if (!("askTimeoutMinutes" in candidate)) candidate.askTimeoutMinutes = candidate.choiceTimeoutMinutes;
      delete candidate.choiceTimeoutMinutes;
    }
    let loaded: ReturnType<typeof loadConfigLeaving>;
    try {
      loaded = loadConfigLeaving(candidate, this.d.env.all());
    } catch (error) {
      return { ok: false, errors: fieldErrors(error, Object.keys(patch)) };
    }
    const text = `${JSON.stringify(candidate, null, 2)}\n`;
    const temp = `${this.d.file}.tmp`;
    if (fs.existsSync(this.d.file)) fs.copyFileSync(this.d.file, `${this.d.file}.bak`);
    fs.writeFileSync(temp, text);
    fs.renameSync(temp, this.d.file);
    this.lastWritten = hash(text);
    this.error = undefined;
    const result = await this.adopt(candidate, loaded.config, loaded.skipped, false);
    return { ok: true, ...result };
  }

  // ---- .env keys. Values are never read back, only their last four characters.

  /** The names in `.env` with their last four characters, protected ones left out. */
  keys(): { name: string; last4: string; protected: boolean }[] {
    const env = readEnvFile(this.d.envFile);
    return Object.entries(env).map(([name, value]) => ({ name, last4: value.slice(-4), protected: PROTECTED_ENV_KEYS.includes(name) }));
  }

  /** The places in the configuration that name a key, for refusing to remove one in use. */
  usersOf(name: string): string[] {
    const found: string[] = [];
    const walk = (value: unknown, where: string) => {
      if (value === name) found.push(where);
      else if (Array.isArray(value)) value.forEach((v, i) => walk(v, `${where}[${i}]`));
      else if (typeof value === "object" && value !== null) for (const [k, v] of Object.entries(value)) walk(v, `${where}.${k}`);
    };
    walk(this.raw, "");
    return found.map((w) => w.replace(/^\./, ""));
  }

  setKey(name: string, value: string): { ok: true } | { ok: false; error: string } {
    if (!ENV_KEY_NAME.test(name)) return { ok: false, error: "A key name is capital letters, digits and underscores, starting with a letter." };
    if (PROTECTED_ENV_KEYS.includes(name)) return { ok: false, error: `${name} is the daemon's own and cannot be changed here.` };
    if (/[\r\n]/.test(value)) return { ok: false, error: "A value cannot contain a line break." };
    if (value === "") return { ok: false, error: "A value is needed." };
    setEnvKey(this.d.envFile, name, value);
    this.d.env.reload();
    this.envSnapshot = readEnvFile(this.d.envFile);
    return { ok: true };
  }

  removeKey(name: string): { ok: true } | { ok: false; error: string } {
    if (PROTECTED_ENV_KEYS.includes(name)) return { ok: false, error: `${name} is the daemon's own and cannot be removed here.` };
    const users = this.usersOf(name);
    if (users.length > 0) return { ok: false, error: `${name} is used by ${users.join(", ")} in the configuration. Remove that first.` };
    removeEnvKey(this.d.envFile, name);
    this.d.env.reload();
    this.envSnapshot = readEnvFile(this.d.envFile);
    return { ok: true };
  }
}

/** What went wrong with a patch, by the key it touched where that can be told. */
function fieldErrors(error: unknown, keys: string[]): Record<string, string> {
  if (error instanceof ZodError) {
    const out: Record<string, string> = {};
    for (const issue of error.issues) out[String(issue.path[0] ?? keys[0] ?? "config")] ??= issue.message;
    return out;
  }
  const text = error instanceof Error ? error.message : String(error);
  const named = keys.find((k) => text.includes(k));
  return { [named ?? keys[0] ?? "config"]: text.split("\n")[0]!.slice(0, 300) };
}
