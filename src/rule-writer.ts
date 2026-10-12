import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { applyEdit, EditRefused, type EditResult, type RuleEdit, type RuleScope } from "./rulebook-edit.js";
import type { Store } from "./store.js";

/** What became of an edit. `file` is "global" or the name of a Clot. */
export type WriteResult = { ok: true; file: string; summary: string } | { ok: false; reason: string };

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
    return "reason" in result ? { ok: false, reason: result.reason } : { ok: true, file: target, summary: result.summary };
  }

  /** Makes an edit: checked, written, put in force, committed, and logged with the edit that undoes it. */
  apply(clot: string, scope: RuleScope, edit: RuleEdit): WriteResult {
    return this.write(clot, scope === "global" ? "global" : clot, edit, true);
  }

  /** Reverts the most recent edit made from chat through this Clot that has not been undone. */
  undo(clot: string): WriteResult {
    const last = this.d.store.lastRuleEdit(clot);
    if (!last) return { ok: false, reason: "There is no edit made from chat left to undo." };
    // Marked first: an edit that can no longer be undone is skipped by the next undo instead of standing in its way.
    this.d.store.markRuleEditUndone(last.id);
    const done = this.write(clot, last.file, JSON.parse(last.inverse) as RuleEdit, false);
    const what = last.summary.split("\n")[0];
    if (!done.ok) return { ok: false, reason: `"${what}" could not be undone: ${done.reason}. Nothing was changed.` };
    // The command never reaches the Clot, which may still be acting on what it was told when the rule was made.
    this.d.store.addNote(clot, `The user undid this rule change, and it is no longer in force: ${what}. Whatever the user said when asking for it no longer applies either.`);
    return { ok: true, file: done.file, summary: `Undid: ${what}` };
  }

  private compute(target: string, edit: RuleEdit): EditResult | { reason: string } {
    const file = this.d.rulebook.pathOf(target);
    try {
      return applyEdit(fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "", edit);
    } catch (error) {
      if (error instanceof EditRefused) return { reason: error.message };
      throw error;
    }
  }

  private write(clot: string, target: string, edit: RuleEdit, log: boolean): WriteResult {
    const result = this.compute(target, edit);
    if ("reason" in result) return { ok: false, reason: result.reason };
    const file = this.d.rulebook.pathOf(target);
    // Written beside the file and moved over it, so the file is never seen half written.
    const temp = `${file}.tmp`;
    fs.writeFileSync(temp, result.text);
    fs.renameSync(temp, file);
    this.d.rulebook.load();
    try {
      (this.d.commit ?? gitCommit)(file, `${clot}: ${result.summary.split("\n")[0]}`);
    } catch (error) {
      console.error(`[rulebook] ${target}.yaml was changed but could not be committed:`, error);
    }
    if (log) this.d.store.logRuleEdit({ clot, file: target, inverse: JSON.stringify(result.inverse), summary: result.summary });
    return { ok: true, file: target, summary: result.summary };
  }
}
