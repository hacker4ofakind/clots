import { labelOf } from "../clot-name.js";
import type { AskAnswer, AskIo, AskKind, AskRow, Asks } from "../asks.js";
import type { EmailAccount } from "../config.js";
import type { OutgoingMail } from "../sources/email.js";
import type { MailSent } from "../sources/smtp.js";
import type { Store } from "../store.js";
import { blockedLine, minutes, waitedMinutes } from "./common.js";

/** An email a Clot asks to send: from which account, answering which email, if any. */
export interface SendRequest {
  account: string;
  event?: string;
  mail: OutgoingMail;
}

export interface EmailPayload extends SendRequest {
  /** What is being done once the user answered: sending it. */
  step?: "sending";
  /** Asked for in a turn an outsider's text started: the feedback turn is tainted too. */
  outsider: boolean;
  /** What the user changed in the body before sending: lines taken out and put in. */
  edited?: { removed: string[]; added: string[] };
}

/** What the Clot is told when its email has been put to the user. */
export const SEND_FILED =
  "Put to the user for review: they are shown the email in your chat and send it, drop it, change its text, or give feedback. Nothing has been sent. Do not wait for the answer, and do not say it was sent. You will be told the outcome; feedback comes to you as a message from the user.";

export interface EmailKindDeps {
  store: Store;
  /** The email accounts as they are configured now. */
  accounts: () => EmailAccount[];
  /** Sends a message as the user. */
  send: (account: EmailAccount, mail: OutgoingMail) => Promise<MailSent>;
}

const quote = (text: string) => `> ${text.split("\n").join("\n> ")}`;

/** One line that names an email: its recipients, subject and account. */
export function mailHeadline(mail: OutgoingMail, account: string): string {
  return `to ${mail.to.join(", ")}, "${mail.subject}" (${account})`;
}

/** The email as the user reviews it: its headers, then its text. */
export function describeMail(mail: OutgoingMail): string {
  return [`From: ${mail.from}`, `To: ${mail.to.join(", ")}`, `Subject: ${mail.subject}`, "", quote(mail.text)].join("\n");
}

/** The lines taken out of a text and the lines put in, by line: enough to tell the Clot what the user changed. */
export function changedLines(before: string, after: string): { removed: string[]; added: string[] } {
  const count = (lines: string[]) => lines.reduce((m, line) => m.set(line, (m.get(line) ?? 0) + 1), new Map<string, number>());
  const a = before.split("\n");
  const b = after.split("\n");
  const inB = count(b);
  const inA = count(a);
  const removed = a.filter((line) => {
    const left = inB.get(line) ?? 0;
    if (left > 0) {
      inB.set(line, left - 1);
      return false;
    }
    return true;
  });
  const added = b.filter((line) => {
    const left = inA.get(line) ?? 0;
    if (left > 0) {
      inA.set(line, left - 1);
      return false;
    }
    return true;
  });
  return { removed: removed.filter((l) => l.trim() !== ""), added: added.filter((l) => l.trim() !== "") };
}

const describeEdit = (e: { removed: string[]; added: string[] }): string =>
  `The user changed the text before sending it.${e.removed.length > 0 ? `\nTaken out:\n${e.removed.map((l) => `- ${l}`).join("\n")}` : ""}${e.added.length > 0 ? `\nPut in:\n${e.added.map((l) => `+ ${l}`).join("\n")}` : ""}`;

const headlineOf = (ask: AskRow<EmailPayload>) => mailHeadline(ask.payload.mail, ask.payload.account);

/**
 * An email a Clot asks to send. It is a card in the chat: Send sends it as it is (or with the user's changes to its
 * text, which the Clot is told of), Don't send drops it, and any other text typed in the chat is handed to the Clot as
 * feedback, whose revision opens a new ask. One caught half-way by a stop is closed at the next start, as unknown;
 * one left unanswered by its deadline is blocked.
 */
