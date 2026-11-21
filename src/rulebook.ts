import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { isBuiltinSource, KIND_PATTERN, SOURCE_KINDS } from "./events/kinds.js";
import type { ClotEvent } from "./events/types.js";
import type { Binding } from "./routing.js";

/** The fields a template may use, each filled from the triggering event. `{repo}` is the older name of `{place}`. */
export const TEMPLATE_FIELDS = ["actor", "title", "ref", "place", "repo", "url"] as const;
export type TemplateField = (typeof TEMPLATE_FIELDS)[number];

/** Each way of sending, and the source whose events it answers. */
export const VIA_SOURCE = {
  github_comment: "github",
  email_reply: "email",
  linear_comment: "linear",
  notion_comment: "notion",
  sentry_comment: "sentry",
} as const;
export type Via = keyof typeof VIA_SOURCE;
export const VIAS = Object.keys(VIA_SOURCE) as [Via, ...Via[]];

/** The keys of a rule file that hold lists, in the order a file has them. */
export const LIST_KEYS: string[] = ["prefilters", "triage", "standing", "routing", "watches", "webhooks"];

/** A recipe's name: it becomes its events' source, so it cannot be a built-in source's. */
const recipeName = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]*$/, "a recipe's name uses lowercase letters, digits and hyphens")
  .refine((name) => !isBuiltinSource(name), "a recipe cannot have the name of a built-in source");

const WatchSchema = z.strictObject({
  name: recipeName,
  server: z.string().min(1),
  tool: z.string().min(1),
  arguments: z.record(z.string(), z.unknown()).default({}),
  items: z.string(),
  id: z.string().min(1),
  title: z.string().min(1).optional(),
  body: z.string().min(1).optional(),
  url: z.string().min(1).optional(),
  actor: z.string().min(1).optional(),
  ignore: z.array(z.string().min(1)).default([]),
  every: z.number().int().min(1).default(5),
  report: z.enum(["added", "added_and_changed"]).default("added"),
  notReadOnly: z.literal(true).optional(),
});

export type WatchRecipe = z.infer<typeof WatchSchema>;

/** Checks one watch recipe. Throws when it does not fit. */
export function parseWatch(value: unknown): WatchRecipe {
  return WatchSchema.parse(value);
}

const NAME = /^[a-z0-9][a-z0-9-]*$/;

/** The `{field}` names in a template that are not ones it may use. */
function unknownFields(template: string): string[] {
  return [...template.matchAll(/\{([A-Za-z_]+)\}/g)].map((m) => m[1]).filter((name) => !(TEMPLATE_FIELDS as readonly string[]).includes(name));
}

const kind = z
  .string()
  .regex(KIND_PATTERN, "a kind uses lowercase letters, digits and underscores")
  .refine((value) => value !== "batch", "batch is made by the daemon and cannot be named in a rule");

const MATCH_FIELDS = {
  source: z.string().min(1).optional(),
  account: z.string().min(1).optional(),
  kind: kind.optional(),
  place: z.string().min(1).optional(),
  repo: z.string().min(1).optional(),
  actor: z.string().min(1).optional(),
  titleContains: z.string().min(1).optional(),
};

type Match = { source?: string; account?: string; kind?: string; place?: string; repo?: string; actor?: string; titleContains?: string };

const names = (rule: Match) => (["source", "account", "kind", "place", "repo", "actor", "titleContains"] as const).some((key) => rule[key] !== undefined);

/** A rule that names a built-in source may name only a kind that source produces. */
const kindFits = (rule: Match) => rule.kind === undefined || rule.source === undefined || !isBuiltinSource(rule.source) || (SOURCE_KINDS[rule.source] as readonly string[]).includes(rule.kind);

/** `repo` is GitHub's: it means the source github and that place. */
const repoFits = (rule: Match) => rule.repo === undefined || rule.source === undefined || rule.source.toLowerCase() === "github";

/** A rule's fields, with the checks every rule that matches events shares. */
function matchSchema<T extends z.ZodRawShape>(shape: T, message: string) {
  return z
    .strictObject(shape)
    .refine((rule) => names(rule as Match), message)
    .refine((rule) => kindFits(rule as Match), "the kind is not one the named source produces")
    .refine((rule) => repoFits(rule as Match), "repo names a GitHub repository, so it cannot go with another source");
}

