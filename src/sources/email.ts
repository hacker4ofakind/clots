import { randomUUID } from "node:crypto";
import type { AddressObject, ParsedMail } from "mailparser";
import type { EmailAccount } from "../config.js";
import { clip } from "../events/body.js";
import type { ClotEvent } from "../events/types.js";

/** A message as the daemon uses it, whatever library read it. Addresses are lowercase. */
export interface Mail {
  messageId?: string;
  inReplyTo?: string;
  references: string[];
  from?: { address: string; name: string };
  replyTo?: string;
  to: string[];
  cc: string[];
  deliveredTo: string[];
  subject: string;
  date?: Date;
  /** The plain text, made from the HTML when there is no plain part. */
  text: string;
  attachments: { filename: string; contentType: string; size: number }[];
  /** The headers that say what kind of mail it is, by lowercase name: list-id, auto-submitted, precedence. */
  headers: Record<string, string>;
}

const KIND_HEADERS = ["list-id", "auto-submitted", "precedence"];

function addresses(value: AddressObject | AddressObject[] | undefined): { address: string; name: string }[] {
  const objects = value === undefined ? [] : Array.isArray(value) ? value : [value];
  return objects.flatMap((object) => object.value.flatMap((entry) => [entry, ...(entry.group ?? [])])).filter((entry) => typeof entry.address === "string" && entry.address !== "").map((entry) => ({ address: entry.address!.toLowerCase(), name: entry.name ?? "" }));
}

const ids = (value: string | string[] | undefined) => (value === undefined ? [] : Array.isArray(value) ? value : value.split(/\s+/)).filter((id) => id !== "");

/** Reads what the daemon needs from a message parsed by mailparser. */
export function fromParsed(parsed: ParsedMail): Mail {
  const headerValue = (name: string) => parsed.headerLines.filter((line) => line.key === name).map((line) => line.line.slice(line.line.indexOf(":") + 1).trim());
  const headers: Record<string, string> = {};
  for (const name of KIND_HEADERS) {
    const value = headerValue(name)[0];
    if (value !== undefined) headers[name] = value;
  }
  const text = parsed.text?.trim() ? parsed.text : typeof parsed.html === "string" ? htmlToText(parsed.html) : "";
  return {
    messageId: parsed.messageId,
    inReplyTo: parsed.inReplyTo,
    references: ids(parsed.references),
    from: addresses(parsed.from)[0],
    replyTo: addresses(parsed.replyTo)[0]?.address,
    to: addresses(parsed.to).map((a) => a.address),
    cc: addresses(parsed.cc).map((a) => a.address),
    deliveredTo: headerValue("delivered-to").map((value) => value.replace(/^<|>$/g, "").toLowerCase()),
    subject: parsed.subject ?? "",
    date: parsed.date,
    text: text.trim(),
    attachments: parsed.attachments.map((a) => ({ filename: a.filename ?? "(unnamed)", contentType: a.contentType, size: a.size })),
    headers,
  };
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** HTML as lines of plain text: blocks and line breaks become new lines, tags go, entities are read. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#\d+|[a-z]+);/gi, (whole, name: string) => (name.startsWith("#") ? String.fromCodePoint(Number(name.slice(1))) : (ENTITIES[name.toLowerCase()] ?? whole)))
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .join("\n");
}

/** Where a reply's quotation of earlier messages starts. */
const QUOTE_START = [/^On .+wrote:$/, /^-{2,}\s*Original Message\s*-{2,}/i, /^Le .+a écrit\s*:$/, /^Am .+schrieb.*:$/];

/** The text with the quoted earlier messages left out: lines starting with ">", and everything after "On … wrote:". */
export function trimQuoted(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    // Mail programs wrap the "On … wrote:" line, so it is also tried joined with the next one.
    const joined = `${line} ${(lines[i + 1] ?? "").trim()}`.replace(/\s+/g, " ");
    if (QUOTE_START.some((pattern) => pattern.test(line) || pattern.test(joined))) break;
    if (line.startsWith(">")) continue;
    out.push(lines[i]);
  }
  return out.join("\n").trim();
}

/** Whether an address is one the account receives for: its own, one of its other addresses, or a +alias of either. */
export function isOwnAddress(account: EmailAccount, address: string): boolean {
  const [local, domain] = address.toLowerCase().split("@");
  if (domain === undefined) return false;
  const plain = `${local.split("+")[0]}@${domain}`;
  return [account.address, ...account.addresses].some((own) => own === address.toLowerCase() || own === plain);
}

/** The address the message reached the account through: the first own address among Delivered-To, To and Cc. */
export function placeOf(account: EmailAccount, mail: Mail): string {
  return [...mail.deliveredTo, ...mail.to, ...mail.cc].find((address) => isOwnAddress(account, address)) ?? account.address;
}

