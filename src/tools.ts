import { threadNumber, type Sender } from "./events/github-comment.js";
import type { ClotEvent } from "./events/types.js";
import type { WriteResult } from "./rule-writer.js";
import { describeMatch, describeStanding, type RuleEdit, type RuleScope } from "./rulebook-edit.js";
import type { Prefilter, RuleFile, StandingRule } from "./rulebook.js";
import { checkSend, matchStanding, MAX_CHANGED_WORDS } from "./standing.js";
import type { Store } from "./store.js";

/** A working turn the user started, a turn in brainstorm mode, or the investigation of an event. */
export type TurnKind = "work" | "brainstorm" | "investigation";

/** What the daemon's tools know about the turn they were made for. */
export interface TurnContext {
  clot: string;
  kind: TurnKind;
  /** Whether a steered event has joined the turn. Asked at each call: it can become true while the turn runs. */
  steered: () => boolean;
  /** The event an investigation was started for. */
  event?: ClotEvent;
}

/** The daemon's tools for one turn. Each returns the text the Clot is given as the tool's result. */
export interface DaemonTools {
  show(): Promise<string>;
  prefilter(a: { action: "add" | "remove"; file: RuleScope; rule: Prefilter }): Promise<string>;
  guidance(a: { action: "add" | "remove"; file: RuleScope; line: string }): Promise<string>;
  standing(a: { action: "set" | "remove"; file: RuleScope; name: string; trigger?: StandingRule["trigger"]; template?: string }): Promise<string>;
  send(a: { rule: string; text?: string }): Promise<string>;
}

export interface ToolDeps {
  rulebook: { file(name: string): RuleFile; standingFor(clot: string): StandingRule[] };
  writer: { apply(clot: string, scope: RuleScope, edit: RuleEdit): WriteResult };
  proposals: { open(clot: string, scope: RuleScope, edit: RuleEdit): Promise<string> };
  store: Store;
  /** One way of sending for each value of a standing rule's `via`. */
  senders: Record<StandingRule["via"], Sender>;
  /** Posts in a Clot's live channel. Never throws. */
  say: (clot: string, text: string) => Promise<void>;
}

/** The longest text of its own a Clot may hand to a send. A template is at most 2,000 characters. */
const MAX_SEND_TEXT = 4000;

/**
 * Whether an edit must be put to the user instead of being applied. Applied at once is only a
 * pre-filter or a triage line in the Clot's own file, in a working turn the user started that
 * no steered event has joined. The Clot has no say in this.
 */
export function mustPropose(ctx: TurnContext, file: RuleScope, edit: RuleEdit): boolean {
  if (file === "global") return true;
  if (edit.op === "set_standing" || edit.op === "remove_standing") return true;
  return ctx.kind !== "work" || ctx.steered();
}

/** The rules in force for a Clot and its open proposals, as text for the Clot and for `&rules`. */
export function showRules(d: Pick<ToolDeps, "rulebook" | "store">, clot: string): string {
  const files = [
    { name: "global", file: d.rulebook.file("global") },
    { name: clot, file: d.rulebook.file(clot) },
  ];
  // A global standing rule gives way to the Clot's own rule of the same name.
  const inForce = new Set(d.rulebook.standingFor(clot));
  const section = (title: string, lines: string[]) => `${title}\n${lines.length > 0 ? lines.join("\n") : "- none"}`;
  return [
    `Rules in force for ${clot}`,
    section("Pre-filters (matching events are dropped):", files.flatMap(({ name, file }) => file.prefilters.map((rule) => `- [${name}] ${describeMatch(rule)}`))),
    section("Triage guidance:", files.flatMap(({ name, file }) => file.triage.map((line) => `- [${name}] ${line}`))),
    section("Standing rules:", files.flatMap(({ name, file }) => file.standing.filter((rule) => inForce.has(rule)).map((rule) => `- [${name}] ${describeStanding(rule)}`))),
    section("Open proposals, waiting for the user:", d.store.openProposals(clot).map((proposal) => `- ${proposal.summary.split("\n")[0]}`)),
  ].join("\n\n");
}

export function makeTools(d: ToolDeps, ctx: TurnContext): DaemonTools {
  const submit = async (file: RuleScope, edit: RuleEdit): Promise<string> => {
    if (mustPropose(ctx, file, edit)) return d.proposals.open(ctx.clot, file, edit);
    const done = d.writer.apply(ctx.clot, file, edit);
    if (!done.ok) return `Not applied: ${done.reason}.`;
    await d.say(ctx.clot, `Rule change in \`${done.file}.yaml\`: ${done.summary}`);
    return `Applied, and in force now. The user has been shown it: ${done.summary}`;
  };

  return {
    show: async () => showRules(d, ctx.clot),

    prefilter: ({ action, file, rule }) => submit(file, { op: action === "add" ? "add_prefilter" : "remove_prefilter", rule }),

    guidance: ({ action, file, line }) => submit(file, { op: action === "add" ? "add_guidance" : "remove_guidance", line }),

    standing: async ({ action, file, name, trigger, template }) => {
      if (action === "remove") return submit(file, { op: "remove_standing", name });
      if (trigger === undefined || template === undefined) return "Not proposed: a standing rule needs a trigger and a template.";
      return submit(file, { op: "set_standing", rule: { name, trigger, via: "github_comment", template } });
    },

    send: async ({ rule, text }) => {
      const event = ctx.event;
      if (ctx.kind !== "investigation" || event === undefined) return "Refused: a standing rule can be used only while looking into the event that triggered it.";
      const parts = event.kind === "batch" ? d.store.eventsMergedInto(event.id) : [];
      const match = matchStanding(d.rulebook.standingFor(ctx.clot), event, parts).find((candidate) => candidate.rule.name === rule);
      if (!match) return `Refused: no standing rule named "${rule}" applies to the event this turn is looking into.`;
      if (threadNumber(event.subject) === undefined) return "Refused: this event is about a branch, not an issue or a pull request, so there is nowhere to send.";
      if (d.store.hasSend(event.id, rule)) return "Refused: this rule has already been sent for this event.";
      if (text !== undefined && text.length > MAX_SEND_TEXT) return "Refused: your text is too long to be a version of the template.";
      const checked = checkSend(match.filled, text);
      if (!checked.ok) return `Refused: your text differs from the template by ${checked.count} words, and at most ${MAX_CHANGED_WORDS} may differ. The template reads: ${match.filled}`;
      // Recorded before it is sent: a daemon that stops in between has lost a send, and has never sent one twice.
      if (!d.store.claimSend(event.id, rule)) return "Refused: this rule has already been sent for this event.";
      const sent = await d.senders[match.rule.via].send(event, checked.text);
      if (!sent.ok) {
        if (sent.refused) {
          d.store.releaseSend(event.id, rule);
          return `Not sent: ${sent.reason}.`;
        }
        return `Not sent as far as can be told: ${sent.reason}. It may or may not have been posted, so it will not be tried again. Tell the user.`;
      }
      d.store.setSendUrl(event.id, rule, sent.url);
      await d.say(ctx.clot, `Sent under standing rule \`${rule}\`: ${checked.text} <${sent.url}>`);
      return `Sent: ${sent.url}`;
    },
  };
}