const PrefilterSchema = matchSchema(MATCH_FIELDS, "a pre-filter must name at least one of source, account, kind, place, repo, actor and titleContains");

const RoutingSchema = matchSchema({ ...MATCH_FIELDS, clot: z.string().regex(NAME, "clot is a Clot's name") }, "a routing rule must name at least one field to match on");

const StandingSchema = z
  .strictObject({
    name: z.string().regex(NAME, "a standing rule's name uses lowercase letters, digits and hyphens"),
    trigger: matchSchema({ ...MATCH_FIELDS, kind }, "a trigger must name a kind"),
    via: z.enum(VIAS),
    template: z
      .string()
      .min(1)
      .max(2000)
      .refine((template) => unknownFields(template).length === 0, "a template may use only the fields {actor}, {title}, {ref}, {place} and {url}"),
  })
  // A trigger that names no source is GitHub's, as every rule written before other sources existed.
  .refine((rule) => (rule.trigger.source ?? "github").toLowerCase() === VIA_SOURCE[rule.via], {
    message: "the way of sending does not fit the trigger: github_comment answers GitHub events, email_reply email (source: email), linear_comment Linear, notion_comment Notion, sentry_comment Sentry",
  });

const scalar = z.union([z.string(), z.number(), z.boolean()]);

const WebhookSchema = z.strictObject({
  name: recipeName,
  verify: z
    .strictObject({
      scheme: z.enum(["hmac-sha256", "token"]),
      // Header names are compared in lowercase, as the intake gives them.
      header: z
        .string()
        .min(1)
        .transform((header) => header.toLowerCase()),
      prefix: z.string().default(""),
      encoding: z.enum(["hex", "base64"]).default("hex"),
      signed: z.enum(["body", "timestamp.body"]).default("body"),
      timestampHeader: z
        .string()
        .min(1)
        .transform((header) => header.toLowerCase())
        .optional(),
      toleranceSeconds: z.number().int().min(1).default(300),
      // Only a key made for recipes: a recipe cannot name another of the daemon's secrets.
      secret: z.string().regex(/^RECIPE_[A-Z0-9_]+$/, "a recipe's secret is an .env key beginning RECIPE_"),
    })
    .refine((verify) => verify.signed !== "timestamp.body" || verify.timestampHeader !== undefined, "a timestamp.body signature needs a timestampHeader"),
  delivery: z.strictObject({ header: z.string().min(1).transform((header) => header.toLowerCase()).optional(), field: z.string().min(1).optional() }).optional(),
  kinds: z.array(z.strictObject({ kind, when: z.record(z.string(), scalar).default({}) })).min(1),
  event: z.strictObject({
    title: z.string().min(1),
    actor: z.string().optional(),
    body: z.string().optional(),
    url: z.string().optional(),
    ref: z.string().optional(),
    place: z.string().optional(),
    subject: z.string().optional(),
  }),
  automatedWhen: z.record(z.string(), scalar).optional(),
});

export type WebhookRecipe = z.infer<typeof WebhookSchema>;

/** Checks one webhook recipe. Throws when it does not fit. */
export function parseWebhook(value: unknown): WebhookRecipe {
  return WebhookSchema.parse(value);
}

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
  routing: z.array(RoutingSchema).default([]),
  watches: z.array(WatchSchema).default([]),
  webhooks: z.array(WebhookSchema).default([]),
});

export type Prefilter = z.infer<typeof PrefilterSchema>;
export type StandingRule = z.infer<typeof StandingSchema>;
export type RoutingRule = z.infer<typeof RoutingSchema>;
export type RuleFile = z.infer<typeof RuleFileSchema>;

const EMPTY: RuleFile = RuleFileSchema.parse({});

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

/** Checks one routing rule. Throws when it does not fit. */
export function parseRouting(value: unknown): RoutingRule {
  return RoutingSchema.parse(value);
}

