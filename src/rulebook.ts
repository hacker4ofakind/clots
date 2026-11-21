import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { isBuiltinSource, isBuiltinToolkit, KIND_PATTERN, SOURCE_KINDS } from "./events/kinds.js";
import { pathsIn } from "./paths.js";
import type { ClotEvent } from "./events/types.js";
import { callsPerMonth, MONTHLY_POLLING_CALLS } from "./config.js";
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
export const LIST_KEYS: string[] = ["prefilters", "triage", "standing", "routing", "watches", "webhooks", "composio"];

/** A recipe's name: it becomes its events' source, so it cannot be a built-in source's. */
const recipeName = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]*$/, "a recipe's name uses lowercase letters, digits and hyphens")
  .refine((name) => !isBuiltinSource(name), "a recipe cannot have the name of a built-in source");

const WatchSchema = z
  .strictObject({
  name: recipeName,
  // Exactly one of `server` (an MCP server) and `account` (a Composio account, `<toolkit>:<account>`).
  server: z.string().min(1).optional(),
  account: z
    .string()
    .regex(/^[a-z][a-z0-9_]*:[a-z0-9][a-z0-9-]*$/, "account is a Composio account, written <toolkit>:<account>")
    .optional(),
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
  })
  .refine((watch) => (watch.server === undefined) !== (watch.account === undefined), { message: "give either server (an MCP server) or account (a Composio account), not both and not neither", path: ["server"] })
  .superRefine((watch, ctx) => {
    if (watch.account === undefined) return;
    if (watch.every < MIN_COMPOSIO_WATCH_MINUTES) ctx.addIssue({ code: "custom", path: ["every"], message: `a watch on a Composio account runs every ${MIN_COMPOSIO_WATCH_MINUTES} minutes or less often, since every run counts against Composio's allowance` });
    if (watch.notReadOnly) ctx.addIssue({ code: "custom", path: ["notReadOnly"], message: "a watch on a Composio account may use only a tool Composio marks as a read; notReadOnly does not apply" });
    const toolkit = watch.account.split(":")[0].toUpperCase();
    if (!watch.tool.startsWith(`${toolkit}_`)) ctx.addIssue({ code: "custom", path: ["tool"], message: `the tool must be one of ${watch.account.split(":")[0]}'s: its slug begins ${toolkit}_` });
  });

const watchOverBudgetText = (name: string): string => `the watch "${name}" would take Composio past ${MONTHLY_POLLING_CALLS.toLocaleString("en-US")} polling calls a month`;

/** A watch on a Composio account runs at most this often: each run is a call against the month's allowance. */
export const MIN_COMPOSIO_WATCH_MINUTES = 15;

export type WatchRecipe = z.infer<typeof WatchSchema>;

/** Where a watch calls: an MCP server, or a Composio account. */
export const watchTarget = (recipe: Pick<WatchRecipe, "server" | "account">): string => recipe.account ?? recipe.server ?? "";

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

/** A Composio tool or trigger slug: uppercase, beginning with its toolkit's name. */
const COMPOSIO_SLUG = /^[A-Z][A-Z0-9_]*$/;

/** At most this many reads run for one trigger's payload. */
export const MAX_ENRICH_READS = 3;

/** The fields a recipe may fill from a read's data: the pipeline keeps only these three after enrichment. */
const ENRICHED_FIELDS = ["title", "actor", "body"] as const;

