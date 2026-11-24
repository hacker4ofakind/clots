import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import type { EmailAccount } from "../config.js";
import type { ClotEvent } from "../events/types.js";
import type { Store } from "../store.js";
import type { DraftFate, PendingDraft } from "../drafts.js";
import { emailEvent, emailMetaKey, fromParsed, metaOf, ownMessageKey, trimQuoted, type OutgoingMail } from "./email.js";

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
export function saveDraft(account: EmailAccount, mail: OutgoingMail): Promise<{ mailbox: string }> {
  return appendMail(account, mail, { use: "\\Drafts", name: /^(\[gmail\]\/)?drafts$/i, flags: ["\\Draft", "\\Seen"], what: "draft", folder: "Drafts" });
}

/** Puts a copy of a message the daemon sent in the account's Sent folder, as a mail program does. */
export function saveSent(account: EmailAccount, mail: OutgoingMail): Promise<{ mailbox: string }> {
  return appendMail(account, mail, { use: "\\Sent", name: SENT_NAME, flags: ["\\Seen"], what: "copy", folder: "Sent" });
}

const SENT_NAME = /^(\[gmail\]\/)?sent( mail| items| messages)?$/i;

async function appendMail(account: EmailAccount, mail: OutgoingMail, box: { use: string; name: RegExp; flags: string[]; what: string; folder: string }): Promise<{ mailbox: string }> {
  const client = new ImapFlow({ host: account.imap.host, port: account.imap.port, secure: account.imap.port === 993, auth: { user: account.address, pass: account.password }, logger: false });
  await client.connect();
  try {
    const found = findBox(await client.list(), box.use, box.name);
    if (!found) throw new Error(`the account has no ${box.folder} folder`);
    const appended = await client.append(found.path, await composeMail(mail), box.flags);
    if (!appended) throw new Error(`the server did not take the ${box.what} into ${found.path}`);
    return { mailbox: found.path };
  } finally {
    await client.logout().catch(() => undefined);
  }
}

const findBox = (boxes: { path: string; specialUse?: string }[], use: string, name: RegExp) => boxes.find((box) => box.specialUse === use) ?? boxes.find((box) => name.test(box.path));

/**
 * What became of drafts the daemon saved: each is looked for in Drafts, then in Sent. A draft is
 * found by its Message-ID, or else by its subject and first recipient after it was saved, since a
 * mail program may give an edited draft, or the copy it sends, a new Message-ID.
 */
