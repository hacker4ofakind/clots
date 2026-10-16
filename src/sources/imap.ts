import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import type { EmailAccount } from "../config.js";
import type { ClotEvent } from "../events/types.js";
import type { Store } from "../store.js";
import { emailEvent, emailMetaKey, fromParsed, metaOf, ownMessageKey, type OutgoingMail } from "./email.js";

/** A message as it is written to a mailbox or sent: its headers and its text. */
export function composeMail(mail: OutgoingMail): Promise<Buffer> {
  return new MailComposer({
    from: mail.from,
    to: mail.to,
    subject: mail.subject,
    text: mail.text,
    messageId: mail.messageId,
    inReplyTo: mail.inReplyTo,
    references: mail.references.length > 0 ? mail.references : undefined,
    date: new Date(),
  })
    .compile()
    .build();
}

/** Puts a message in the account's Drafts folder for the user to read, change and send. Nothing is sent. */
export async function saveDraft(account: EmailAccount, mail: OutgoingMail): Promise<{ mailbox: string }> {
  const client = new ImapFlow({ host: account.imap.host, port: account.imap.port, secure: account.imap.port === 993, auth: { user: account.address, pass: account.password }, logger: false });
  await client.connect();
  try {
    const boxes = await client.list();
    const drafts = boxes.find((box) => box.specialUse === "\\Drafts") ?? boxes.find((box) => /^(\[gmail\]\/)?drafts$/i.test(box.path));
    if (!drafts) throw new Error("the account has no Drafts folder");
    const appended = await client.append(drafts.path, await composeMail(mail), ["\\Draft", "\\Seen"]);
    if (!appended) throw new Error(`the server did not take the draft into ${drafts.path}`);
    return { mailbox: drafts.path };
  } finally {
    await client.logout().catch(() => undefined);
  }
}

/** A larger message is reported with its headers only. */
export const MAX_MESSAGE_BYTES = 5 * 1024 * 1024;

/** A message as fetched: its whole source, or only its headers when it is too large. */
export interface FetchedMail {
  uid: number;
  size: number;
  source?: Buffer;
  headers?: Buffer;
  /** Gmail's thread ID. */
  threadId?: string;
}

/** The part of an IMAP connection the listener uses, so that a test can stand in for the server. */
export interface ImapClient {
  connect(): Promise<void>;
  /** Opens a mailbox read-only and keeps it open. */
  open(path: string): Promise<{ uidValidity: string; uidNext: number }>;
  /** The messages after a UID, oldest first. */
  fetchAfter(uid: number, maxBytes: number): AsyncIterable<FetchedMail>;
  /** Calls fn whenever the open mailbox may have new mail. */
  onNewMail(fn: () => void): void;
  /** Resolves when the connection closes, and rejects when it closed because of an error. */
  closed(): Promise<void>;
  logout(): Promise<void>;
}

/** An IMAP connection through imapflow. It idles between commands by itself, and restarts IDLE every ten minutes. */
export function imapflowClient(account: EmailAccount): ImapClient {
  const client = new ImapFlow({
    host: account.imap.host,
    port: account.imap.port,
    secure: account.imap.port === 993,
    auth: { user: account.address, pass: account.password },
    logger: false,
    // Gmail ends IDLE after about 29 minutes; restarting it well before keeps the connection alive.
    maxIdleTime: 10 * 60_000,
  });
  let failure: unknown;
  const closed = new Promise<void>((resolve, reject) => {
    client.on("error", (error: unknown) => {
      failure = error;
    });
    client.on("close", () => (failure === undefined ? resolve() : reject(failure)));
  });
  // Nobody may be waiting on it yet; the rejection is still seen by whoever awaits it later.
  closed.catch(() => undefined);
  return {
    connect: () => client.connect(),
    async open(path) {
      // Opened without a lock: imapflow starts IDLE by itself only while no lock is held, and
      // without IDLE new mail would be seen only when the connection is opened again.
      await client.mailboxOpen(path, { readOnly: true });
      const box = client.mailbox;
      if (!box) throw new Error(`${path} could not be opened`);
      return { uidValidity: String(box.uidValidity), uidNext: box.uidNext };
    },
    async *fetchAfter(uid, maxBytes) {
      // Listed first, then read one by one: imapflow cannot run a command while a fetch is being read.
      const found: { uid: number; size: number; threadId?: string }[] = [];
      for await (const m of client.fetch(`${uid + 1}:*`, { uid: true, size: true, threadId: true }, { uid: true })) {
        // "n:*" also gives the newest message when there is none after n.
        if (m.uid > uid) found.push({ uid: m.uid, size: m.size ?? 0, threadId: m.threadId });
      }
      for (const m of found) {
        const large = m.size > maxBytes;
        const one = await client.fetchOne(String(m.uid), large ? { headers: true } : { source: true }, { uid: true });
        if (!one) continue;
        yield large ? { ...m, headers: one.headers } : { ...m, source: one.source };
      }
    },
    onNewMail(fn) {
      client.on("exists", () => fn());
    },
    closed: () => closed,
    async logout() {
      await client.logout();
    },
  };
}