/** Mail from a list or a program: a List-Id, an Auto-Submitted other than "no", or a bulk Precedence. */
export function isAutomatedMail(mail: Mail): boolean {
  if (mail.headers["list-id"] !== undefined) return true;
  const submitted = mail.headers["auto-submitted"];
  if (submitted !== undefined && submitted.toLowerCase() !== "no") return true;
  return /^(bulk|list|junk)$/i.test(mail.headers.precedence ?? "");
}

/** The thread, named by its first message. */
export function threadSubject(mail: Mail, fallback: string): string {
  return `thread:${mail.references[0] ?? mail.inReplyTo ?? mail.messageId ?? fallback}`;
}

/** Gmail's web view of a thread, from the thread ID Gmail gives over IMAP. */
export function gmailLink(threadId: string): string {
  return `https://mail.google.com/mail/u/0/#all/${BigInt(threadId).toString(16)}`;
}

/** The state key that marks a Message-ID as one the daemon wrote: a draft or a standing reply. */
export function ownMessageKey(messageId: string): string {
  return `own-message:${messageId.toLowerCase()}`;
}

/** What a reply needs that the event does not carry. Kept beside the event when it is stored. */
export interface EmailMeta {
  messageId?: string;
  replyTo: string;
  references: string[];
  subject: string;
}

export const emailMetaKey = (eventId: string) => `email-meta:${eventId}`;

export function metaOf(mail: Mail): EmailMeta {
  return { messageId: mail.messageId, replyTo: mail.replyTo ?? "", references: mail.references, subject: mail.subject };
}

const kb = (bytes: number) => `${Math.max(1, Math.round(bytes / 1024))} KB`;

/** A message as the common event. */
export function emailEvent(o: { account: EmailAccount; mailbox: string; uid: number; uidValidity: string; threadId?: string; mail: Mail; tooLarge: boolean }, receivedAt: number): ClotEvent {
  const { account, mail } = o;
  const where = `${o.mailbox}:${o.uidValidity}:${o.uid}`;
  const from = mail.from === undefined ? "(no sender)" : mail.from.name ? `${mail.from.name} <${mail.from.address}>` : mail.from.address;
  const lines = [
    `From: ${from}`,
    `To: ${mail.to.join(", ") || "(none)"}`,
    ...(mail.cc.length > 0 ? [`Cc: ${mail.cc.join(", ")}`] : []),
    ...(mail.date ? [`Date: ${mail.date.toISOString()}`] : []),
    `Mailbox: ${o.mailbox}`,
    "",
    o.tooLarge ? "[This message is larger than 5 MB; only its headers were read.]" : trimQuoted(mail.text) || "(no text)",
    ...(mail.attachments.length > 0 ? ["", `Attachments (not read): ${mail.attachments.map((a) => `${a.filename} (${a.contentType}, ${kb(a.size)})`).join("; ")}`] : []),
  ];
  return {
    id: `email:${account.account}:${mail.messageId ?? where}`,
    source: "email",
    account: account.account,
    kind: "email",
    place: placeOf(account, mail),
    actor: mail.from?.address ?? "unknown",
    title: mail.subject.trim() || "(no subject)",
    body: clip(lines.join("\n")),
    url: o.threadId ? gmailLink(o.threadId) : "",
    ref: mail.messageId ?? "",
    subject: threadSubject(mail, where),
    automated: isAutomatedMail(mail),
    receivedAt,
  };
}

/** A message the daemon writes: a draft or a standing reply. */
export interface OutgoingMail {
  from: string;
  to: string[];
  subject: string;
  text: string;
  inReplyTo?: string;
  references: string[];
  messageId: string;
}

/** A new Message-ID on the sender's domain. */
export function newMessageId(from: string): string {
  return `<clots-${randomUUID()}@${from.split("@")[1] ?? "clots.invalid"}>`;
}

/** A reply to an email event: to its Reply-To or sender, in its thread, from the address it came to. */
export function replyMail(event: ClotEvent, meta: EmailMeta, text: string, messageId: string): OutgoingMail {
  const subject = /^re:/i.test(event.title) ? event.title : `Re: ${event.title}`;
  return {
    from: event.place,
    to: [meta.replyTo || event.actor],
    subject,
    text,
    inReplyTo: meta.messageId,
    references: meta.messageId === undefined ? meta.references : [...meta.references, meta.messageId],
    messageId,
  };
}

/** A new message from the account's own address. */
export function newMail(account: EmailAccount, to: string[], subject: string, text: string, messageId: string): OutgoingMail {
  return { from: account.address, to, subject, text, references: [], messageId };
}