export async function draftFates(account: EmailAccount, drafts: PendingDraft[]): Promise<DraftFate[]> {
  const client = new ImapFlow({ host: account.imap.host, port: account.imap.port, secure: account.imap.port === 993, auth: { user: account.address, pass: account.password }, logger: false });
  await client.connect();
  try {
    const boxes = await client.list();
    const draftsBox = findBox(boxes, "\\Drafts", /^(\[gmail\]\/)?drafts$/i);
    const sentBox = findBox(boxes, "\\Sent", SENT_NAME);
    /**
     * Finds the drafts' copies in the open mailbox: by Message-ID for all of them first, then, among
     * the messages none of those took, by subject and first recipient (in Drafts, by either one, so a
     * draft the user edited is still found). A copy is given to a draft only when it is that draft's
     * one candidate and no other draft's; null marks a draft whose copy cannot be told for sure.
     */
    const locate = async (which: number[], loose: boolean): Promise<Map<number, number | null>> => {
      const found = new Map<number, number | null>();
      const taken = new Set<number>();
      for (const i of which) {
        const byId = await client.search({ header: { "message-id": drafts[i].messageId } }, { uid: true });
        if (byId && byId.length > 0) {
          found.set(i, byId[0]);
          taken.add(byId[0]);
        }
      }
      const matches = new Map<number, number[]>();
      for (const i of which.filter((i) => !found.has(i))) {
        const draft = drafts[i];
        const since = new Date(draft.savedAt - 24 * 60 * 60_000);
        const query = loose ? { or: [{ subject: draft.subject }, { to: draft.to[0] }], since } : { subject: draft.subject, to: draft.to[0], since };
        const candidates = (await client.search(query, { uid: true })) || [];
        const matching: number[] = [];
        for (const uid of candidates.filter((uid) => !taken.has(uid))) {
          const m = await client.fetchOne(String(uid), { envelope: true, internalDate: true }, { uid: true });
          // A minute's grace for clocks that differ.
          if (m && (loose || m.envelope?.subject === draft.subject) && new Date(m.internalDate ?? 0).getTime() >= draft.savedAt - 60_000) matching.push(uid);
        }
        if (matching.length > 0) matches.set(i, matching);
      }
      const claims = (uid: number) => [...matches.values()].filter((matching) => matching.includes(uid)).length;
      for (const [i, matching] of matches) found.set(i, matching.length === 1 && claims(matching[0]) === 1 ? matching[0] : null);
      return found;
    };
    const fates: DraftFate[] = drafts.map(() => ({ kind: "waiting" }));
    if (draftsBox) {
      await client.mailboxOpen(draftsBox.path, { readOnly: true });
      const inDrafts = await locate([...drafts.keys()], true);
      for (const i of drafts.keys()) if (!inDrafts.has(i)) fates[i] = { kind: "gone" };
    }
    if (!draftsBox || !sentBox) return fates;
    await client.mailboxOpen(sentBox.path, { readOnly: true });
    const left = [...drafts.keys()].filter((i) => fates[i].kind === "gone");
    const inSent = await locate(left, false);
    for (const i of left) {
      const uid = inSent.get(i);
      // Several copies that could be this draft's: it waits rather than be given the wrong one.
      if (uid === null) {
        fates[i] = { kind: "waiting" };
        continue;
      }
      const copy = uid === undefined ? undefined : await client.fetchOne(String(uid), { source: true, internalDate: true }, { uid: true });
      if (!copy || !copy.source) {
        fates[i] = { kind: "deleted" };
        continue;
      }
      const mail = fromParsed(await simpleParser(copy.source));
      // When the copy reached Sent: a mail program may keep the Date the draft was written with.
      fates[i] = { kind: "sent", at: copy.internalDate ? new Date(copy.internalDate) : (mail.date ?? new Date()), text: trimQuoted(mail.text) };
    }
    return fates;
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
  /** Every address of every configured account: mail from any other is an outsider's. Defaults to this account's own. */
  ownAddresses?: string[];
}

/**
 * Watches one mailbox: catches up on what arrived since it last read, then reports each new
 * message as it comes. One run is one connection; the supervisor opens the next.
 */
export class MailboxListener {
  private key: string;
  private current?: ImapClient;
  private stopped = false;

  constructor(private d: MailboxListenerDeps) {
    this.key = `imap:${d.account.account}:${d.mailbox}`;
  }

  /** Ends the connection that is open, for an account that changed or was removed. The listener's next run, if the supervisor still has one, ends at once. */
  async stop(): Promise<void> {
    this.stopped = true;
    await this.current?.logout().catch(() => undefined);
  }

  async run(ready: () => void): Promise<void> {
    if (this.stopped) return;
    const client = this.d.client();
    this.current = client;
    await client.connect();
    if (this.stopped) {
      await client.logout().catch(() => undefined);
      return;
    }
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
    const event = emailEvent({ account, mailbox, uid: fetched.uid, uidValidity, threadId: fetched.threadId, mail, tooLarge: fetched.source === undefined, ownAddresses: this.d.ownAddresses }, this.d.now());
    if (!store.insertEvent(event)) return;
    store.setState(emailMetaKey(event.id), JSON.stringify(metaOf(mail)));
    const own = mail.messageId !== undefined && store.getState(ownMessageKey(mail.messageId)) !== undefined;
    this.d.deliver(event, own ? "caused by the Clot itself" : undefined);
  }
}
