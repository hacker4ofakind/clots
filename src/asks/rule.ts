import type { AskKind, Asks } from "../asks.js";
import { ruleChannelName } from "../chat/names.js";
import { matchYesNo, RULE_REPLIES, RULE_RETRY } from "../events/reply.js";
import { UNLOGGED_NOTE, type WriteResult } from "../rule-writer.js";
import type { RuleEdit, RuleScope } from "../rulebook-edit.js";

/** What the Clot is told when its edit has been put to the user. */
export const RULE_FILED =
  "Put to the user in a separate channel. Do not wait for the answer, and do not say the rule is in force. You will be told the outcome at the start of a later turn.";

export interface RulePayload {
  scope: RuleScope;
  edit: RuleEdit;
  /** The file it changes: "global" or the Clot's name. */
  file: string;
  /** What the user is shown, in full. */
  text: string;
}

export interface RuleKindDeps {
  writer: {
    preview(clot: string, scope: RuleScope, edit: RuleEdit): WriteResult;
    apply(clot: string, scope: RuleScope, edit: RuleEdit): WriteResult;
  };
  store: { addNote(clot: string, text: string): void };
}

/** The first line of a summary: enough to name the edit in a sentence. */
const headline = (summary: string) => summary.split("\n")[0];

/**
 * A rule change that waits for the user's yes: a standing rule, or any edit from a turn an
 * outsider's text started. A yes applies it, a no declines it, and anything else repeats the
 * question. It stays open until answered, across rollovers.
 */
export function ruleKind(d: RuleKindDeps): AskKind<RulePayload> {
  return {
    kind: "rule",
    channelName: ruleChannelName,
    render: (_clot, p) => `asks for a change to \`${p.file}.yaml\`:\n\n${p.text}\n\n${RULE_REPLIES}`,
    texts: {
      filed: RULE_FILED,
      already: "This is already with the user, waiting for their answer.",
      full: (n) => `Not asked: ${n} rule changes already wait for the user's answer. Mention this one in your reply instead.`,
      notAsked: (reason) => `The user could not be asked just now${reason ? ` (${reason})` : ""}. Put the suggestion in your reply instead.`,
    },

    async onReply(ask, text, io) {
      const answer = matchYesNo(text);
      if (answer === undefined) return io.repeat(RULE_RETRY);
      const what = headline(ask.payload.text);
      if (answer === "no") {
        await io.close(`The user declined the rule change you asked for: ${what}. Do not ask for it again.`, `Declined: ${what}`);
        return;
      }
      if (!io.setBusy()) return;
      // Applied to the file as it is now, which may not be as it was when the question was asked.
      let done: WriteResult;
      try {
        done = d.writer.apply(ask.clot, ask.payload.scope, ask.payload.edit);
      } catch (error) {
        // Whether the file was changed is not known, so the edit is not tried again.
        console.error(`[${ask.clot}] applying an approved rule change failed:`, error);
        done = { ok: false, reason: `it failed in an unexpected way (${error instanceof Error ? error.message : String(error)}); check the file` };
      }
      if (!done.ok && done.retry) {
        // Nothing was changed and the cause was not the edit: the question is open again, in the same channel.
        io.reopen();
        await io.repeat(`That could not be applied just now (${done.reason}), and nothing was changed. Reply \`yes\` to try again, or \`no\` to decline it.`);
        return;
      }
      if (done.ok) {
        await io.close(`The user approved the rule change you asked for, and it is in force: ${what}`, `Approved. Rule change in \`${done.file}.yaml\`: ${done.summary}\n\`&rules undo\` takes it back.${done.unlogged ? `\n${UNLOGGED_NOTE}` : ""}`);
      } else {
        await io.close(`The user approved the rule change you asked for, but it could not be applied (${done.reason}): ${what}`, `Approved, but it could not be applied (${done.reason}), so nothing was changed: ${what}`);
      }
    },
  };
}

/** Opens a rule ask for an edit. Returns what the tool tells the Clot. */
export function askRule(asks: Asks, kind: AskKind<RulePayload>, d: RuleKindDeps & { max: number }, clot: string, scope: RuleScope, edit: RuleEdit, outsider: boolean): Promise<string> {
  // An edit that could not be made is not worth the user's attention.
  const preview = d.writer.preview(clot, scope, edit);
  if (!preview.ok) return Promise.resolve(`Not asked: ${preview.reason}.`);
  return asks.open(kind, clot, { scope, edit, file: preview.file, text: preview.summary }, { summary: `Rule change: ${headline(preview.summary)}`, dedupe: `${scope}:${JSON.stringify(edit)}`, max: d.max, outsider });
}