/** What is wrong, in words a person or a Clot can act on. */
export function problemText(error: unknown): string {
  if (error instanceof z.ZodError) return error.issues.map((issue) => (issue.path.length > 0 ? `${issue.path.join(".")}: ${issue.message}` : issue.message)).join("; ");
  return error instanceof Error ? error.message : String(error);
}

const fold = (text: string) => text.toLowerCase();

/** A rule matches an event when every field it names matches. Text is compared without regard to case. */
export function matchesPrefilter(rule: Match, event: ClotEvent): boolean {
  if (rule.source !== undefined && fold(rule.source) !== fold(event.source)) return false;
  if (rule.account !== undefined && fold(rule.account) !== fold(event.account)) return false;
  if (rule.kind !== undefined && rule.kind !== event.kind) return false;
  if (rule.place !== undefined && fold(rule.place) !== fold(event.place)) return false;
  if (rule.repo !== undefined && (event.source !== "github" || fold(rule.repo) !== fold(event.place))) return false;
  if (rule.actor !== undefined && fold(rule.actor) !== fold(event.actor)) return false;
  if (rule.titleContains !== undefined && !fold(event.title).includes(fold(rule.titleContains))) return false;
  return true;
}

const STARTER = [
  "# Rules for {scope}. Edit by hand or by asking a Clot; the daemon picks up changes when the file is saved.",
  "#",
  "# prefilters: events that match a rule are dropped before anything else looks at them.",
  "# A rule matches when every field it names matches. Fields: source, account, kind, place, repo, actor, titleContains.",
  "# Sources: github, stripe, email, calendar, linear, notion, posthog, a Composio toolkit (by its slug), or a recipe's name.",
  "#",
  "# prefilters:",
  "#   - actor: dependabot[bot]",
  "#   - source: email",
  "#     place: me+newsletters@gmail.com",
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
  "# Ways of sending: github_comment, email_reply (source: email), linear_comment, notion_comment.",
  "# Template fields: {actor}, {title}, {ref}, {place}, {url}.",
  "#",
  "# standing:",
  "#   - name: ack-issue",
  "#     trigger: { kind: issue_opened }",
  "#     via: github_comment",
  '#     template: "Thanks for the report, @{actor}. I\'m looking into it."',
  "standing: []",
  "",
].join("\n");

const ROUTING_STARTER = [
  "# routing: which Clot an event from a shared account goes to. The first rule that matches wins;",
  "# an event no rule matches is routed by the routing call, then goes to the home Clot.",
  "#",
  "# routing:",
  "#   - source: email",
  "#     place: you+encryptify@gmail.com",
  "#     clot: encryptify",
  "routing: []",
  "",
].join("\n");

/** The rule files: global.yaml for every Clot and <clot>.yaml for one. */
export class Rulebook {
  private files = new Map<string, RuleFile>();
  /** A file's last problem, reported once until it changes or the file can be used again. */
  private problems = new Map<string, string>();
  /** "<file>\n<notice>": parts of a usable file that are ignored, each reported once for as long as it holds. */
  private notices = new Set<string>();
  private listeners: (() => void)[] = [];

