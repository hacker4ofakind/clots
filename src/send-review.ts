import type { ChatAdapter, InboundMessage } from "./chat/adapter.js";
import { mailChannelName } from "./chat/names.js";
import type { EmailAccount } from "./config.js";
import { recordDraft } from "./drafts.js";
import { matchSendReply, SEND_REPLIES } from "./events/reply.js";
import { ownMessageKey, type OutgoingMail } from "./sources/email.js";
import type { MailSent } from "./sources/smtp.js";
import type { SendReviewRow, Store } from "./store.js";

/** An email a Clot asks to send: from which account, answering which email, if any. */
export interface SendRequest {
  account: string;
  event?: string;
  mail: OutgoingMail;
}

/** What the Clot is told when its email has been put to the user. */
export const SEND_FILED =
  "Filed for review: the user is shown the email in a separate channel and sends it, drops it, saves it as a draft, or gives feedback. Nothing has been sent. Do not wait for the answer, and do not say it was sent. You will be told the outcome; feedback comes to you as a message from the user.";

export interface SendReviewsDeps {
  store: Store;
  chat: ChatAdapter;
  userId: string;
  accounts: EmailAccount[];
  /** How many send reviews a Clot may have open at once. */
  max: number;
  /** How long a review waits for the user's answer before it is withdrawn. */
  maxMs: number;
  now: () => number;
  /** Sends a message as the user. */
  send: (account: EmailAccount, mail: OutgoingMail) => Promise<MailSent>;
  /** Puts a message in the account's Drafts folder. */
  saveDraft: (account: EmailAccount, mail: OutgoingMail) => Promise<{ mailbox: string }>;
  /** Hands the user's feedback to the Clot as a message the user typed in its live channel. False when it could not. */
  feedback: (clot: string, text: string) => Promise<boolean>;
  /** Posts in a Clot's live channel. Never throws. */
  say: (clot: string, text: string) => Promise<void>;
}

const quote = (text: string) => `> ${text.split("\n").join("\n> ")}`;

/** A length of time in the largest whole-ish unit: "3 days", "1.5 days", "2 hours", "1 minute". */
export function span(ms: number): string {
  const [size, unit] = ms >= 86_400_000 ? [ms / 86_400_000, "day"] : ms >= 3_600_000 ? [ms / 3_600_000, "hour"] : [Math.max(ms / 60_000, 1), "minute"];
  const n = Math.round(size * 10) / 10;
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
}

/** One line that names an email: its recipients, subject and account. */
export function mailHeadline(mail: OutgoingMail, account: string): string {
  return `to ${mail.to.join(", ")}, "${mail.subject}" (${account})`;
}

/** The email as the user reviews it: its headers, then its text. */
export function describeMail(mail: OutgoingMail): string {
  return [`From: ${mail.from}`, `To: ${mail.to.join(", ")}`, `Subject: ${mail.subject}`, "", quote(mail.text)].join("\n");
}

/**
 * Emails a Clot asks to send. Each is shown to the user in a temporary channel and answered
 * there to the daemon: the daemon sends it on a yes, drops it on a no, saves it as a draft,
 * or hands any other reply to the Clot as feedback, whose revision opens a new review.
 */
export class SendReviews {
  /** Reviews are opened one at a time, so the limit and the check for a repeat cannot be raced. */
  private opening: Promise<unknown> = Promise.resolve();

  constructor(private d: SendReviewsDeps) {}

  /** Puts an email to the user. Returns what the tool tells the Clot. */
  open(clot: string, req: SendRequest): Promise<string> {
    const result = this.opening.then(() => this.openOne(clot, req));
    this.opening = result.catch(() => undefined);
    return result;
  }

