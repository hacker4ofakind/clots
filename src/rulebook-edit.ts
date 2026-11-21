import { isScalar, isSeq, parseDocument, YAMLSeq, type Document } from "yaml";
import { LIST_KEYS, parseComposioRecipe, parsePrefilter, parseRouting, parseRuleFile, parseStanding, parseWatch, parseWebhook, problemText, type ComposioRecipe, type Prefilter, type RoutingRule, type RuleFile, type StandingRule, type WatchRecipe, type WebhookRecipe } from "./rulebook.js";

/** Which file an edit is for: the Clot's own, or the one that applies to every Clot. */
export type RuleScope = "own" | "global";

/**
 * One change to a rule file. `set_standing` adds a rule, or replaces the rule of the same name.
 * `was`, which an inverse carries, is the rule the file must hold under that name for the edit
 * to be made (null: none). It keeps an undo from overwriting a rule that was changed since.
 */
export type RuleEdit =
  | { op: "add_prefilter"; rule: Prefilter }
  | { op: "remove_prefilter"; rule: Prefilter }
  | { op: "add_guidance"; line: string }
  | { op: "remove_guidance"; line: string }
  | { op: "set_standing"; rule: StandingRule; was?: StandingRule | null }
  | { op: "remove_standing"; name: string; was?: StandingRule }
  | { op: "add_routing"; rule: RoutingRule }
  | { op: "remove_routing"; rule: RoutingRule }
  | { op: "set_watch"; recipe: WatchRecipe; was?: WatchRecipe | null }
  | { op: "remove_watch"; name: string; was?: WatchRecipe }
  | { op: "set_webhook"; recipe: WebhookRecipe; was?: WebhookRecipe | null }
  | { op: "remove_webhook"; name: string; was?: WebhookRecipe }
  | { op: "set_composio"; recipe: ComposioRecipe; was?: ComposioRecipe | null }
  /** `name` is the recipe's toolkit: a Composio recipe has no name of its own. */
  | { op: "remove_composio"; name: string; was?: ComposioRecipe };

/** The edit cannot be made. The message says why, in words for the Clot and the user. */
export class EditRefused extends Error {}

export interface EditResult {
  /** The file's new text. */
  text: string;
  /** The edit that puts the file back as it was. */
  inverse: RuleEdit;
  /** What the edit did. The first line stands alone. */
  summary: string;
}

/** "kind is `comment` and actor is `vercel[bot]`" */
export function describeMatch(rule: Prefilter): string {
  const parts: string[] = [];
  if (rule.source !== undefined) parts.push(`source is \`${rule.source}\``);
  if (rule.account !== undefined) parts.push(`account is \`${rule.account}\``);
  if (rule.kind !== undefined) parts.push(`kind is \`${rule.kind}\``);
  if (rule.place !== undefined) parts.push(`place is \`${rule.place}\``);
  if (rule.actor !== undefined) parts.push(`actor is \`${rule.actor}\``);
  if (rule.repo !== undefined) parts.push(`repository is \`${rule.repo}\``);
  if (rule.titleContains !== undefined) parts.push(`title contains "${rule.titleContains}"`);
  return parts.join(" and ");
}

/** "events where source is `email` ... to shop" */
export function describeRouting(rule: RoutingRule): string {
  return `events where ${describeMatch(rule)} to ${rule.clot}`;
}

