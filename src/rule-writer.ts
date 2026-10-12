import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { applyEdit, EditRefused, type EditResult, type RuleEdit, type RuleScope } from "./rulebook-edit.js";
import type { Store } from "./store.js";

/**
 * What became of an edit. `file` is "global" or the name of a Clot. An edit that was not made
 * left the file as it was; `retry` says the cause was the disk and not the edit, so the same
 * edit may go through later.
 */
export type WriteResult = { ok: true; file: string; summary: string } | { ok: false; reason: string; retry?: true };

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Commits one rule file in the rulebook's own repository, under a name of the daemon's. */
export function gitCommit(file: string, message: string): void {
  const dir = path.dirname(file);
  const name = path.basename(file);
  const git = (...args: string[]) => execFileSync("git", ["-C", dir, "-c", "user.name=clots", "-c", "user.email=clots@clots.invalid", ...args], { stdio: "ignore" });
  git("add", "--", name);
  git("commit", "-q", "-m", message, "--", name);
}

export interface RuleWriterDeps {
  rulebook: { pathOf(name: string): string; load(): void };
  store: Store;
  /** Commits a rule file. Left out, it is a git commit in the file's folder. */
  commit?: (file: string, message: string) => void;
}

/**
 * Makes edits to the rule files. Nothing here waits for anything, so edits are made one at a
 * time whichever Clots they come from.
 */
export class RuleWriter {
  constructor(private d: RuleWriterDeps) {}

  /** What an edit would do, without doing it. */
  preview(clot: string, scope: RuleScope, edit: RuleEdit): WriteResult {
    const target = scope === "global" ? "global" : clot;
    const result = this.compute(target, edit);
    return "reason" in result ? result : { ok: true, file: target, summary: result.summary };
  }

  /** Makes an edit: checked, written, put in force, committed, and logged with the edit that undoes it. */
  apply(clot: string, scope: RuleScope, edit: RuleEdit): WriteResult {
    return this.write(clot, scope === "global" ? "global" : clot, edit, true);
  }

  /** Reverts the most recent edit made from chat through this Clot that has not been undone. */
  undo(clot: string): WriteResult {
    const last = this.d.store.lastRuleEdit(clot);
    if (!last) return { ok: false, reason: "There is no edit made from chat left to undo." };
    const done = this.write(clot, last.file, JSON.parse(last.inverse) as RuleEdit, false);
    const what = last.summary.split("\n")[0];
    // The disk failed, not the edit: it stays the next one to undo.
    if (!done.ok && done.retry) return { ok: false, reason: `"${what}" could not be undone just now: ${done.reason}. Nothing was changed; send the command again.`, retry: true };
    // Marked when it was undone, and also when it no longer can be: that edit is then skipped by the next undo instead of standing in its way.
    this.d.store.markRuleEditUndone(last.id);
    if (!done.ok) return { ok: false, reason: `"${what}" could not be undone: ${done.reason}. Nothing was changed.` };
    // The command never reaches the Clot, which may still be acting on what it was told when the rule was made.
    this.d.store.addNote(clot, `The user undid this rule change, and it is no longer in force: ${what}. Whatever the user said when asking for it no longer applies either.`);
    return { ok: true, file: done.file, summary: `Undid: ${what}` };
  }

  private compute(target: string, edit: RuleEdit): EditResult | (WriteResult & { ok: false }) {
    const file = this.d.rulebook.pathOf(target);
    try {
      return applyEdit(fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "", edit);
    } catch (error) {
      if (error instanceof EditRefused) return { ok: false, reason: error.message };
      return { ok: false, reason: `the file could not be read (${message(error)})`, retry: true };
    }
  }

  /** Never throws. Up to the move that replaces the file, a failure leaves it untouched; after it, the edit stands whatever else fails. */
  private write(clot: string, target: string, edit: RuleEdit, log: boolean): WriteResult {
    const result = this.compute(target, edit);
    if ("reason" in result) return result;
    const file = this.d.rulebook.pathOf(target);
    // Written beside the file and moved over it, so the file is never seen half written.
    const temp = `${file}.tmp`;
    try {
      fs.writeFileSync(temp, result.text);
      fs.renameSync(temp, file);
    } catch (error) {
      try {
        fs.rmSync(temp, { force: true });
      } catch {
        // Whatever is in the way stays; the next write reports it again.
      }
      return { ok: false, reason: `the file could not be written (${message(error)})`, retry: true };
    }
    try {
      this.d.rulebook.load();
      (this.d.commit ?? gitCommit)(file, `${clot}: ${result.summary.split("\n")[0]}`);
    } catch (error) {
      console.error(`[rulebook] ${target}.yaml was changed but could not be committed:`, error);
    }
    try {
      if (log) this.d.store.logRuleEdit({ clot, file: target, inverse: JSON.stringify(result.inverse), summary: result.summary });
    } catch (error) {
      console.error(`[rulebook] the change to ${target}.yaml stands but could not be logged, so it cannot be undone from chat:`, error);
    }
    return { ok: true, file: target, summary: result.summary };
  }
}
