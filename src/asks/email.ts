import type { AskKind, AskRow, Asks } from "../asks.js";
import { mailChannelName } from "../chat/names.js";
import type { EmailAccount } from "../config.js";
import { recordDraft } from "../drafts.js";
import { matchSendReply, SEND_REPLIES } from "../events/reply.js";
import { ownMessageKey, type OutgoingMail } from "../sources/email.js";
import type { MailSent } from "../sources/smtp.js";
import type { Store } from "../store.js";

/** An email a Clot asks to send: from which account, answering which email, if any. */
export interface SendRequest {
  account: string;
  event?: string;
  mail: OutgoingMail;
}

export interface EmailPayload extends SendRequest {
  /** What is being done once the user answered: sending it, or saving it as a draft. */
  step?: "sending" | "drafting";
  /** Asked for in a turn an outsider's text started: the feedback turn is tainted too. */
  outsider: boolean;
}

/** What the Clot is told when its email has been put to the user. */
export const SEND_FILED =
  "Put to the user for review: they are shown the email in a separate channel and send it, drop it, save it as a draft, or give feedback. Nothing has been sent. Do not wait for the answer, and do not say it was sent. You will be told the outcome; feedback comes to you as a message from the user.";

export interface EmailKindDeps {
  store: Store;
  accounts: EmailAccount[];
  /** How long an email waits for the user's answer before it is withdrawn. */
  maxMs: number;
  now: () => number;
  /** Sends a message as the user. */
  send: (account: EmailAccount, mail: OutgoingMail) => Promise<MailSent>;
  /** Puts a message in the account's Drafts folder. */
  saveDraft: (account: EmailAccount, mail: OutgoingMail) => Promise<{ mailbox: string }>;
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

const headlineOf = (ask: AskRow<EmailPayload>) => mailHeadline(ask.payload.mail, ask.payload.account);

/**
 * An email a Clot asks to send. It is shown to the user and answered there to the daemon: the
 * daemon sends it on a yes, drops it on a no, saves it as a draft, or hands any other reply to the
 * Clot as feedback, whose revision opens a new ask. One caught half-way by a stop is closed at the
 * next start, as unknown; one left unanswered too long is withdrawn.
 */
export function emailKind(d: EmailKindDeps): AskKind<EmailPayload> {
  const accountOf = (ask: AskRow<EmailPayload>) => d.accounts.find((candidate) => candidate.account === ask.payload.account);

  return {
    kind: "email",
    channelName: mailChannelName,
    render: (_clot, p) => {
      const title = p.event === undefined ? undefined : d.store.getEvent(p.event)?.title;
      const answering = p.event === undefined ? "" : `, answering ${title ? `"${title}"` : "an email"}`;
      return `asks to send this email from ${p.account}${answering}:\n\n${describeMail(p.mail)}\n\n${SEND_REPLIES}`;
    },
    texts: {
      filed: SEND_FILED,
      already: "This email is already with the user, waiting for their answer.",
      full: (n) => `Not filed: ${n} emails already wait for the user's answer. Put this one in your reply instead.`,
      notAsked: (reason) => `The user could not be asked just now${reason ? ` (${reason})` : ""}. Put the email in your reply instead.`,
    },

    stale: (ask, now) => (now - ask.openedAt >= d.maxMs ? `it waited ${span(d.maxMs)} for your answer` : undefined),

    async onReply(ask, text, io) {
      const what = headlineOf(ask);
      const answer = matchSendReply(text);
      if (answer === "draft") return draft(ask, io);
      if (answer === "yes") {
        if (!io.setBusy({ ...ask.payload, step: "sending" })) return;
        // The channel goes at once: the answer is given, and sending takes a while.
        await io.dropChannel();
        return sendIt(ask, io);
      }
      if (answer === "no") {
        await io.close(`The user declined your email ${what}; it was not sent. Do not ask to send it again unless the user asks.`, `Dropped, not sent: the email ${what}`);
        return;
      }
      const answers = ask.payload.event === undefined ? "" : ` It answered the email ${ask.payload.event}.`;
      const message = `[Feedback on the email you asked to send ${what}. It was not sent, and its review is closed.${answers} The email was:]\n${quote(ask.payload.mail.text)}\n\n[The user's feedback, from the review channel:]\n${text}`;
      await io.close(null, `Feedback on the email ${what}, passed on:\n${quote(text)}`, { inbox: { id: `email-feedback:${ask.id}`, text: message, kind: "message", outsider: ask.payload.outsider } });
    },

    async interrupted(ask, io) {
      const what = headlineOf(ask);
      if (ask.payload.step === "drafting") {
        await io.close(`The user asked for your email ${what} as a draft, but the daemon stopped while saving it: it may or may not be in Drafts. Nothing was sent.`, `The daemon stopped while saving this as a draft, so it may or may not be in Drafts; nothing was sent: the email ${what}`);
      } else {
        await io.close(`The user approved your email ${what}, but the daemon stopped while sending it: whether it went out is not known. It will not be tried again. Tell the user.`, `Approved, but the daemon stopped while sending it, so it may or may not have gone: the email ${what}`);
      }
    },
  };

  /** Sends an approved email. The ask is busy, and closes here with the outcome. */
  async function sendIt(ask: AskRow<EmailPayload>, io: Parameters<AskKind<EmailPayload>["onReply"]>[2]): Promise<void> {
    const what = headlineOf(ask);
    const account = accountOf(ask);
    const sent: MailSent = account === undefined ? { ok: false, refused: true, reason: `the email account ${ask.payload.account} is not configured any more` } : await d.send(account, ask.payload.mail).catch((error: unknown) => ({ ok: false as const, refused: false, reason: error instanceof Error ? error.message : String(error) }));
    if (sent.ok) {
      const caveats = [
        ...(sent.rejected === undefined ? [] : [`the mail server refused ${sent.rejected.join(", ")}, so it did not go to them`]),
        ...(sent.noCopy === undefined ? [] : [`no copy could be put in Sent: ${sent.noCopy}`]),
      ];
      const caveat = caveats.length === 0 ? "" : ` (${caveats.join("; ")})`;
      await io.close(`The user approved your email ${what}, and the daemon sent it${caveat}.${sent.rejected === undefined ? "" : " It will not be tried again. Tell the user who did not get it."}`, `Sent, as you approved: the email ${what}${caveat}`);
    } else if (sent.refused) {
      await io.close(`The user approved your email ${what}, but it was not sent: ${sent.reason}. Tell the user.`, `Approved, but not sent (${sent.reason}): the email ${what}`);
    } else {
      // It may have gone, so it is never tried again.
      await io.close(`The user approved your email ${what}, but whether it went out is not known: ${sent.reason}. It will not be tried again. Tell the user.`, `Approved, but it may or may not have been sent (${sent.reason}); it will not be tried again: the email ${what}`);
    }
  }

  /** Saves the email as a draft. If it cannot be saved, the ask is open again in the same channel. */
  async function draft(ask: AskRow<EmailPayload>, io: Parameters<AskKind<EmailPayload>["onReply"]>[2]): Promise<void> {
    const what = headlineOf(ask);
    const mail = ask.payload.mail;
    const account = accountOf(ask);
    if (!io.setBusy({ ...ask.payload, step: "drafting" })) return;
    if (account === undefined) {
      await io.close(`The user asked for your email ${what} as a draft, but the account is not configured any more. Nothing was sent or saved.`, `Not saved: the email account ${ask.payload.account} is not configured any more.`);
      return;
    }
    let mailbox: string;
    try {
      // Marked as the daemon's own first: if the user sends the draft as it is, its copy is not taken for new mail.
      d.store.setState(ownMessageKey(mail.messageId), "1");
      ({ mailbox } = await d.saveDraft(account, mail));
    } catch (error) {
      // Kept until saved: the question is open again, in the same channel.
      io.reopen({ ...ask.payload, step: undefined });
      await io.repeat(`That could not be saved just now (${error instanceof Error ? error.message : String(error)}), and nothing was sent. Answer again.`);
      return;
    }
    recordDraft(d.store, ask.clot, { account: account.account, messageId: mail.messageId, subject: mail.subject, to: mail.to, text: mail.text, savedAt: d.now() });
    await io.close(`The user had your email ${what} saved as a draft in ${mailbox} instead of sending it: they will change and send it themselves.`, `Saved as a draft in ${account.account} (${mailbox}), not sent: the email ${what}`);
  }
}

/** Opens an email ask. Returns what the tool tells the Clot. */
export function askEmail(asks: Asks, kind: AskKind<EmailPayload>, max: number, clot: string, req: SendRequest, outsider: boolean): Promise<string> {
  const { mail } = req;
  return asks.open(kind, clot, { ...req, outsider }, {
    summary: `Email ${mailHeadline(mail, req.account)}`,
    dedupe: JSON.stringify([req.account, req.event ?? null, mail.subject, mail.text, mail.to]),
    max,
    outsider,
  });
}