const TriggerRecipeSchema = z.strictObject({
  kind,
  title: z.string().min(1),
  id: z.string().min(1).optional(),
  actorId: z.string().min(1).optional(),
  actor: z.string().min(1).optional(),
  body: z.string().min(1).optional(),
  url: z.string().min(1).optional(),
  ref: z.string().min(1).optional(),
  place: z.string().min(1).optional(),
  subject: z.string().min(1).optional(),
  objects: z.array(z.string().min(1)).optional(),
  automatedWhen: z.record(z.string(), scalar).optional(),
  enrich: z
    .array(
      z.strictObject({
        as: z.string().regex(/^[a-z][a-z0-9_]*$/, "a read's name `as` uses lowercase letters, digits and underscores"),
        tool: z.string().regex(COMPOSIO_SLUG, "a tool is Composio's uppercase slug"),
        args: z.record(z.string(), z.unknown()).optional(),
      }),
    )
    .max(MAX_ENRICH_READS, `at most ${MAX_ENRICH_READS} reads for one trigger`)
    .optional(),
});

/** The strings in a value, to any depth: a read's arguments may hold templates in nested objects and lists. */
export function stringsIn(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringsIn);
  if (value !== null && typeof value === "object") return Object.values(value).flatMap(stringsIn);
  return [];
}

export const ComposioRecipeSchema = z
  .strictObject({
    toolkit: z
      .string()
      .regex(/^[a-z][a-z0-9_]*$/, "a toolkit is Composio's lowercase slug")
      .refine((name) => !isBuiltinToolkit(name), "a Composio recipe cannot name a toolkit that has built-in support (linear, notion, stripe, googlecalendar, posthog)")
      .refine((name) => !isBuiltinSource(name), "a Composio recipe cannot name a toolkit like a built-in source: the toolkit becomes its events' source"),
    identity: z.strictObject({ tool: z.string().regex(COMPOSIO_SLUG), path: z.string().min(1) }).optional(),
    ownWrites: z.array(z.strictObject({ tool: z.string().regex(COMPOSIO_SLUG), ids: z.array(z.string().min(1)).min(1) })).optional(),
    triggers: z
      .record(z.string().regex(COMPOSIO_SLUG, "a trigger is Composio's uppercase slug"), TriggerRecipeSchema)
      .refine((triggers) => Object.keys(triggers).length > 0, "a recipe maps at least one trigger"),
  })
  .superRefine((recipe, ctx) => {
    const prefix = `${recipe.toolkit.toUpperCase()}_`;
    const tools: [string, (string | number)[]][] = [];
    if (recipe.identity) tools.push([recipe.identity.tool, ["identity", "tool"]]);
    recipe.ownWrites?.forEach((write, i) => tools.push([write.tool, ["ownWrites", i, "tool"]]));
    for (const [slug, trigger] of Object.entries(recipe.triggers)) {
      if (!slug.startsWith(prefix)) ctx.addIssue({ code: "custom", path: ["triggers", slug], message: `the trigger ${slug} is not ${recipe.toolkit}'s: its slug begins ${prefix}` });
      const reads = trigger.enrich ?? [];
      const seen = new Set<string>();
      reads.forEach((read, i) => {
        if (seen.has(read.as)) ctx.addIssue({ code: "custom", path: ["triggers", slug, "enrich", i, "as"], message: `two reads of ${slug} are both named ${read.as}` });
        tools.push([read.tool, ["triggers", slug, "enrich", i, "tool"]]);
        // A read's arguments may use the payload and the reads before it, nothing else.
        for (const path of stringsIn(read.args).flatMap(pathsIn)) checkPath(path, seen, ["triggers", slug, "enrich", i, "args"]);
        seen.add(read.as);
      });
      const all = new Set(reads.map((read) => read.as));
      const templates: [string, string | undefined][] = [["id", trigger.id], ["actorId", trigger.actorId], ["actor", trigger.actor], ["title", trigger.title], ["body", trigger.body], ["url", trigger.url], ["ref", trigger.ref], ["place", trigger.place], ["subject", trigger.subject], ...(trigger.objects ?? []).map((o, i): [string, string] => [`objects.${i}`, o])];
      for (const [field, template] of templates) {
        if (template === undefined) continue;
        const paths = pathsIn(template);
        if (paths.some((p) => p === "enrich" || p.startsWith("enrich.")) && !(ENRICHED_FIELDS as readonly string[]).includes(field)) {
          ctx.addIssue({ code: "custom", path: ["triggers", slug, field.split(".")[0]], message: `${field} cannot use enrich: only title, actor and body are filled after the reads (the other fields are set when the delivery arrives)` });
        }
        for (const path of paths) checkPath(path, all, ["triggers", slug, field.split(".")[0]]);
      }
      for (const key of Object.keys(trigger.automatedWhen ?? {})) checkPath(key, new Set(), ["triggers", slug, "automatedWhen"], true);
    }
    for (const [slug, path] of tools) {
      if (!slug.startsWith(prefix)) ctx.addIssue({ code: "custom", path, message: `${slug} is not a tool of ${recipe.toolkit}: its slug begins ${prefix}` });
    }
    function checkPath(path: string, reads: Set<string>, where: (string | number)[], payloadOnly = false): void {
      const [root, name] = path.split(".");
      if (root === "payload") return;
      if (root === "enrich" && !payloadOnly) {
        if (name === undefined || !reads.has(name)) ctx.addIssue({ code: "custom", path: where, message: `{${path}} names no read: ${reads.size > 0 ? `the reads here are ${[...reads].join(", ")}` : "no read comes before it"}` });
        return;
      }
      ctx.addIssue({ code: "custom", path: where, message: `{${path}} is out of reach: a template reads payload${payloadOnly ? "" : " and enrich.<as>"}, nothing else` });
    }
  });