  /** Calls fn after each load, for what follows the files: the running watch recipes, the webhook recipes' secrets. */
  onLoad(fn: () => void): void {
    this.listeners.push(fn);
  }

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
      if (fs.existsSync(file)) continue;
      const starter = STARTER.replace("{scope}", name === "global" ? "every Clot" : `the ${name} Clot`);
      fs.writeFileSync(file, name === "global" ? `${starter}\n${ROUTING_STARTER}` : starter);
    }
  }

  /** Reads every rule file. A file that cannot be used leaves its last good version in force and is reported once. */
  load(): void {
    for (const name of this.names()) {
      const file = this.pathOf(name);
      try {
        const read = fs.existsSync(file) ? parseRuleFile(fs.readFileSync(file, "utf8")) : EMPTY;
        this.files.set(name, read);
        this.problems.delete(name);
        this.notice(name, this.ignoredParts(name, read));
      } catch (error) {
        const problem = problemText(error);
        if (this.problems.get(name) !== problem) {
          this.problems.set(name, problem);
          this.onInvalid(`${name}.yaml`, problem);
        }
      }
    }
    for (const listener of this.listeners) listener();
  }

  /** What a usable file holds that is not used. Later parts of the rulebook add theirs here. */
  private ignoredParts(name: string, file: RuleFile): string[] {
    const parts: string[] = [];
    if (name !== "global" && file.routing.length > 0) parts.push("routing rules belong in global.yaml; the ones in this file are ignored");
    if (name === "global") parts.push(...file.routing.filter((rule) => !this.clots.includes(rule.clot)).map((rule) => `the routing rule for "${rule.clot}" names no Clot that exists, so it is ignored`));
    // A recipe's name is its events' source, so two recipes cannot share one, in one file or in two.
    const earlier = new Set(this.recipes().filter((entry) => this.names().indexOf(entry.file) < this.names().indexOf(name)).map((entry) => entry.name));
    for (const recipeName of this.recipeNamesIn(file)) if (earlier.has(recipeName)) parts.push(`the recipe "${recipeName}" has the name of another recipe, so it is ignored`);
    return parts;
  }

  /** The recipes a file holds, by name: watch recipes and webhook recipes share one set of names. */
  private recipeNamesIn(file: RuleFile): string[] {
    return [...file.watches.map((recipe) => recipe.name), ...file.webhooks.map((recipe) => recipe.name)];
  }

  /** The webhook recipe in force with this name, if any. */
  webhook(name: string): WebhookRecipe | undefined {
    const entry = this.recipes().find((candidate) => candidate.name === name);
    return entry === undefined ? undefined : this.file(entry.file).webhooks.find((recipe) => recipe.name === name);
  }

  /** Every recipe in force, with its file, in file order; of two with one name, the first. */
  private recipes(): { name: string; file: string }[] {
    const seen = new Set<string>();
    const out: { name: string; file: string }[] = [];
    for (const name of this.names()) {
      for (const recipeName of this.recipeNamesIn(this.file(name))) {
        if (seen.has(recipeName)) continue;
        seen.add(recipeName);
        out.push({ name: recipeName, file: name });
      }
    }
    return out;
  }

  /** The watch recipes in force, each with the file it is in. */
  watches(): { recipe: WatchRecipe; file: string }[] {
    const inForce = this.recipes();
    return this.names().flatMap((file) => this.file(file).watches.filter((recipe) => inForce.some((entry) => entry.name === recipe.name && entry.file === file)).map((recipe) => ({ recipe, file })));
  }

  /** Where a recipe's events go: the Clot whose file it is in, or routing for one in global.yaml. Undefined for no recipe. */
  recipeBinding(name: string): Binding | undefined {
    const entry = this.recipes().find((candidate) => candidate.name === name);
    if (entry === undefined) return undefined;
    return entry.file === "global" ? "shared" : { clot: entry.file };
  }

  /** Reports each notice once while it holds; one that goes away and comes back is reported again. */
  private notice(name: string, current: string[]): void {
    for (const key of [...this.notices]) if (key.startsWith(`${name}\n`) && !current.includes(key.slice(name.length + 1))) this.notices.delete(key);
    for (const text of current) {
      const key = `${name}\n${text}`;
      if (this.notices.has(key)) continue;
      this.notices.add(key);
      this.onInvalid(`${name}.yaml`, text);
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

  /** Whether one file's pre-filters drop the event: "global", or a Clot's name. */
  dropsIn(name: string, event: ClotEvent): boolean {
    return this.file(name).prefilters.some((rule) => matchesPrefilter(rule, event));
  }

  /** The triage guidance that applies to a Clot: the global lines, then its own. For "global", the global lines. */
  guidance(clot: string): string {
    return (clot === "global" ? [this.file("global")] : this.rulesFor(clot)).flatMap((file) => file.triage).join("\n");
  }

  /** The standing rules in force for a Clot: the global ones, then its own. Its own rule wins when both files hold a name. */
  standingFor(clot: string): StandingRule[] {
    const own = this.file(clot).standing;
    return [...this.file("global").standing.filter((rule) => !own.some((mine) => mine.name === rule.name)), ...own];
  }

  /** The routing rules in force: the global file's, less those naming a Clot that does not exist. */
  routing(): RoutingRule[] {
    return this.file("global").routing.filter((rule) => this.clots.includes(rule.clot));
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