/** A watch recipe in full, with a warning in bold when its tool may change things. */
export function describeWatch(recipe: WatchRecipe): string {
  const shown = [`\`${recipe.name}\`: every ${recipe.every} minutes, call \`${recipe.tool}\` on ${recipe.account === undefined ? `\`${recipe.server}\`` : `the Composio account \`${recipe.account}\``} with ${JSON.stringify(recipe.arguments)}`, `items at \`${recipe.items || "(the result)"}\`, each named by \`${recipe.id}\``, `report ${recipe.report === "added" ? "new items" : "new and changed items"}`];
  if (recipe.ignore.length > 0) shown.push(`ignoring ${recipe.ignore.map((path) => `\`${path}\``).join(", ")}`);
  const warning = recipe.notReadOnly ? "\n**This tool does not declare itself read-only. The daemon will call it every few minutes; say yes only if you know it changes nothing.**" : "";
  return `${shown.join("; ")}${warning}`;
}

/** A webhook recipe in full, with where the service sends it and where its secret goes. */
export function describeWebhook(recipe: WebhookRecipe, publicUrl = "<publicUrl>"): string {
  const check = recipe.verify.scheme === "token" ? `the header \`${recipe.verify.header}\` holds the secret` : `\`${recipe.verify.header}\` holds ${recipe.verify.prefix ? `"${recipe.verify.prefix}" and ` : ""}an HMAC-SHA256 of the ${recipe.verify.signed === "body" ? "body" : "timestamp and the body"} in ${recipe.verify.encoding}`;
  return [
    `\`${recipe.name}\`: deliveries to ${publicUrl}/webhooks/r/${recipe.name}, checked as ${check}`,
    `kinds: ${recipe.kinds.map((entry) => `${entry.kind} when ${JSON.stringify(entry.when)}`).join("; ")}`,
    `title: ${recipe.event.title}`,
    `The secret goes in .env as ${recipe.verify.secret}; the user sets up the webhook in the service.`,
  ].join("\n");
}