export type ComposioRecipe = z.infer<typeof ComposioRecipeSchema>;
export type ComposioTriggerRecipe = z.infer<typeof TriggerRecipeSchema>;

/** Checks one Composio recipe. Throws when it does not fit. */
export function parseComposioRecipe(value: unknown): ComposioRecipe {
  return ComposioRecipeSchema.parse(value);
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
  composio: z.array(ComposioRecipeSchema).default([]),
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
  /** The toolkits `sources.composio` names. */
  private reserved = new Set<string>();
  /** The calendars' monthly polling calls, which the watches on Composio accounts share a limit with. */
  private calendarCalls = 0;

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
    const over = this.overBudget();
    for (const recipe of file.watches) if (over.has(recipe.name)) parts.push(watchOverBudgetText(recipe.name));
    const here = new Set<string>();
    for (const { name: recipeName, kind } of this.recipeNamesIn(file)) {
      if (kind !== "composio" && this.reserved.has(recipeName)) parts.push(`the recipe "${recipeName}" has the name of the Composio toolkit ${recipeName}, whose events use it as their source, so it is ignored`);
      else if (kind === "composio" && (earlier.has(recipeName) || here.has(recipeName))) parts.push(`the Composio recipe for "${recipeName}" is ignored: another recipe has that name, and the first in file order is the one in force`);
      else if (earlier.has(recipeName) || here.has(recipeName)) parts.push(`the recipe "${recipeName}" has the name of another recipe, so it is ignored`);
      here.add(recipeName);
    }
    return parts;
  }

  /** The recipes a file holds, by name and kind: watch recipes and webhook recipes share one set of names with the Composio recipes' toolkits, since each becomes its events' source. */
  private recipeNamesIn(file: RuleFile): { name: string; kind: "watch" | "webhook" | "composio" }[] {
    return [...file.watches.map((r) => ({ name: r.name, kind: "watch" as const })), ...file.webhooks.map((r) => ({ name: r.name, kind: "webhook" as const })), ...file.composio.map((r) => ({ name: r.toolkit, kind: "composio" as const }))];
  }

  /** The toolkits `sources.composio` names: a watch or webhook recipe cannot take one's name, which is its events' source. */
  setReserved(toolkits: string[]): void {
    this.reserved = new Set(toolkits);
  }

  /** Sets the month's polling calls the calendars take, so that the watches on Composio accounts are held to the limit they share. */
  setCalendarCalls(calls: number): void {
    this.calendarCalls = calls;
  }

  /**
   * The watches on Composio accounts that would take polling past the month's limit, in file order: each is counted
   * when it fits, and refused when it would cross, so one too many does not stop the others.
   */
  private overBudget(): Set<string> {
    const refused = new Set<string>();
    let sum = this.calendarCalls;
    const inForce = this.recipes();
    for (const file of this.names()) {
      for (const recipe of this.file(file).watches) {
        if (recipe.account === undefined || !inForce.some((e) => e.name === recipe.name && e.file === file && e.kind === "watch")) continue;
        const calls = callsPerMonth(recipe.every);
        if (sum + calls > MONTHLY_POLLING_CALLS) refused.add(recipe.name);
        else sum += calls;
      }
    }
    return refused;
  }

  /** Why a watch on a Composio account cannot be set: with it, the calendars' polling and the other Composio watches would pass the limit. Undefined when it fits or is not on an account. */
  watchBudgetProblem(recipe: WatchRecipe): string | undefined {
    if (recipe.account === undefined) return undefined;
    const others = this.names().flatMap((file) => this.file(file).watches).filter((w) => w.account !== undefined && w.name !== recipe.name && !this.overBudget().has(w.name));
    const sum = this.calendarCalls + others.reduce((n, w) => n + callsPerMonth(w.every), 0) + callsPerMonth(recipe.every);
    return sum > MONTHLY_POLLING_CALLS ? watchOverBudgetText(recipe.name) : undefined;
  }

  /** The webhook recipe in force with this name, if any. */
  webhook(name: string): WebhookRecipe | undefined {
    const entry = this.recipes().find((candidate) => candidate.name === name && candidate.kind === "webhook");
    return entry === undefined ? undefined : this.file(entry.file).webhooks.find((recipe) => recipe.name === name);
  }

  /** The Composio recipe in force for a toolkit: the first in file order. */
  composioRecipe(toolkit: string): ComposioRecipe | undefined {
    const entry = this.recipes().find((candidate) => candidate.name === toolkit && candidate.kind === "composio");
    return entry === undefined ? undefined : this.file(entry.file).composio.find((recipe) => recipe.toolkit === toolkit);
  }

  /** The file whose recipe is in force for the name (a toolkit, or a webhook or watch recipe's name), if any. */
  recipeFile(name: string): { file: string; kind: "watch" | "webhook" | "composio" } | undefined {
    const entry = this.recipes().find((candidate) => candidate.name === name);
    return entry === undefined ? undefined : { file: entry.file, kind: entry.kind };
  }

  /** Every recipe in force, with its file, in file order; of two with one name, the first. A watch or webhook recipe named like a configured toolkit is not in force. */
  private recipes(): { name: string; file: string; kind: "watch" | "webhook" | "composio" }[] {
    const seen = new Set<string>();
    const out: { name: string; file: string; kind: "watch" | "webhook" | "composio" }[] = [];
    for (const file of this.names()) {
      for (const { name, kind } of this.recipeNamesIn(this.file(file))) {
        if (seen.has(name) || (kind !== "composio" && this.reserved.has(name))) continue;
        seen.add(name);
        out.push({ name, file, kind });
      }
    }
    return out;
  }

  /** The watch recipes in force, each with the file it is in. */
  watches(): { recipe: WatchRecipe; file: string }[] {
    const inForce = this.recipes();
    const over = this.overBudget();
    return this.names().flatMap((file) => this.file(file).watches.filter((recipe) => !over.has(recipe.name) && inForce.some((entry) => entry.name === recipe.name && entry.file === file && entry.kind === "watch")).map((recipe) => ({ recipe, file })));
  }

  /** Where a recipe's events go: the Clot whose file it is in, or routing for one in global.yaml. Undefined for no recipe. */
  recipeBinding(name: string): Binding | undefined {
    const entry = this.recipes().find((candidate) => candidate.name === name && candidate.kind !== "composio");
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
