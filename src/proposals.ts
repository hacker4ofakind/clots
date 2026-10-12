import type { ChatAdapter, InboundMessage } from "./chat/adapter.js";
import { ruleChannelName } from "./chat/names.js";
import { matchYesNo, RULE_REPLIES, RULE_RETRY } from "./events/reply.js";
import type { WriteResult } from "./rule-writer.js";
import type { RuleEdit, RuleScope } from "./rulebook-edit.js";
import type { ProposalRow, Store } from "./store.js";

/** What the Clot is told when its edit has been put to the user. */
export const PROPOSAL_FILED =
  "Filed as a proposal: the user is being asked in a separate channel. Do not wait for the answer, and do not say the rule is in force. You will be told the outcome at the start of a later turn.";

/** What the Clot is told when the user could not be asked. */
export const PROPOSAL_NOT_ASKED = "The user could not be asked just now. Put the suggestion in your reply instead.";

export interface ProposalsDeps {
  store: Store;
  chat: ChatAdapter;
  writer: {
    preview(clot: string, scope: RuleScope, edit: RuleEdit): WriteResult;
    apply(clot: string, scope: RuleScope, edit: RuleEdit): WriteResult;
  };
  userId: string;
  /** How many proposals a Clot may have open at once. */
  max: number;
  /** Posts in a Clot's live channel. Never throws. */
  say: (clot: string, text: string) => Promise<void>;
}

/** The first line of a summary: enough to name the edit in a sentence. */
const headline = (summary: string) => summary.split("\n")[0];

/**
 * Rule changes that wait for the user's yes: asked about in a temporary channel, answered
 * there to the daemon, and carried out by the daemon. The Clot that proposed one learns the
 * outcome from a note in front of its next turn.
 */
export class Proposals {
  /** Proposals are opened one at a time, so the limit and the check for a repeat cannot be raced. */
  private opening: Promise<unknown> = Promise.resolve();

  constructor(private d: ProposalsDeps) {}

  /** Puts an edit to the user. Returns what the tool tells the Clot. */
  open(clot: string, scope: RuleScope, edit: RuleEdit): Promise<string> {
    const result = this.opening.then(() => this.openOne(clot, scope, edit));
    this.opening = result.catch(() => undefined);
    return result;
  }

  private async openOne(clot: string, scope: RuleScope, edit: RuleEdit): Promise<string> {
    const { store, chat } = this.d;
    // An edit that could not be made is not worth the user's attention.
    const preview = this.d.writer.preview(clot, scope, edit);
    if (!preview.ok) return `Not proposed: ${preview.reason}.`;
    const row = store.getClot(clot);
    if (!row) return PROPOSAL_NOT_ASKED;

    const json = JSON.stringify(edit);
    const open = store.openProposals(clot);
    if (open.some((other) => other.scope === scope && other.edit === json)) return "This is already with the user, waiting for their answer.";
    if (open.length >= this.d.max) return `Not proposed: ${open.length} proposals are already waiting for the user's answer. Mention this one in your reply instead.`;

    let channelId: string;
    let channelName: string;
    try {
      channelName = ruleChannelName(clot, await chat.listChannelNames(row.categoryId));
      channelId = await chat.createChannel(row.categoryId, channelName);
    } catch {
      return PROPOSAL_NOT_ASKED;
    }
    const id = store.createProposal({ clot, channelId, channelName, scope, edit: json, summary: preview.summary });
    try {
      await chat.post(channelId, `${chat.mention(this.d.userId)} ${clot} proposes a change to \`${preview.file}.yaml\`:\n\n${preview.summary}\n\n${RULE_REPLIES}`);
    } catch {
      if (store.deleteProposal(id)) await chat.deleteChannel(channelId).catch(() => undefined);
      return PROPOSAL_NOT_ASKED;
    }
    return PROPOSAL_FILED;
  }

  /** Handles a message in a proposal's channel. Returns false when the channel is not one, so the message belongs elsewhere. */
  async onReply(m: InboundMessage): Promise<boolean> {
    const proposal = this.d.store.proposalByChannel(m.channelId);
    if (!proposal) return false;
    if (m.authorId !== this.d.userId) return true;
    const answer = matchYesNo(m.text);
    if (answer === undefined) {
      await this.d.chat.post(m.channelId, RULE_RETRY).catch(() => undefined);
      return true;
    }
    await this.resolve(proposal, answer);
    return true;
  }

  /** Closes a Clot's open proposals as unanswered. Called when its session has been replaced: a proposal lasts as long as its session. */
  async closeForSession(clot: string): Promise<void> {
    await this.withdraw(clot, this.d.store.openProposals(clot), "when the previous session closed");
  }

  /** Closes the proposals whose channel no longer exists. Called once at startup. */
  async closeOrphans(): Promise<void> {
    const byClot = new Map<string, ProposalRow[]>();
    for (const proposal of this.d.store.openProposals()) byClot.set(proposal.clot, [...(byClot.get(proposal.clot) ?? []), proposal]);
    for (const [clot, open] of byClot) {
      const row = this.d.store.getClot(clot);
      if (!row) continue;
      const names = await this.d.chat.listChannelNames(row.categoryId).catch(() => undefined);
      // Not knowing which channels exist is no reason to close anything.
      if (names === undefined) continue;
      await this.withdraw(clot, open.filter((proposal) => !names.includes(proposal.channelName)), "when their channel was removed");
    }
  }

  private async withdraw(clot: string, open: ProposalRow[], when: string): Promise<void> {
    const closed: string[] = [];
    for (const proposal of open) {
      // Closed first, and only whoever closed it goes on: an answer given a moment ago stands.
      if (!this.d.store.deleteProposal(proposal.id)) continue;
      closed.push(headline(proposal.summary));
      await this.d.chat.deleteChannel(proposal.channelId).catch(() => undefined);
    }
    if (closed.length > 0) this.d.store.addNote(clot, `These rule changes you proposed were still unanswered ${when}, and were withdrawn: ${closed.join("; ")}`);
  }

  private async resolve(proposal: ProposalRow, answer: "yes" | "no"): Promise<void> {
    const { store } = this.d;
    if (!store.deleteProposal(proposal.id)) return;
    const what = headline(proposal.summary);
    if (answer === "no") {
      store.addNote(proposal.clot, `The user declined the rule change you proposed: ${what}. Do not propose it again.`);
      await this.d.say(proposal.clot, `Declined: ${what}`);
    } else {
      // Applied to the file as it is now, which may not be as it was when the question was asked.
      const done = this.d.writer.apply(proposal.clot, proposal.scope, JSON.parse(proposal.edit) as RuleEdit);
      if (done.ok) {
        store.addNote(proposal.clot, `The user approved the rule change you proposed, and it is in force: ${what}`);
        await this.d.say(proposal.clot, `Approved. Rule change in \`${done.file}.yaml\`: ${done.summary}`);
      } else {
        store.addNote(proposal.clot, `The user approved the rule change you proposed, but it could not be applied (${done.reason}): ${what}`);
        await this.d.say(proposal.clot, `Approved, but it could not be applied (${done.reason}), so nothing was changed: ${what}`);
      }
    }
    await this.d.chat.deleteChannel(proposal.channelId).catch(() => undefined);
  }
}