/** A Composio recipe in full: the toolkit, what each trigger becomes, and the reads and writes it names. */
export function describeComposioRecipe(recipe: ComposioRecipe): string {
  const triggers = Object.entries(recipe.triggers).map(([slug, t]) => {
    const reads = (t.enrich ?? []).map((r) => `\`${r.tool}\` as ${r.as}`);
    return `- \`${slug}\` becomes a \`${t.kind}\` event titled "${t.title}"${t.actor ? `, actor "${t.actor}"` : ""}${reads.length > 0 ? `; reads before routing: ${reads.join(", ")}` : ""}`;
  });
  return [
    `\`${recipe.toolkit}\`: how its Composio triggers become events (always from an outsider; it cannot rate a write or add an undo)`,
    ...triggers,
    ...(recipe.identity ? [`who the connection is: \`${recipe.identity.tool}\`, \`${recipe.identity.path}\``] : []),
    ...(recipe.ownWrites && recipe.ownWrites.length > 0 ? [`the Clots' own writes it recognises: ${recipe.ownWrites.map((w) => `\`${w.tool}\``).join(", ")}`] : []),
  ].join("\n");
}

/** A standing rule in full: its name, its trigger, how it sends, and its template as a quotation. */
export function describeStanding(rule: StandingRule): string {
  return `\`${rule.name}\`: when ${describeMatch(rule.trigger)}, send via ${rule.via}:\n> ${rule.template.split("\n").join("\n> ")}`;
}

export function describeEdit(edit: RuleEdit): string {
  switch (edit.op) {
    case "add_prefilter":
      return `Drop events where ${describeMatch(edit.rule)}`;
    case "remove_prefilter":
      return `Stop dropping events where ${describeMatch(edit.rule)}`;
    case "add_guidance":
      return `Add triage guidance: "${edit.line}"`;
    case "remove_guidance":
      return `Remove triage guidance: "${edit.line}"`;
    case "set_standing":
      return `Standing rule ${describeStanding(edit.rule)}`;
    case "remove_standing":
      return `Remove standing rule \`${edit.name}\``;
    case "add_routing":
      return `Route ${describeRouting(edit.rule)}`;
    case "remove_routing":
      return `Stop routing ${describeRouting(edit.rule)}`;
    case "set_watch":
      return `Watch recipe ${describeWatch(edit.recipe)}`;
    case "remove_watch":
      return `Remove watch recipe \`${edit.name}\``;
    case "set_webhook":
      return `Webhook recipe ${describeWebhook(edit.recipe)}`;
    case "remove_webhook":
      return `Remove webhook recipe \`${edit.name}\``;
    case "set_composio":
      return `Composio recipe ${describeComposioRecipe(edit.recipe)}`;
    case "remove_composio":
      return `Remove the Composio recipe for \`${edit.name}\``;
  }
}

/** The fields in a fixed order and nothing undefined, so that the same rule is always written the same way. */
function tidy<T extends Prefilter>(rule: T): T {
  const out: Record<string, string> = {};
  for (const key of ["source", "account", "kind", "place", "repo", "actor", "titleContains"] as const) {
    const value = rule[key];
    if (value !== undefined) out[key] = value;
  }
  return out as T;
}

function samePrefilter(a: Prefilter, b: Prefilter): boolean {
  const fold = (text: string | undefined) => text?.toLowerCase();
  return (
    a.kind === b.kind &&
    (["source", "account", "place", "repo", "actor", "titleContains"] as const).every((key) => fold(a[key]) === fold(b[key]))
  );
}

function sameRouting(a: RoutingRule, b: RoutingRule): boolean {
  return a.clot === b.clot && samePrefilter(a, b);
}

function sameStanding(a: StandingRule | null, b: StandingRule | null): boolean {
  if (a === null || b === null) return a === b;
  const flat = (rule: StandingRule) => JSON.stringify([rule.name, tidy(rule.trigger), rule.via, rule.template]);
  return flat(a) === flat(b);
}

/** Runs a schema check and turns its complaint into a refusal. */
function checked<T>(check: () => T): T {
  try {
    return check();
  } catch (error) {
    throw new EditRefused(problemText(error));
  }
}

/**
 * The list under a key, made when it is missing. A list written as `[]` is switched to one
 * item per line, and a single block of triage text becomes the list's first line.
 */
function list(doc: Document, key: string): YAMLSeq {
  const node = doc.get(key, true);
  if (isSeq(node)) {
    node.flow = false;
    return node;
  }
  const seq = new YAMLSeq();
  if (isScalar(node) && typeof node.value === "string" && node.value.trim() !== "") seq.add(doc.createNode(node.value.trim()));
  doc.set(key, seq);
  return seq;
}

/**
 * Applies one edit to a rule file's text. The file is changed as a YAML document, so comments
 * and everything written by hand stay as they were. Throws EditRefused when the file cannot be
 * used as it is, when the edit does not fit, or when there is nothing for it to do.
 */
export function applyEdit(text: string, edit: RuleEdit): EditResult {
  let file: RuleFile;
  try {
    file = parseRuleFile(text);
  } catch (error) {
    throw new EditRefused(`the file cannot be used as it is (${problemText(error)}); it has to be fixed by hand first`);
  }
  const doc = parseDocument(text);
  let inverse: RuleEdit;
  let summary: string;

  switch (edit.op) {
    case "add_prefilter": {
      const rule = tidy(checked(() => parsePrefilter(edit.rule)));
      if (file.prefilters.some((other) => samePrefilter(other, rule))) throw new EditRefused("that pre-filter is already in the file");
      list(doc, "prefilters").add(doc.createNode(rule));
      inverse = { op: "remove_prefilter", rule };
      summary = describeEdit({ op: "add_prefilter", rule });
      break;
    }
    case "remove_prefilter": {
      const at = file.prefilters.findIndex((other) => samePrefilter(other, edit.rule));
      if (at < 0) throw new EditRefused(`there is no such pre-filter in the file. It holds: ${file.prefilters.map(describeMatch).join("; ") || "none"}`);
      const rule = tidy(file.prefilters[at]);
      list(doc, "prefilters").delete(at);
      inverse = { op: "add_prefilter", rule };
      summary = describeEdit({ op: "remove_prefilter", rule });
      break;
    }
    case "add_guidance": {
      const line = edit.line.replace(/\s+/g, " ").trim();
      if (line === "") throw new EditRefused("the line is empty");
      if (file.triage.includes(line)) throw new EditRefused("that line is already in the file");
      list(doc, "triage").add(doc.createNode(line));
      inverse = { op: "remove_guidance", line };
      summary = describeEdit({ op: "add_guidance", line });
      break;
    }
    case "remove_guidance": {
      const line = edit.line.replace(/\s+/g, " ").trim();
      const at = file.triage.findIndex((other) => other.replace(/\s+/g, " ").trim() === line);
      if (at < 0) throw new EditRefused(`there is no such line in the file. It holds: ${file.triage.map((other) => `"${other}"`).join("; ") || "none"}`);
      const removed = file.triage[at];
      list(doc, "triage").delete(at);
      inverse = { op: "add_guidance", line: removed };
      summary = describeEdit({ op: "remove_guidance", line: removed });
      break;
    }
    case "set_standing": {
      const parsed = checked(() => parseStanding(edit.rule));
      const rule: StandingRule = { name: parsed.name, trigger: tidy(parsed.trigger), via: parsed.via, template: parsed.template };
      const at = file.standing.findIndex((other) => other.name === rule.name);
      if (edit.was !== undefined && !sameStanding(at < 0 ? null : file.standing[at], edit.was)) throw new EditRefused(`the standing rule "${rule.name}" has been changed since`);
      summary = describeEdit({ op: "set_standing", rule });
      if (at < 0) {
        list(doc, "standing").add(doc.createNode(rule));
        inverse = { op: "remove_standing", name: rule.name, was: rule };
      } else {
        const old = file.standing[at];
        list(doc, "standing").set(at, doc.createNode(rule));
        inverse = { op: "set_standing", rule: old, was: rule };
        summary += `\nIt replaces the rule as it is now:\n${describeStanding(old)}`;
      }
      break;
    }
    case "add_routing": {
      const parsed = checked(() => parseRouting(edit.rule));
      const rule: RoutingRule = { ...tidy(parsed), clot: parsed.clot };
      if (file.routing.some((other) => sameRouting(other, rule))) throw new EditRefused("that routing rule is already in the file");
      list(doc, "routing").add(doc.createNode(rule));
      inverse = { op: "remove_routing", rule };
      summary = describeEdit({ op: "add_routing", rule });
      break;
    }
    case "remove_routing": {
      const at = file.routing.findIndex((other) => sameRouting(other, edit.rule));
      if (at < 0) throw new EditRefused(`there is no such routing rule in the file. It holds: ${file.routing.map(describeRouting).join("; ") || "none"}`);
      const rule: RoutingRule = { ...tidy(file.routing[at]), clot: file.routing[at].clot };
      list(doc, "routing").delete(at);
      inverse = { op: "add_routing", rule };
      summary = describeEdit({ op: "remove_routing", rule });
      break;
    }
    case "set_watch": {
      const recipe = checked(() => parseWatch(edit.recipe));
      const at = file.watches.findIndex((other) => other.name === recipe.name);
      const same = (a: WatchRecipe | null, b: WatchRecipe | null) => JSON.stringify(a) === JSON.stringify(b);
      if (edit.was !== undefined && !same(at < 0 ? null : file.watches[at], edit.was)) throw new EditRefused(`the watch recipe "${recipe.name}" has been changed since`);
      summary = describeEdit({ op: "set_watch", recipe });
      if (at < 0) {
        list(doc, "watches").add(doc.createNode(recipe));
        inverse = { op: "remove_watch", name: recipe.name, was: recipe };
      } else {
        list(doc, "watches").set(at, doc.createNode(recipe));
        inverse = { op: "set_watch", recipe: file.watches[at], was: recipe };
        summary += `\nIt replaces the recipe as it is now:\n${describeWatch(file.watches[at])}`;
      }
      break;
    }
    case "remove_watch": {
      const at = file.watches.findIndex((other) => other.name === edit.name);
      if (at < 0) throw new EditRefused(`there is no watch recipe named "${edit.name}" in the file. It holds: ${file.watches.map((other) => other.name).join(", ") || "none"}`);
      if (edit.was !== undefined && JSON.stringify(file.watches[at]) !== JSON.stringify(edit.was)) throw new EditRefused(`the watch recipe "${edit.name}" has been changed since`);
      list(doc, "watches").delete(at);
      inverse = { op: "set_watch", recipe: file.watches[at], was: null };
      summary = describeEdit({ op: "remove_watch", name: edit.name });
      break;
    }
    case "set_webhook": {
      const recipe = checked(() => parseWebhook(edit.recipe));
      const at = file.webhooks.findIndex((other) => other.name === recipe.name);
      if (edit.was !== undefined && JSON.stringify(at < 0 ? null : file.webhooks[at]) !== JSON.stringify(edit.was)) throw new EditRefused(`the webhook recipe "${recipe.name}" has been changed since`);
      summary = describeEdit({ op: "set_webhook", recipe });
      if (at < 0) {
        list(doc, "webhooks").add(doc.createNode(recipe));
        inverse = { op: "remove_webhook", name: recipe.name, was: recipe };
      } else {
        list(doc, "webhooks").set(at, doc.createNode(recipe));
        inverse = { op: "set_webhook", recipe: file.webhooks[at], was: recipe };
      }
      break;
    }
    case "remove_webhook": {
      const at = file.webhooks.findIndex((other) => other.name === edit.name);
      if (at < 0) throw new EditRefused(`there is no webhook recipe named "${edit.name}" in the file. It holds: ${file.webhooks.map((other) => other.name).join(", ") || "none"}`);
      if (edit.was !== undefined && JSON.stringify(file.webhooks[at]) !== JSON.stringify(edit.was)) throw new EditRefused(`the webhook recipe "${edit.name}" has been changed since`);
      list(doc, "webhooks").delete(at);
      inverse = { op: "set_webhook", recipe: file.webhooks[at], was: null };
      summary = describeEdit({ op: "remove_webhook", name: edit.name });
      break;
    }
    case "set_composio": {
      const recipe = checked(() => parseComposioRecipe(edit.recipe));
      const at = file.composio.findIndex((other) => other.toolkit === recipe.toolkit);
      if (edit.was !== undefined && JSON.stringify(at < 0 ? null : file.composio[at]) !== JSON.stringify(edit.was)) throw new EditRefused(`the Composio recipe for "${recipe.toolkit}" has been changed since`);
      summary = describeEdit({ op: "set_composio", recipe });
      if (at < 0) {
        list(doc, "composio").add(doc.createNode(recipe));
        inverse = { op: "remove_composio", name: recipe.toolkit, was: recipe };
      } else {
        list(doc, "composio").set(at, doc.createNode(recipe));
        inverse = { op: "set_composio", recipe: file.composio[at], was: recipe };
        summary += `\nIt replaces the recipe as it is now:\n${describeComposioRecipe(file.composio[at])}`;
      }
      break;
    }
    case "remove_composio": {
      const at = file.composio.findIndex((other) => other.toolkit === edit.name);
      if (at < 0) throw new EditRefused(`there is no Composio recipe for "${edit.name}" in the file. It holds: ${file.composio.map((other) => other.toolkit).join(", ") || "none"}`);
      if (edit.was !== undefined && JSON.stringify(file.composio[at]) !== JSON.stringify(edit.was)) throw new EditRefused(`the Composio recipe for "${edit.name}" has been changed since`);
      list(doc, "composio").delete(at);
      inverse = { op: "set_composio", recipe: file.composio[at], was: null };
      summary = describeEdit({ op: "remove_composio", name: edit.name });
      break;
    }
    case "remove_standing": {
      const at = file.standing.findIndex((other) => other.name === edit.name);
      if (at < 0) throw new EditRefused(`there is no standing rule named "${edit.name}" in the file. It holds: ${file.standing.map((other) => other.name).join(", ") || "none"}`);
      if (edit.was !== undefined && !sameStanding(file.standing[at], edit.was)) throw new EditRefused(`the standing rule "${edit.name}" has been changed since`);
      list(doc, "standing").delete(at);
      inverse = { op: "set_standing", rule: file.standing[at], was: null };
      summary = describeEdit({ op: "remove_standing", name: edit.name });
      break;
    }
  }

  // A list an edit has emptied is written as `[]` on its key's line, as the starter file has it.
  for (const key of LIST_KEYS) {
    const node = doc.get(key, true);
    if (isSeq(node) && node.items.length === 0) node.flow = true;
  }
  const out = doc.toString();
  try {
    parseRuleFile(out);
  } catch (error) {
    throw new EditRefused(`the edit would leave the file unusable (${problemText(error)})`);
  }
  return { text: out, inverse, summary };
}