  private async openOne(clot: string, req: SendRequest): Promise<string> {
    const { store, chat } = this.d;
    const row = store.getClot(clot);
    if (!row) return "The user could not be asked just now. Put the email in your reply instead.";
    const open = store.openSendReviews(clot);
    const same = (other: SendReviewRow) => {
      const mail = JSON.parse(other.mail) as OutgoingMail;
      return other.account === req.account && mail.subject === req.mail.subject && mail.text === req.mail.text && mail.to.join() === req.mail.to.join();
    };
    if (open.some(same)) return "This email is already with the user, waiting for their answer.";
    if (open.length >= this.d.max) return `Not filed: ${open.length} emails already wait for the user's answer. Put this one in your reply instead.`;

    let channelId: string;
    try {
      channelId = await chat.createChannel(row.categoryId, mailChannelName(clot, await chat.listChannelNames(row.categoryId)));
    } catch {
      return "The user could not be asked just now. Put the email in your reply instead.";
    }
    const id = store.createSendReview({ clot, channelId, account: req.account, eventId: req.event ?? null, mail: JSON.stringify(req.mail), openedAt: this.d.now() });
    const title = req.event === undefined ? undefined : store.getEvent(req.event)?.title;
    const answering = req.event === undefined ? "" : `, answering ${title ? `"${title}"` : "an email"}`;
    try {
      await chat.post(channelId, `${chat.mention(this.d.userId)} ${clot} asks to send this email from ${req.account}${answering}:\n\n${describeMail(req.mail)}\n\n${SEND_REPLIES}`);
    } catch {
      if (store.deleteSendReview(id)) await chat.deleteChannel(channelId).catch(() => undefined);
      return "The user could not be asked just now. Put the email in your reply instead.";
    }
    return SEND_FILED;
  }

  /** Handles a message in a review's channel. Returns false when the channel is not one, so the message belongs elsewhere. */
  async onReply(m: InboundMessage): Promise<boolean> {
    const review = this.d.store.sendReviewByChannel(m.channelId);
    if (!review) return false;
    if (m.authorId !== this.d.userId) return true;
    const answer = matchSendReply(m.text);
    // Closed first, and only whoever closed it goes on: a second reply must not send it twice.
    if (!this.d.store.deleteSendReview(review.id)) return true;
    if (answer === "draft") {
      // Kept until saved: a draft that cannot be saved is asked about again in the same channel.
      if (await this.draft(review)) await this.d.chat.deleteChannel(review.channelId).catch(() => undefined);
      return true;
    }
    // The channel goes at once: the answer is given, and sending or the Clot's revision takes a while.
    await this.d.chat.deleteChannel(review.channelId).catch(() => undefined);
    if (answer === undefined) await this.feedback(review, m.text);
    else if (answer === "no") await this.drop(review);
    else await this.sendIt(review);
    return true;
  }

  /**
   * Withdraws the reviews that can no longer be answered: those left unanswered too long, and those
   * whose channel is gone. Called at startup and then every hour.
   */
  async closeStale(): Promise<void> {
    const now = this.d.now();
    const days = span(this.d.maxMs);
    for (const review of this.d.store.openSendReviews()) {
      const mail = JSON.parse(review.mail) as OutgoingMail;
      const what = mailHeadline(mail, review.account);
      if (now - review.openedAt >= this.d.maxMs) {
        if (!this.d.store.withdrawSendReview(review.id, review.clot, `Your email ${what} waited ${days} for the user's answer and was withdrawn unsent. Do not ask to send it again unless the user asks.`)) continue;
        await this.d.say(review.clot, `Withdrawn after ${days} without an answer, not sent: the email ${what}`);
        await this.d.chat.deleteChannel(review.channelId).catch(() => undefined);
        continue;
      }
      // The channel itself, not its name. Not knowing whether it exists is no reason to close anything.
      const exists = await this.d.chat.channelExists(review.channelId).catch(() => undefined);
      if (exists === false && this.d.store.withdrawSendReview(review.id, review.clot, `Your email ${what} was withdrawn unsent: its review channel was removed. Do not ask to send it again unless the user asks.`)) {
        await this.d.say(review.clot, `Withdrawn, not sent (its channel was removed): the email ${what}`);
      }
    }
  }

