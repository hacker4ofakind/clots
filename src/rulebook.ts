import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import type { ClotEvent } from "./events/types.js";

const PrefilterSchema = z
  .strictObject({
    kind: z.enum(["issue_opened", "comment", "review", "pr_opened", "ci_failed"]).optional(),
    actor: z.string().min(1).optional(),
    titleContains: z.string().min(1).optional(),
  })
  .refine((rule) => Object.keys(rule).length > 0, "a pre-filter must name at least one of kind, actor and titleContains");

const RuleFileSchema = z.strictObject({
  prefilters: z.array(PrefilterSchema).default([]),
  triage: z.string().default(""),
});

export type Prefilter = z.infer<typeof PrefilterSchema>;
export type RuleFile = z.infer<typeof RuleFileSchema>;

const EMPTY: RuleFile = { prefilters: [], triage: "" };

/** Reads one rule file. Throws when it is not YAML or does not fit the schema. An empty file is an empty rule file. */
export function parseRuleFile(text: string): RuleFile {
  return RuleFileSchema.parse(parse(text) ?? {});
}

/** A rule drops an event when every field it names matches. */
export function matchesPrefilter(rule: Prefilter, event: ClotEvent): boolean {
  if (rule.kind !== undefined && rule.kind !== event.kind) return false;
  if (rule.actor !== undefined && rule.actor.toLowerCase() !== event.actor.toLowerCase()) return false;
  if (rule.titleContains !== undefined && !event.title.toLowerCase().includes(rule.titleContains.toLowerCase())) return false;
  return true;
}

const STARTER = [
  "# Rules for {scope}. Edit by hand; the daemon picks up changes when the file is saved.",
  "#",
  "# prefilters: events that match a rule are dropped before anything else looks at them.",
  "# A rule matches when every field it names matches. Fields: kind, actor, titleContains.",
  "# Kinds: issue_opened, comment, review, pr_opened, ci_failed.",
  "#",
  "# prefilters:",
  "#   - actor: dependabot[bot]",
  "#   - kind: comment",
  '#     titleContains: "[bot]"',
  "prefilters: []",
  "",
  "# triage: plain-language guidance for deciding whether an event needs action.",
  'triage: ""',
  "",
].join("\n");

/**
 * The rule files: global.yaml for every Clot and <clot>.yaml for one.
 * Read-only: the files are edited by hand.
 */
export class Rulebook {
  private files = new Map<string, RuleFile>();
  private reported = new Map<string, string>();

  constructor(
    private dir: string,
    private clots: string[],
    private onInvalid: (file: string, problem: string) => void,
  ) {}

  /** Creates the folder, its own git repository and the starter files, whichever are missing. */
  ensure(): void {
    fs.mkdirSync(this.dir, { recursive: true });
    if (!fs.existsSync(path.join(this.dir, ".git"))) {
      try {
        execFileSync("git", ["init", "-q", this.dir], { stdio: "ignore" });
      } catch {
        // The rulebook works without version control; the user can run git init later.
      }
    }
    for (const name of this.names()) {
      const file = this.fileOf(name);
      if (!fs.existsSync(file)) fs.writeFileSync(file, STARTER.replace("{scope}", name === "global" ? "every Clot" : `the ${name} Clot`));
    }
  }

  /** Reads every rule file. A file that cannot be used leaves its last good version in force and is reported once. */
  load(): void {
    for (const name of this.names()) {
      const file = this.fileOf(name);
      try {
        this.files.set(name, fs.existsSync(file) ? parseRuleFile(fs.readFileSync(file, "utf8")) : EMPTY);
        this.reported.delete(name);
      } catch (error) {
        const problem = error instanceof Error ? error.message : String(error);
        if (this.reported.get(name) !== problem) {
          this.reported.set(name, problem);
          this.onInvalid(`${name}.yaml`, problem);
        }
      }
    }
  }

  /** Reloads when a file in the folder changes. Returns a function that stops watching. */
  watch(): () => void {
    let timer: NodeJS.Timeout | undefined;
    const watcher = fs.watch(this.dir, () => {
      clearTimeout(timer);
      timer = setTimeout(() => this.load(), 200);
    });
    return () => {
      clearTimeout(timer);
      watcher.close();
    };
  }

  isDropped(clot: string, event: ClotEvent): boolean {
    return this.rulesFor(clot).some((file) => file.prefilters.some((rule) => matchesPrefilter(rule, event)));
  }

  /** The triage guidance that applies to a Clot: the global text, then its own. */
  guidance(clot: string): string {
    return this.rulesFor(clot)
      .map((file) => file.triage.trim())
      .filter((text) => text !== "")
      .join("\n\n");
  }

  private names(): string[] {
    return ["global", ...this.clots];
  }

  private fileOf(name: string): string {
    return path.join(this.dir, `${name}.yaml`);
  }

  private rulesFor(clot: string): RuleFile[] {
    return [this.files.get("global") ?? EMPTY, this.files.get(clot) ?? EMPTY];
  }
}