export interface MailboxPosition {
  uidValidity: string;
  /** The highest UID handled. */
  lastUid: number;
}

/**
 * Where reading starts after connecting: where it stopped, or, for a mailbox seen for the first
 * time or renumbered by the server (a new UIDVALIDITY), at its end. Mail already there is not reported.
 */
export function startPosition(saved: MailboxPosition | undefined, current: { uidValidity: string; uidNext: number }): MailboxPosition {
  if (saved === undefined || saved.uidValidity !== current.uidValidity) return { uidValidity: current.uidValidity, lastUid: current.uidNext - 1 };
  return saved;
}

export interface MailboxListenerDeps {
  account: EmailAccount;
  mailbox: string;
  client: () => ImapClient;
  store: Store;
  /** Hands a stored event on; with a reason, it goes no further. */
  deliver: (event: ClotEvent, dropped?: string) => void;
  now: () => number;
}

/**
 * Watches one mailbox: catches up on what arrived since it last read, then reports each new
 * message as it comes. One run is one connection; the supervisor opens the next.
 */
export class MailboxListener {
  private key: string;

  constructor(private d: MailboxListenerDeps) {
    this.key = `imap:${d.account.account}:${d.mailbox}`;
  }

  async run(ready: () => void): Promise<void> {
    const client = this.d.client();
    await client.connect();
    try {
      const status = await client.open(this.d.mailbox);
      const saved = this.d.store.getState(this.key);
      const position = startPosition(saved === undefined ? undefined : (JSON.parse(saved) as MailboxPosition), status);
      this.d.store.setState(this.key, JSON.stringify(position));
      // One read at a time, in order: new mail that arrives during a read is read after it.
      // A read that fails ends the run at once, so the supervisor connects again and reads from the saved UID.
      let fail!: (error: unknown) => void;
      const failed = new Promise<never>((_resolve, reject) => (fail = reject));
      failed.catch(() => undefined);
      let reading = this.read(client, position);
      client.onNewMail(() => {
        reading = reading.then(() => this.read(client, position));
        reading.catch(fail);
      });
      await reading;
      ready();
      await Promise.race([client.closed(), failed]);
      await reading;
    } finally {
      await client.logout().catch(() => undefined);
    }
  }

  private async read(client: ImapClient, position: MailboxPosition): Promise<void> {
    for await (const fetched of client.fetchAfter(position.lastUid, MAX_MESSAGE_BYTES)) {
      await this.handle(fetched, position.uidValidity);
      // Saved after the message is stored: a stop in between reads it again, and its ID drops the repeat.
      position.lastUid = fetched.uid;
      this.d.store.setState(this.key, JSON.stringify(position));
    }
  }

  private async handle(fetched: FetchedMail, uidValidity: string): Promise<void> {
    const { store, account, mailbox } = this.d;
    const mail = fromParsed(await simpleParser(fetched.source ?? fetched.headers ?? Buffer.alloc(0)));
    const event = emailEvent({ account, mailbox, uid: fetched.uid, uidValidity, threadId: fetched.threadId, mail, tooLarge: fetched.source === undefined }, this.d.now());
    if (!store.insertEvent(event)) return;
    store.setState(emailMetaKey(event.id), JSON.stringify(metaOf(mail)));
    const own = mail.messageId !== undefined && store.getState(ownMessageKey(mail.messageId)) !== undefined;
    this.d.deliver(event, own ? "caused by the Clot itself" : undefined);
  }
}