export function emailKind(d: EmailKindDeps): AskKind<EmailPayload> {
  const accountOf = (ask: AskRow<EmailPayload>) => d.accounts().find((candidate) => candidate.account === ask.payload.account);

  return {
    kind: "email",
    answers: ["allow", "block", "edit"],
    view: (clot, p) => {
      const title = p.event === undefined ? undefined : d.store.getEvent(p.event)?.title;
      return {
        heading: `Send an email from ${labelOf(clot)}?`,
        shortHeading: "Send an email?",
        rows: [
          { label: "From", value: p.mail.from },
          { label: "To", value: p.mail.to.join(", ") },
          { label: "Subject", value: p.mail.subject },
          ...(p.event === undefined ? [] : [{ label: "Answering", value: title ? `"${title}"` : "an email" }]),
        ],
        body: p.mail.text,
        bodyEditable: true,
        labels: { allow: "Send", block: "Don't send" },
        ...(p.outsider ? { warning: "From an outsider's report." } : {}),
      };
    },
    texts: {
      filed: SEND_FILED,
      already: "This email is already with the user, waiting for their answer.",
      full: (n) => `Not filed: ${n} emails already wait for the user's answer. Put this one in your reply instead.`,
      notAsked: (reason) => `The user could not be asked just now${reason ? ` (${reason})` : ""}. Put the email in your reply instead.`,
    },

    async onAnswer(ask, answer: AskAnswer, io) {
      const what = headlineOf(ask);
      if (answer.action === "block") {
        await io.close("declined", `The user declined your email ${what}; it was not sent. Do not ask to send it again unless the user asks.`, `Dropped, not sent: the email ${what}`);
        return;
      }
      if (answer.action === "allow" || answer.action === "edit") {
        let payload: EmailPayload = { ...ask.payload, step: "sending" };
        if (answer.action === "edit" && answer.body !== ask.payload.mail.text) {
          payload = { ...payload, mail: { ...ask.payload.mail, text: answer.body }, edited: changedLines(ask.payload.mail.text, answer.body) };
        }
        if (!io.setBusy(payload)) return;
        return sendIt({ ...ask, payload }, io);
      }
    },

    async onFeedback(ask, text, io) {
      const what = headlineOf(ask);
      const answers = ask.payload.event === undefined ? "" : ` It answered the email ${ask.payload.event}.`;
      const message = `[Feedback on the email you asked to send ${what}. It was not sent, and its review is closed.${answers} The email was:]\n${quote(ask.payload.mail.text)}\n\n[The user's feedback, from your chat:]\n${text}`;
      await io.close("feedback", null, `Feedback on the email ${what}, passed on:\n${quote(text)}`, { inbox: { id: `email-feedback:${ask.id}`, text: message, kind: "message", outsider: ask.payload.outsider } }, "You answered in chat.");
    },

    async onDeadline(ask, io) {
      const what = headlineOf(ask);
      await io.close("timed_out", `The user did not answer your email ${what} within ${minutes(waitedMinutes(ask))}, so it was not sent. Do not ask to send it again unless the user asks.`, blockedLine(ask));
    },

    async interrupted(ask, io) {
      const what = headlineOf(ask);
      await io.close("failed", `The user approved your email ${what}, but the daemon stopped while sending it: whether it went out is not known. It will not be tried again. Tell the user.`, `Approved, but Clots stopped while sending it, so it may or may not have gone: the email ${what}`);
    },
  };

  /** Sends an approved email. The ask is busy, and closes here with the outcome. */
  async function sendIt(ask: AskRow<EmailPayload>, io: AskIo<EmailPayload>): Promise<void> {
    const what = headlineOf(ask);
    const account = accountOf(ask);
    const edit = ask.payload.edited === undefined ? "" : ` ${describeEdit(ask.payload.edited)}`;
    const edited = ask.payload.edited === undefined ? "" : " (with your changes)";
    const sent: MailSent = account === undefined ? { ok: false, refused: true, reason: `the email account ${ask.payload.account} is not configured any more` } : await d.send(account, ask.payload.mail).catch((error: unknown) => ({ ok: false as const, refused: false, reason: error instanceof Error ? error.message : String(error) }));
    if (sent.ok) {
      const caveats = [
        ...(sent.rejected === undefined ? [] : [`the mail server refused ${sent.rejected.join(", ")}, so it did not go to them`]),
        ...(sent.noCopy === undefined ? [] : [`no copy could be put in Sent: ${sent.noCopy}`]),
      ];
      const caveat = caveats.length === 0 ? "" : ` (${caveats.join("; ")})`;
      await io.close("approved", `The user approved your email ${what}, and the daemon sent it${caveat}.${edit}${sent.rejected === undefined ? "" : " It will not be tried again. Tell the user who did not get it."}`, `Sent an email · you allowed it${edited}${caveat}`);
    } else if (sent.refused) {
      await io.close("failed", `The user approved your email ${what}, but it was not sent: ${sent.reason}. Tell the user.`, `Approved, but not sent (${sent.reason}): the email ${what}`);
    } else {
      // It may have gone, so it is never tried again.
      await io.close("failed", `The user approved your email ${what}, but whether it went out is not known: ${sent.reason}. It will not be tried again. Tell the user.`, `Approved, but it may or may not have been sent (${sent.reason}); it will not be tried again: the email ${what}`);
    }
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
