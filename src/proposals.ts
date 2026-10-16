import type { ChatAdapter, InboundMessage } from "./chat/adapter.js";
import { calChannelName, ruleChannelName } from "./chat/names.js";
import { CAL_REPLIES, CAL_RETRY, matchYesNo, RULE_REPLIES, RULE_RETRY } from "./events/reply.js";
import { UNLOGGED_NOTE, type WriteResult } from "./rule-writer.js";
import type { RuleEdit, RuleScope } from "./rulebook-edit.js";
import type { ProposalRow, Store } from "./store.js";

/** What the Clot is told when its edit has been put to the user. */
export const PROPOSAL_FILED =
  "Filed as a proposal: the user is being asked in a separate channel. Do not wait for the answer, and do not say the rule is in force. You will be told the outcome at the start of a later turn.";

/** What the Clot is told when the user could not be asked. */
export const PROPOSAL_NOT_ASKED = "The user could not be asked just now. Put the suggestion in your reply instead.";

/** Removing one event from one calendar. */
export interface CalendarRemoval {
  account: string;
  uid: string;
}

export interface ProposalsDeps {
  /** Looks at and removes calendar events. Absent when no calendar can be changed. */
  calendar?: {
    /** The event as the user will be shown it, when it can be removed. */
    preview(removal: CalendarRemoval): Promise<{ ok: true; summary: string } | { ok: false; reason: string }>;
    /** `retry`: the script could not be reached, and nothing was removed. */
    remove(removal: CalendarRemoval): Promise<{ ok: true; summary: string } | { ok: false; reason: string; retry?: true }>;
  };
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

  /** Gives the proposals a calendar to remove events from, once the daemon has set one up. */
  useCalendar(calendar: NonNullable<ProposalsDeps["calendar"]>): void {
    this.d = { ...this.d, calendar };
  }

  /** Puts an edit to the user. Returns what the tool tells the Clot. */
  open(clot: string, scope: RuleScope, edit: RuleEdit): Promise<string> {
    const result = this.opening.then(() => this.openOne(clot, scope, edit));
    this.opening = result.catch(() => undefined);
    return result;
  }

  private async openOne(clot: string, scope: RuleScope, edit: RuleEdit): Promise<string> {
    // An edit that could not be made is not worth the user's attention.
    const preview = this.d.writer.preview(clot, scope, edit);
    if (!preview.ok) return `Not proposed: ${preview.reason}.`;
    return this.ask(clot, scope, JSON.stringify(edit), preview.summary, ruleChannelName, `proposes a change to \`${preview.file}.yaml\`:\n\n${preview.summary}\n\n${RULE_REPLIES}`);
  }

  /** Puts the removal of a calendar event to the user. Returns what the tool tells the Clot. */
  openRemoval(clot: string, removal: CalendarRemoval): Promise<string> {
    const result = this.opening.then(() => this.openRemovalOne(clot, removal));
    this.opening = result.catch(() => undefined);
    return result;
  }

  private async openRemovalOne(clot: string, removal: CalendarRemoval): Promise<string> {
    if (this.d.calendar === undefined) return "Not proposed: the calendar cannot be changed from this daemon.";
    const preview = await this.d.calendar.preview(removal);
    if (!preview.ok) return `Not proposed: ${preview.reason}.`;
    return this.ask(clot, "calendar", JSON.stringify(removal), preview.summary, calChannelName, `asks to remove this event from your calendar:\n\n${preview.summary}\n\n${CAL_REPLIES}`);
  }

