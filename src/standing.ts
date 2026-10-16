import type { ClotEvent } from "./events/types.js";
import { matchesPrefilter, type StandingRule, type TemplateField, type Via } from "./rulebook.js";

/** Whether an "@" written in plain text notifies someone where a way of sending posts. Only GitHub reads it so. */
export function mentionsNotify(via: Via): boolean {
  return via === "github_comment";
}

/** A send may differ from its filled-in template by this many words. */
export const MAX_CHANGED_WORDS = 5;

/** After an "@" it keeps GitHub from reading a mention, and shows as nothing. */
const ZERO_WIDTH = "​";

/** Writes every "@" so that it mentions nobody. */
export function defuse(text: string): string {
  return text.replace(/@(?!​)/g, `@${ZERO_WIDTH}`);
}

/**
 * The template with its fields filled from the event. An "@" the template wrote stays a
 * mention; one that comes in with a value (a title is the reporter's text) does not.
 */
export function fillTemplate(template: string, event: ClotEvent, mentions = true): string {
  return template.replace(/\{(actor|title|ref|place|repo|url)\}/g, (_whole, field: TemplateField) => {
    const value = field === "repo" || field === "place" ? event.place : event[field];
    return mentions ? defuse(value) : value;
  });
}

/** A standing rule that applies to an event, with its text ready to send. */
export interface StandingMatch {
  rule: StandingRule;
  /** The event the template was filled from: the event itself, or for a batch one of its reports. */
  from: ClotEvent;
  filled: string;
}

/**
 * The standing rules that apply to an event. A batch matches a rule when any of the reports it
 * was made from does; the template is then filled from the earliest of them. A trigger that names
 * no source is GitHub's, as every rule written before other sources existed is.
 */
export function matchStanding(rules: StandingRule[], event: ClotEvent, parts: ClotEvent[]): StandingMatch[] {
  const candidates = event.kind === "batch" ? [...parts].sort((a, b) => a.receivedAt - b.receivedAt) : [event];
  const matches: StandingMatch[] = [];
  for (const rule of rules) {
    const trigger = { ...rule.trigger, source: rule.trigger.source ?? "github" };
    const from = candidates.find((candidate) => matchesPrefilter(trigger, candidate));
    if (from) matches.push({ rule, from, filled: fillTemplate(rule.template, from, mentionsNotify(rule.via)) });
  }
  return matches;
}

const bare = (word: string) => word.replaceAll(ZERO_WIDTH, "");

/**
 * The smallest number of words added, removed or replaced that turns `from` into `to`, and for
 * each word of `to` the place in `from` it was kept from (undefined when it is new or changed).
 */
export function wordEdits(from: string[], to: string[]): { count: number; kept: (number | undefined)[] } {
  const n = from.length;
  const m = to.length;
  const d: number[][] = [];
  for (let i = 0; i <= n; i += 1) {
    d.push(new Array<number>(m + 1).fill(0));
    d[i][0] = i;
  }
  for (let j = 0; j <= m; j += 1) d[0][j] = j;
  for (let i = 1; i <= n; i += 1) {
    for (let j = 1; j <= m; j += 1) {
      const same = bare(from[i - 1]) === bare(to[j - 1]);
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (same ? 0 : 1));
    }
  }

  // Walk back through the table. Where several ways cost the same, a removal or an addition is
  // taken before a replacement, so that a word both texts have is found as kept.
  const kept = new Array<number | undefined>(m).fill(undefined);
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    if (bare(from[i - 1]) === bare(to[j - 1]) && d[i][j] === d[i - 1][j - 1]) {
      kept[j - 1] = i - 1;
      i -= 1;
      j -= 1;
    } else if (d[i][j] === d[i - 1][j] + 1) {
      i -= 1;
    } else if (d[i][j] === d[i][j - 1] + 1) {
      j -= 1;
    } else {
      i -= 1;
      j -= 1;
    }
  }
  return { count: d[n][m], kept };
}

/**
 * Decides what a send may say. Without text of the Clot's own it is the filled-in template.
 * With it, the text may differ by at most five words. A word the template has is written as
 * the template has it; a word the Clot brought cannot mention anyone.
 */
export function checkSend(filled: string, text: string | undefined, mentions = true): { ok: true; text: string } | { ok: false; count: number } {
  if (text === undefined || text.trim() === "") return { ok: true, text: filled };
  const from = filled.trim().split(/\s+/);
  // Words at the even places, the white space between them at the odd ones.
  const tokens = text.trim().split(/(\s+)/);
  const to = tokens.filter((_token, at) => at % 2 === 0);
  const { count, kept } = wordEdits(from, to);
  if (count > MAX_CHANGED_WORDS) return { ok: false, count };
  const out = tokens.map((token, at) => {
    if (at % 2 === 1) return token;
    const source = kept[at / 2];
    if (source !== undefined) return from[source];
    return mentions ? defuse(token) : token;
  });
  return { ok: true, text: out.join("") };
}
