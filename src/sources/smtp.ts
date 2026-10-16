import nodemailer from "nodemailer";
import type { EmailAccount } from "../config.js";
import type { Sender } from "../events/github-comment.js";
import type { Store } from "../store.js";
import { emailMetaKey, newMessageId, ownMessageKey, replyMail, type EmailMeta } from "./email.js";

/** Sends through the account's own SMTP server, signed in as the account. */
export function smtpTransport(account: EmailAccount) {
  return nodemailer.createTransport({ host: account.smtp.host, port: account.smtp.port, secure: account.smtp.port === 465, auth: { user: account.address, pass: account.password } });
}

/**
 * Sends a standing rule's reply to an email: to the sender, in the thread, from the address
 * the mail came to. The one way a Clot sends as the user, with text the user approved.
 */
export function emailReplySender(o: { accounts: EmailAccount[]; store: Store; transport: (account: EmailAccount) => { sendMail(mail: object): Promise<unknown> } }): Sender {
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
      const mail = replyMail(event, meta, text, newMessageId(event.place));
      // Known as the daemon's own before it leaves, so its copy coming back is never taken for new mail.
      o.store.setState(ownMessageKey(mail.messageId), "1");
      try {
        await o.transport(account).sendMail({ from: mail.from, to: mail.to, subject: mail.subject, text: mail.text, messageId: mail.messageId, inReplyTo: mail.inReplyTo, references: mail.references });
      } catch (error: any) {
        const code = typeof error?.responseCode === "number" ? error.responseCode : undefined;
        const why = error instanceof Error ? error.message : String(error);
        if (code !== undefined && code >= 500) return { ok: false, refused: true, reason: `the mail server refused it (${code} ${why})` };
        return { ok: false, refused: false, reason: `the mail server could not be reached or did not answer clearly (${why})` };
      }
      return { ok: true, url: event.url };
    },
  };
}