  private async sendIt(review: SendReviewRow): Promise<void> {
    const mail = JSON.parse(review.mail) as OutgoingMail;
    const what = mailHeadline(mail, review.account);
    const account = this.d.accounts.find((candidate) => candidate.account === review.account);
    const sent: MailSent = account === undefined ? { ok: false, refused: true, reason: `the email account ${review.account} is not configured any more` } : await this.d.send(account, mail).catch((error: unknown) => ({ ok: false as const, refused: false, reason: error instanceof Error ? error.message : String(error) }));
    if (sent.ok) {
      const caveat = sent.sentCopy === undefined ? "" : ` (${sent.sentCopy})`;
      this.d.store.addNote(review.clot, `The user approved your email ${what}, and the daemon sent it${caveat}.`);
      await this.d.say(review.clot, `Sent, as you approved: the email ${what}${caveat}`);
    } else if (sent.refused) {
      this.d.store.addNote(review.clot, `The user approved your email ${what}, but it was not sent: ${sent.reason}. Tell the user.`);
      await this.d.say(review.clot, `Approved, but not sent (${sent.reason}): the email ${what}`);
    } else {
      // It may have gone, so it is never tried again.
      this.d.store.addNote(review.clot, `The user approved your email ${what}, but whether it went out is not known: ${sent.reason}. It will not be tried again. Tell the user.`);
      await this.d.say(review.clot, `Approved, but it may or may not have been sent (${sent.reason}); it will not be tried again: the email ${what}`);
    }
  }

  private async drop(review: SendReviewRow): Promise<void> {
    const what = mailHeadline(JSON.parse(review.mail) as OutgoingMail, review.account);
    this.d.store.addNote(review.clot, `The user declined your email ${what}; it was not sent. Do not ask to send it again unless the user asks.`);
    await this.d.say(review.clot, `Dropped, not sent: the email ${what}`);
  }

  /** Saves the email as a draft. False when it could not, and the review is open again in the same channel. */
  private async draft(review: SendReviewRow): Promise<boolean> {
    const mail = JSON.parse(review.mail) as OutgoingMail;
    const what = mailHeadline(mail, review.account);
    const account = this.d.accounts.find((candidate) => candidate.account === review.account);
    if (account === undefined) {
      this.d.store.addNote(review.clot, `The user asked for your email ${what} as a draft, but the account is not configured any more. Nothing was sent or saved.`);
      await this.d.say(review.clot, `Not saved: the email account ${review.account} is not configured any more.`);
      return true;
    }
    let mailbox: string;
    try {
      // Marked as the daemon's own first: if the user sends the draft as it is, its copy is not taken for new mail.
      this.d.store.setState(ownMessageKey(mail.messageId), "1");
      ({ mailbox } = await this.d.saveDraft(account, mail));
    } catch (error) {
      const { id: _id, ...again } = review;
      this.d.store.createSendReview(again);
      await this.d.chat.post(review.channelId, `That could not be saved just now (${error instanceof Error ? error.message : String(error)}), and nothing was sent. Answer again.`).catch(() => undefined);
      return false;
    }
    recordDraft(this.d.store, review.clot, { account: account.account, messageId: mail.messageId, subject: mail.subject, to: mail.to, text: mail.text, savedAt: this.d.now() });
    this.d.store.addNote(review.clot, `The user had your email ${what} saved as a draft in ${mailbox} instead of sending it: they will change and send it themselves.`);
    await this.d.say(review.clot, `Saved as a draft in ${account.account} (${mailbox}), not sent: the email ${what}`);
    return true;
  }

  private async feedback(review: SendReviewRow, text: string): Promise<void> {
    const mail = JSON.parse(review.mail) as OutgoingMail;
    const what = mailHeadline(mail, review.account);
    const answers = review.eventId === null ? "" : ` It answered the email ${review.eventId}.`;
    const message = `[Feedback on the email you asked to send ${what}. It was not sent, and its review is closed.${answers} The email was:]\n${quote(mail.text)}\n\n[The user's feedback, from the review channel:]\n${text}`;
    await this.d.say(review.clot, `Feedback on the email ${what}, passed on:\n${quote(text)}`);
    if (!(await this.d.feedback(review.clot, message))) this.d.store.addNote(review.clot, message);
  }
}
