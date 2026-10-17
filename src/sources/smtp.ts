import nodemailer from "nodemailer";
import type { EmailAccount } from "../config.js";
import type { Sender } from "../events/github-comment.js";
import type { Store } from "../store.js";
import { emailMetaKey, newMessageId, ownMessageKey, replyMail, type EmailMeta, type OutgoingMail } from "./email.js";

/** Sends through the account's own SMTP server, signed in as the account. */
export function smtpTransport(account: EmailAccount) {
  return nodemailer.createTransport({ host: account.smtp.host, port: account.smtp.port, secure: account.smtp.port === 465, auth: { user: account.address, pass: account.password } });
}

/** Gmail files what is sent through its SMTP server in Sent by itself. */
export const filesSentItself = (account: EmailAccount) => account.smtp.host.toLowerCase() === "smtp.gmail.com";

/** What became of a message handed to the mail server. `refused`: the server said no, so it was not sent; otherwise it may or may not have gone. */
/** `rejected`: recipients the server refused while taking the others. `noCopy`: why no copy could be put in Sent. */
export type MailSent = { ok: true; rejected?: string[]; noCopy?: string } | { ok: false; refused: boolean; reason: string };

export interface MailerDeps {
  store: Store;
  transport: (account: EmailAccount) => { sendMail(mail: object): Promise<unknown> };
  /** Puts a copy in the account's Sent folder. */
  saveSent: (account: EmailAccount, mail: OutgoingMail) => Promise<unknown>;
  log: (text: string, error?: unknown) => void;
}

/**
 * Sends a message as the user, then puts a copy in Sent where the server does not do that itself.
 * Every way a Clot's email leaves goes through here, and only with text the user approved.
 */
export function mailer(o: MailerDeps): (account: EmailAccount, mail: OutgoingMail) => Promise<MailSent> {
  return async (account, mail) => {
    // Known as the daemon's own before it leaves, so its copy coming back is never taken for new mail.
    o.store.setState(ownMessageKey(mail.messageId), "1");
    const done: { ok: true; rejected?: string[]; noCopy?: string } = { ok: true };
    try {
      const info: any = await o.transport(account).sendMail({ from: mail.from, to: mail.to, subject: mail.subject, text: mail.text, messageId: mail.messageId, inReplyTo: mail.inReplyTo, references: mail.references });
      // The server may take some recipients and refuse others; it went to those it took.
      const rejected: string[] = Array.isArray(info?.rejected) ? info.rejected.map((r: unknown) => (typeof r === "string" ? r : String((r as { address?: string })?.address ?? r))) : [];
      if (rejected.length > 0) done.rejected = rejected;
    } catch (error: any) {
      const code = typeof error?.responseCode === "number" ? error.responseCode : undefined;
      const why = error instanceof Error ? error.message : String(error);
      if (code !== undefined && code >= 500) return { ok: false, refused: true, reason: `the mail server refused it (${code} ${why})` };
      return { ok: false, refused: false, reason: `the mail server could not be reached or did not answer clearly (${why})` };
    }
    if (!filesSentItself(account)) {
      try {
        await o.saveSent(account, mail);
      } catch (error) {
        // The mail went; only its copy is missing.
        o.log(`[email] sent from ${account.account}, but no copy could be put in Sent:`, error);
        done.noCopy = error instanceof Error ? error.message : String(error);
      }
    }
    return done;
  };
}

/**
 * Sends a standing rule's reply to an email: to the sender, in the thread, from the address
 * the mail came to, with text the user approved in the rule.
 */
export function emailReplySender(o: { accounts: EmailAccount[]; store: Store; send: (account: EmailAccount, mail: OutgoingMail) => Promise<MailSent> }): Sender {
  const accountOf = (accountName: string) => o.accounts.find((account) => account.account === accountName);
  return {
    reach(event) {
      if (event.source !== "email") return "this way of sending answers emails, and this event is not one";
      if (event.automated) return "this email was sent by a program or a mailing list, and is not answered";
      if (!accountOf(event.account)) return `the email account ${event.account} is not configured`;
      return undefined;
    },

    async send(event, text) {
      const account = accountOf(event.account)!;
      const saved = o.store.getState(emailMetaKey(event.id));
      const meta: EmailMeta = saved === undefined ? { messageId: event.ref || undefined, replyTo: "", references: [], subject: event.title } : JSON.parse(saved);
      const sent = await o.send(account, replyMail(event, meta, text, newMessageId(event.place)));
      return sent.ok ? { ok: true, url: event.url } : sent;
    },
  };
}
