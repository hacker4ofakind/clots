import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import type { ClotEvent } from "./events/types.js";

/** The kinds a source produces. A batch is made by the daemon and cannot be named in a rule. */
export const RULE_KINDS = ["issue_opened", "comment", "review", "pr_opened", "ci_failed"] as const;

/** The fields a template may use, each filled from the triggering event. */
export const TEMPLATE_FIELDS = ["actor", "title", "ref", "repo", "url"] as const;
export type TemplateField = (typeof TEMPLATE_FIELDS)[number];

/** The `{field}` names in a template that are not ones it may use. */
function unknownFields(template: string): string[] {
  return [...template.matchAll(/\{([A-Za-z_]+)\}/g)].map((m) => m[1]).filter((name) => !(TEMPLATE_FIELDS as readonly string[]).includes(name));
}

const MATCH_FIELDS = {
  kind: z.enum(RULE_KINDS).optional(),
  actor: z.string().min(1).optional(),
  repo: z.string().min(1).optional(),
  titleContains: z.string().min(1).optional(),
};

const PrefilterSchema = z
  .strictObject(MATCH_FIELDS)
  .refine((rule) => Object.values(rule).some((value) => value !== undefined), "a pre-filter must name at least one of kind, actor, repo and titleContains");

const StandingSchema = z.strictObject({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "a standing rule's name uses lowercase letters, digits and hyphens"),
  trigger: z.strictObject({ ...MATCH_FIELDS, kind: z.enum(RULE_KINDS) }),
  via: z.enum(["github_comment"]),
  template: z
    .string()
    .min(1)
    .max(2000)
    .refine((template) => unknownFields(template).length === 0, "a template may use only the fields {actor}, {title}, {ref}, {repo} and {url}"),
});

const RuleFileSchema = z.strictObject({
  prefilters: z.array(PrefilterSchema).default([]),
  // A list of lines. A single block of text, as stage 2a wrote it, is read as one line.
  triage: z
    .union([z.string(), z.array(z.string().min(1))])
    .transform((value) => (typeof value === "string" ? (value.trim() === "" ? [] : [value.trim()]) : value))
    .default([]),
  standing: z
    .array(StandingSchema)
    .refine((rules) => new Set(rules.map((rule) => rule.name)).size === rules.length, "two standing rules in one file have the same name")
    .default([]),
});

export type Prefilter = z.infer<typeof PrefilterSchema>;
export type StandingRule = z.infer<typeof StandingSchema>;
export type RuleFile = z.infer<typeof RuleFileSchema>;

const EMPTY: RuleFile = { prefilters: [], triage: [], standing: [] };

/** Reads one rule file. Throws when it is not YAML or does not fit the schema. An empty file is an empty rule file. */
export function parseRuleFile(text: string): RuleFile {
  return RuleFileSchema.parse(parse(text) ?? {});
}

/** Checks one pre-filter. Throws when it does not fit. */
export function parsePrefilter(value: unknown): Prefilter {
  return PrefilterSchema.parse(value);
}

/** Checks one standing rule. Throws when it does not fit. */
export function parseStanding(value: unknown): StandingRule {
  return StandingSchema.parse(value);
}

/** What is wrong, in words a person or a Clot can act on. */
export function problemText(error: unknown): string {
  if (error instanceof z.ZodError) return error.issues.map((issue) => (issue.path.length > 0 ? `${issue.path.join(".")}: ${issue.message}` : issue.message)).join("; ");
  return error instanceof Error ? error.message : String(error);
}

/** A rule matches an event when every field it names matches. */
export function matchesPrefilter(rule: Prefilter, event: ClotEvent): boolean {
  if (rule.kind !== undefined && rule.kind !== event.kind) return false;
  if (rule.actor !== undefined && rule.actor.toLowerCase() !== event.actor.toLowerCase()) return false;
  if (rule.repo !== undefined && rule.repo.toLowerCase() !== event.repo.toLowerCase()) return false;
  if (rule.titleContains !== undefined && !event.title.toLowerCase().includes(rule.titleContains.toLowerCase())) return false;
  return true;
}

const STARTER = [
  "# Rules for {scope}. Edit by hand or by asking a Clot; the daemon picks up changes when the file is saved.",
  "#",
  "# prefilters: events that match a rule are dropped before anything else looks at them.",
  "# A rule matches when every field it names matches. Fields: kind, actor, repo, titleContains.",
  "# Kinds: issue_opened, comment, review, pr_opened, ci_failed.",
  "#",
  "# prefilters:",
  "#   - actor: dependabot[bot]",
  "#   - kind: comment",
  '#     titleContains: "[bot]"',
  "prefilters: []",
  "",
  "# triage: plain-language lines for deciding whether an event needs action.",
  "#",
  "# triage:",
  "#   - Typo fixes in docs need no action.",
  "triage: []",
  "",
  "# standing: messages a Clot may send without asking. A rule has a name, a trigger (matched like a",
  "# pre-filter; it must name a kind), a way of sending, and an exact template.",
  "# Template fields: {actor}, {title}, {ref}, {repo}, {url}.",
  "#",
  "# standing:",
  "#   - name: ack-issue",
  "#     trigger: { kind: issue_opened }",
  "#     via: github_comment",
  '#     template: "Thanks for the report, @{actor}. I\'m looking into it."',
  "standing: []",
  "",
].join("\n");

/** The rule files: global.yaml for every Clot and <clot>.yaml for one. */
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
      const file = this.pathOf(name);
      if (!fs.existsSync(file)) fs.writeFileSync(file, STARTER.replace("{scope}", name === "global" ? "every Clot" : `the ${name} Clot`));
    }
  }

  /** Reads every rule file. A file that cannot be used leaves its last good version in force and is reported once. */
  load(): void {
    for (const name of this.names()) {
      const file = this.pathOf(name);
      try {
        this.files.set(name, fs.existsSync(file) ? parseRuleFile(fs.readFileSync(file, "utf8")) : EMPTY);
        this.reported.delete(name);
      } catch (error) {
        const problem = problemText(error);
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

  /** The triage guidance that applies to a Clot: the global lines, then its own. */
  guidance(clot: string): string {
    return this.rulesFor(clot)
      .flatMap((file) => file.triage)
      .join("\n");
  }

  /** The standing rules in force for a Clot: the global ones, then its own. Its own rule wins when both files hold a name. */
  standingFor(clot: string): StandingRule[] {
    const own = this.file(clot).standing;
    return [...this.file("global").standing.filter((rule) => !own.some((mine) => mine.name === rule.name)), ...own];
  }

  /** One file as it was last read: "global", or a Clot's name. */
  file(name: string): RuleFile {
    return this.files.get(name) ?? EMPTY;
  }

  /** Where a rule file is on disk. */
  pathOf(name: string): string {
    return path.join(this.dir, `${name}.yaml`);
  }

  private names(): string[] {
    return ["global", ...this.clots];
  }

  private rulesFor(clot: string): RuleFile[] {
    return [this.file("global"), this.file(clot)];
  }
}
