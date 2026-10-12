import { isScalar, isSeq, parseDocument, YAMLSeq, type Document } from "yaml";
import { parsePrefilter, parseRuleFile, parseStanding, problemText, type Prefilter, type RuleFile, type StandingRule } from "./rulebook.js";

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
  | { op: "remove_standing"; name: string; was?: StandingRule };

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
  if (rule.kind !== undefined) parts.push(`kind is \`${rule.kind}\``);
  if (rule.actor !== undefined) parts.push(`actor is \`${rule.actor}\``);
  if (rule.repo !== undefined) parts.push(`repository is \`${rule.repo}\``);
  if (rule.titleContains !== undefined) parts.push(`title contains "${rule.titleContains}"`);
  return parts.join(" and ");
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
  }
}

/** The fields in a fixed order and nothing undefined, so that the same rule is always written the same way. */
function tidy<T extends Prefilter>(rule: T): T {
  const out: Record<string, string> = {};
  for (const key of ["kind", "actor", "repo", "titleContains"] as const) {
    const value = rule[key];
    if (value !== undefined) out[key] = value;
  }
  return out as T;
}

function samePrefilter(a: Prefilter, b: Prefilter): boolean {
  const fold = (text: string | undefined) => text?.toLowerCase();
  return a.kind === b.kind && fold(a.actor) === fold(b.actor) && fold(a.repo) === fold(b.repo) && fold(a.titleContains) === fold(b.titleContains);
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
  for (const key of ["prefilters", "triage", "standing"]) {
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