  /** Opens the temporary channel and asks. Shared by rule changes and calendar removals. */
  private async ask(clot: string, scope: ProposalRow["scope"], json: string, summary: string, name: (clot: string, existing: string[]) => string, question: string): Promise<string> {
    const { store, chat } = this.d;
    const row = store.getClot(clot);
    if (!row) return PROPOSAL_NOT_ASKED;
    const open = store.openProposals(clot);
    if (open.some((other) => other.scope === scope && other.edit === json)) return "This is already with the user, waiting for their answer.";
    if (open.length >= this.d.max) return `Not proposed: ${open.length} proposals are already waiting for the user's answer. Mention this one in your reply instead.`;

    let channelId: string;
    let channelName: string;
    try {
      channelName = name(clot, await chat.listChannelNames(row.categoryId));
      channelId = await chat.createChannel(row.categoryId, channelName);
    } catch {
      return PROPOSAL_NOT_ASKED;
    }
    const id = store.createProposal({ clot, channelId, channelName, sessionId: store.activeSession(clot)?.id ?? null, scope, edit: json, summary });
    try {
      await chat.post(channelId, `${chat.mention(this.d.userId)} ${clot} ${question}`);
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
    // A proposal lasts as long as its session. One left over from a session that has been
    // replaced is withdrawn here, whatever the reply: startup may not have got to it yet.
    const session = this.d.store.activeSession(proposal.clot)?.id;
    if (proposal.sessionId !== null && session !== undefined && proposal.sessionId !== session) {
      await this.withdraw(proposal.clot, [proposal], "when the previous session closed");
      return true;
    }
    const answer = matchYesNo(m.text);
    if (answer === undefined) {
      await this.d.chat.post(m.channelId, proposal.scope === "calendar" ? CAL_RETRY : RULE_RETRY).catch(() => undefined);
      return true;
    }
    await this.resolve(proposal, answer);
    return true;
  }

  /** Closes a Clot's open proposals as unanswered. Called when its session has been replaced: a proposal lasts as long as its session. */
  async closeForSession(clot: string): Promise<void> {
    await this.withdraw(clot, this.d.store.openProposals(clot), "when the previous session closed");
  }

  /**
   * Closes the proposals that can no longer be answered. Called once at startup: those of a
   * session that was replaced while the daemon was stopping, and those whose channel is gone.
   */
  async closeOrphans(): Promise<void> {
    const byClot = new Map<string, ProposalRow[]>();
    for (const proposal of this.d.store.openProposals()) byClot.set(proposal.clot, [...(byClot.get(proposal.clot) ?? []), proposal]);
    for (const [clot, open] of byClot) {
      const session = this.d.store.activeSession(clot)?.id;
      const stale = open.filter((proposal) => session !== undefined && proposal.sessionId !== null && proposal.sessionId !== session);
      await this.withdraw(clot, stale, "when the previous session closed");

      const gone: ProposalRow[] = [];
      for (const proposal of open.filter((other) => !stale.includes(other))) {
        // The channel itself, not its name: a renamed channel is still the place to answer, and a new one of the same name is not.
        // Not knowing whether it exists is no reason to close anything.
        const exists = await this.d.chat.channelExists(proposal.channelId).catch(() => undefined);
        if (exists === false) gone.push(proposal);
      }
      await this.withdraw(clot, gone, "when their channel was removed");
    }
  }

  private async withdraw(clot: string, open: ProposalRow[], when: string): Promise<void> {
    // Closed in one step before any channel is touched, so stopping part-way leaves none of them
    // answerable. Only those this call closed go on: an answer given a moment ago stands.
    const closed = this.d.store.withdrawProposals(
      clot,
      open,
      (rows) => `These rule changes you proposed were still unanswered ${when}, and were withdrawn: ${rows.map((row) => headline(row.summary)).join("; ")}`,
    );
    for (const proposal of closed) await this.d.chat.deleteChannel(proposal.channelId).catch(() => undefined);
  }

  private async resolve(proposal: ProposalRow, answer: "yes" | "no"): Promise<void> {
    const { store } = this.d;
    if (!store.deleteProposal(proposal.id)) return;
    if (proposal.scope === "calendar") return this.resolveRemoval(proposal, answer);
    const what = headline(proposal.summary);
    if (answer === "no") {
      store.addNote(proposal.clot, `The user declined the rule change you proposed: ${what}. Do not propose it again.`);
      await this.d.say(proposal.clot, `Declined: ${what}`);
    } else {
      // Applied to the file as it is now, which may not be as it was when the question was asked.
      let done: WriteResult;
      try {
        done = this.d.writer.apply(proposal.clot, proposal.scope, JSON.parse(proposal.edit) as RuleEdit);
      } catch (error) {
        // Whether the file was changed is not known, so the edit is not tried again.
        console.error(`[${proposal.clot}] applying an approved rule change failed:`, error);
        done = { ok: false, reason: `it failed in an unexpected way (${error instanceof Error ? error.message : String(error)}); check the file` };
      }
      if (!done.ok && done.retry) {
        // Nothing was changed and the cause was not the edit: the question is open again, in the same channel.
        const { id: _id, ...again } = proposal;
        store.createProposal(again);
        await this.d.chat.post(proposal.channelId, `That could not be applied just now (${done.reason}), and nothing was changed. Reply \`yes\` to try again, or \`no\` to decline it.`).catch(() => undefined);
        return;
      }
      if (done.ok) {
        store.addNote(proposal.clot, `The user approved the rule change you proposed, and it is in force: ${what}`);
        await this.d.say(proposal.clot, `Approved. Rule change in \`${done.file}.yaml\`: ${done.summary}${done.unlogged ? `\n${UNLOGGED_NOTE}` : ""}`);
      } else {
        store.addNote(proposal.clot, `The user approved the rule change you proposed, but it could not be applied (${done.reason}): ${what}`);
        await this.d.say(proposal.clot, `Approved, but it could not be applied (${done.reason}), so nothing was changed: ${what}`);
      }
    }
    await this.d.chat.deleteChannel(proposal.channelId).catch(() => undefined);
  }

  /** Carries out the user's answer about removing a calendar event. The proposal is already closed. */
  private async resolveRemoval(proposal: ProposalRow, answer: "yes" | "no"): Promise<void> {
    const { store } = this.d;
    const what = headline(proposal.summary);
    if (answer === "no") {
      store.addNote(proposal.clot, `The user declined removing this event from the calendar, and it stays: ${what}. Do not ask again.`);
      await this.d.say(proposal.clot, `Kept in the calendar: ${what}`);
    } else {
      const removal = JSON.parse(proposal.edit) as CalendarRemoval;
      const done = this.d.calendar === undefined ? { ok: false as const, reason: "the calendar cannot be changed from this daemon" } : await this.d.calendar.remove(removal).catch((error: unknown) => ({ ok: false as const, reason: error instanceof Error ? error.message : String(error), retry: true as const }));
      if (!done.ok && "retry" in done && done.retry) {
        // Nothing was removed and the cause was not the event: the question is open again, in the same channel.
        const { id: _id, ...again } = proposal;
        store.createProposal(again);
        await this.d.chat.post(proposal.channelId, `That could not be done just now (${done.reason}), and nothing was removed. Reply \`yes\` to try again, or \`no\` to keep the event.`).catch(() => undefined);
        return;
      }
      if (done.ok) {
        store.addNote(proposal.clot, `The user approved removing this event, and it is gone from the calendar: ${what}`);
        await this.d.say(proposal.clot, `Removed from the calendar: ${done.summary}`);
      } else {
        store.addNote(proposal.clot, `The user approved removing this event, but it could not be removed (${done.reason}): ${what}`);
        await this.d.say(proposal.clot, `Approved, but it could not be removed (${done.reason}): ${what}`);
      }
    }
    await this.d.chat.deleteChannel(proposal.channelId).catch(() => undefined);
  }
}
