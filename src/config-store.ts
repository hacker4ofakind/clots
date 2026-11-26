import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { readableIssue, readableText } from "@clots/ui-api-schemas";
import { ZodError } from "zod";
import { loadConfigLeaving, migrateLegacy, type Config, type SkippedAccount } from "./config.js";
import { readEnvFile, removeEnvKey, setEnvKey } from "./env-file.js";
import type { LiveEnv } from "./live-env.js";

/** Keys the daemon reads once at startup: a change is saved and reported, and takes effect at the next restart. */
export const RESTART_KEYS = ["intake", "image", "ui"];

/** `.env` keys the UI never writes or removes: the daemon's own secrets and the push keys. */
export const PROTECTED_ENV_KEYS = ["CLOTS_UI_SECRET", "VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "CLOT_GITHUB_TOKEN", "GITHUB_WEBHOOK_SECRET", "COMPOSIO_API_KEY"];

export const ENV_KEY_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;

type Json = Record<string, unknown>;
/** What an apply handler may answer: that part of the change still needs a restart (a handler cannot tell the store which part). */
export type Applied = void | { restart: boolean };
type Apply = (next: Config, prev: Config) => Applied | Promise<Applied>;

export type SaveResult = { ok: true; applied: string[]; needsRestart: string[] } | { ok: false; errors: Record<string, string> };

/** Keys whose values include what `.env` holds (a password, a token): a key written there changes them with the file as it is. */
const RESOLVED: Record<string, (c: Config) => unknown> = { sources: (c) => c.sources, mcpServers: (c) => c.mcpServers };

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
      /** Told with the new configuration the moment it is in force, before any apply handler runs: what reads the configuration at call time sees it from then on. */
      onAdopt?: (next: Config) => void;
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

  /**
   * Reads the configuration again with the `.env` as it is now, and applies what that changed: an entry that was left out for a key
   * that was not there yet loads, an account whose password changed reconnects. Nothing is written.
   */
  reapply(): Promise<void> {
    return this.serial(() => this.doReapply());
  }

  private async doReapply(): Promise<void> {
    this.d.env.reload();
    this.envSnapshot = readEnvFile(this.d.envFile);
    try {
      const loaded = loadConfigLeaving(this.raw, this.d.env.all());
      await this.adopt(this.raw, loaded.config, loaded.skipped, false);
    } catch (error) {
      this.d.log?.(`[config] the configuration could not be read again after a key changed: ${error instanceof Error ? error.message : String(error)}`);
    }
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
  reload(): Promise<void> {
    return this.serial(() => this.doReload());
  }

  private async doReload(): Promise<void> {
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

  /**
   * Saves, reloads and re-reads run one at a time, each through its apply handlers: a second one that began while the first waited on a
   * handler (a mailbox stopping, say) would otherwise be applied first, and the first would then start what the file no longer holds.
   */
  private queue: Promise<unknown> = Promise.resolve();
  private serial<T>(job: () => Promise<T>): Promise<T> {
    const run = this.queue.then(job, job);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async adopt(raw: Json, next: Config, skipped: SkippedAccount[], fromFile: boolean): Promise<{ applied: string[]; needsRestart: string[] }> {
    const prevRaw = this.raw;
    const prev = this.config;
    this.raw = raw;
    this.config = next;
    this.skipped = skipped;
    this.d.onAdopt?.(next);
    // A key under its old name counts as the key under its new name (a rename is not a change, and the old key leaving the file is not one).
    const before = migrateLegacy(prevRaw) as Json;
    const after = migrateLegacy(raw) as Json;
    const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((key) => !same(before[key], after[key]) || (RESOLVED[key] !== undefined && !same(RESOLVED[key]!(prev), RESOLVED[key]!(next))));
    const needsRestart = changed.filter((key) => RESTART_KEYS.includes(key));
    const applied: string[] = [];
    for (const key of changed.filter((k) => !RESTART_KEYS.includes(k))) {
      const handlers = this.handlers.filter((h) => h.keys.includes(key));
      if (handlers.length === 0) {
        needsRestart.push(key);
        continue;
      }
      let restart = false;
      for (const handler of handlers) {
        // A handler that fails leaves its key in the file and in force as configuration, but not applied: it is reported as waiting for a restart.
        try {
          const answer = await handler.apply(next, prev);
          if (answer && answer.restart) restart = true;
        } catch (error) {
          this.d.log?.(`[config] applying ${key} live failed; it takes effect at the next restart: ${error instanceof Error ? error.message : String(error)}`);
          restart = true;
        }
      }
      // A key that still needs a restart is reported as one, not as applied.
      (restart ? needsRestart : applied).push(key);
    }
    this.d.onChanged?.({ keys: changed, needsRestart, fromFile });
    return { applied, needsRestart };
  }

  /**
   * Changes top-level keys of the file. The result is validated as a whole first; nothing is written when it does not load.
   * Written atomically with the old file kept as `.bak`. Returns what applied at once and what waits for a restart.
   */
  save(patch: Json): Promise<SaveResult> {
    return this.serial(() => this.doSave(patch));
  }

  /**
   * A change built from the file as it stands when its turn in the queue comes: `plan` reads the current configuration, may write
   * `.env` keys, and answers the patch (with what undoes those key writes) or a refusal. The read, the key writes, the save and the
   * undo of a refused save all happen in one turn, so a change queued behind it is planned against what this one saved, and cannot
   * be rolled back over by it. `plan` may throw: that ends the turn with nothing saved.
   */
  update<R>(plan: (raw: Json) => { patch: Json; undo?: () => void } | { refuse: R }): Promise<{ saved: SaveResult } | { refused: R }> {
    return this.serial(async () => {
      const planned = plan(this.json());
      if ("refuse" in planned) return { refused: planned.refuse };
      let saved: SaveResult;
      try {
        saved = await this.doSave(planned.patch);
      } catch (error) {
        planned.undo?.();
        throw error;
      }
      if (!saved.ok) planned.undo?.();
      return { saved };
    });
  }

  private async doSave(patch: Json): Promise<SaveResult> {
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

  /** What puts a key back as it is now (its value, or its absence) when a change that wrote it is refused. */
  keyUndo(name: string): () => void {
    const before = readEnvFile(this.d.envFile)[name];
    return () => {
      if (before === undefined) removeEnvKey(this.d.envFile, name);
      else setEnvKey(this.d.envFile, name, before);
      this.d.env.reload();
      this.envSnapshot = readEnvFile(this.d.envFile);
    };
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
    for (const issue of error.issues) out[String(issue.path[0] ?? keys[0] ?? "config")] ??= readableIssue(issue);
    return out;
  }
  const text = error instanceof Error ? error.message : String(error);
  const named = keys.find((k) => text.includes(k));
  return { [named ?? keys[0] ?? "config"]: readableText(text.split("\n")[0]!.slice(0, 300), "That could not be saved. Check it and try again.") };
}
