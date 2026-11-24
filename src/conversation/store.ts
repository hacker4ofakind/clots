import type Database from "better-sqlite3";

/**
 * What each row of a Clot's chat is. `user` and `clot` are the two sides of the conversation; `activity`
 * is a tool-activity line or the turn's summary; `note` is the daemon speaking (a rollover, the outcome of
 * an ask, a notice); `ask` points at an ask by its ID; `workers` points at a turn's workers.
 */
export type MessageKind = "user" | "clot" | "activity" | "note" | "ask" | "workers" | "onboarding";

export interface MessageRow {
  /** Rows are ordered by this. */
  seq: number;
  id: string;
  clot: string;
  /** The Clot's session when it was stored: the UI marks a rollover where it changes. */
  sessionId: string | null;
  kind: MessageKind;
  text: string;
  /** An ask's ID for `ask`; a turn's ID for `workers`. */
  ref: string | null;
  /** Extra structure: an activity line's icon, a turn summary's files and commands, a note's recap flag. */
  data: Record<string, unknown> | null;
  createdAt: number;
  /** How many images are attached. */
  images: number;
}

export interface ImageRow {
  mediaType: string;
  data: Buffer;
}

/** What is kept of an ask after it closes, so its card can still be shown and a late answer can be told how it ended. */
export interface AskHistoryRow {
  id: number;
  clot: string;
  kind: string;
  summary: string;
  /** What the card showed, as JSON. */
  view: unknown;
  outcome: string;
  closedAt: number;
  /** The idempotency key of the answer that closed it, if it had one. */
  answerKey: string | null;
}

/** The Clot, as the UI keeps it: what has been read, and its place in the list. */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS messages (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  clot TEXT NOT NULL,
  session_id TEXT,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  ref TEXT,
  data TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_clot ON messages (clot, seq);
CREATE TABLE IF NOT EXISTS message_images (
  message_id TEXT NOT NULL,
  n INTEGER NOT NULL,
  media_type TEXT NOT NULL,
  data BLOB NOT NULL,
  PRIMARY KEY (message_id, n)
);
CREATE TABLE IF NOT EXISTS ask_history (
  id INTEGER PRIMARY KEY,
  clot TEXT NOT NULL,
  kind TEXT NOT NULL,
  summary TEXT NOT NULL,
  view TEXT NOT NULL,
  outcome TEXT NOT NULL,
  closed_at INTEGER NOT NULL,
  answer_key TEXT
);
CREATE TABLE IF NOT EXISTS read_marks (
  clot TEXT PRIMARY KEY,
  seq INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS ui_prefs (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

/** How many closed asks are remembered. */
export const ASK_HISTORY_LIMIT = 500;

function toMessage(r: any): MessageRow {
  return {
    seq: r.seq,
    id: r.id,
    clot: r.clot,
    sessionId: r.session_id,
    kind: r.kind,
    text: r.text,
    ref: r.ref,
    data: r.data === null ? null : JSON.parse(r.data),
    createdAt: r.created_at,
    images: r.images ?? 0,
  };
}

const SELECT = "SELECT messages.*, (SELECT COUNT(*) FROM message_images WHERE message_id = messages.id) AS images FROM messages";

/** The conversation tables: every Clot's chat, the images in it, the history of closed asks and the UI's own preferences. */
export class ConversationStore {
  constructor(private db: Database.Database) {
    db.exec(SCHEMA);
  }

  /**
   * Stores a message. A row with the same ID is left as it was and `created` is false: the client's
   * message ID is the idempotency key for a send that was retried.
   */
  add(m: { id: string; clot: string; sessionId: string | null; kind: MessageKind; text: string; ref?: string | null; data?: Record<string, unknown> | null; createdAt: number; images?: ImageRow[] }): { row: MessageRow; created: boolean } {
    const insert = this.db.transaction(() => {
      const info = this.db.prepare("INSERT OR IGNORE INTO messages (id, clot, session_id, kind, text, ref, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(m.id, m.clot, m.sessionId, m.kind, m.text, m.ref ?? null, m.data === undefined || m.data === null ? null : JSON.stringify(m.data), m.createdAt);
      if (info.changes === 1) (m.images ?? []).forEach((image, n) => this.db.prepare("INSERT INTO message_images (message_id, n, media_type, data) VALUES (?, ?, ?, ?)").run(m.id, n, image.mediaType, image.data));
      return info.changes === 1;
    });
    const created = insert();
    return { row: this.get(m.id)!, created };
  }

  get(id: string): MessageRow | undefined {
    const r = this.db.prepare(`${SELECT} WHERE id = ?`).get(id);
    return r ? toMessage(r) : undefined;
  }

  /** A Clot's messages, newest first, `limit` of them, starting before the message `before` (by ID). */
  list(clot: string, before?: string, limit = 50): MessageRow[] {
    const cursor = before === undefined ? undefined : (this.db.prepare("SELECT seq FROM messages WHERE id = ? AND clot = ?").pluck().get(before, clot) as number | undefined);
    const rows = cursor === undefined ? this.db.prepare(`${SELECT} WHERE clot = ? ORDER BY seq DESC LIMIT ?`).all(clot, limit) : this.db.prepare(`${SELECT} WHERE clot = ? AND seq < ? ORDER BY seq DESC LIMIT ?`).all(clot, cursor, limit);
    return rows.map(toMessage);
  }

  /** The text of a message, replaced: a streamed reply's final text. */
  setText(id: string, text: string): void {
    this.db.prepare("UPDATE messages SET text = ? WHERE id = ?").run(text, id);
  }

  /** An image attached to a message. */
  image(messageId: string, n: number): ImageRow | undefined {
    const r: any = this.db.prepare("SELECT media_type, data FROM message_images WHERE message_id = ? AND n = ?").get(messageId, n);
    return r && { mediaType: r.media_type, data: r.data };
  }

  /** Every image of a message, in order. */
  imagesOf(messageId: string): ImageRow[] {
    return (this.db.prepare("SELECT media_type, data FROM message_images WHERE message_id = ? ORDER BY n").all(messageId) as any[]).map((r) => ({ mediaType: r.media_type, data: r.data }));
  }

  /** The newest message of a Clot of a kind, or undefined. */
  latest(clot: string, kind: MessageKind): MessageRow | undefined {
    const r = this.db.prepare(`${SELECT} WHERE clot = ? AND kind = ? ORDER BY seq DESC LIMIT 1`).get(clot, kind);
    return r ? toMessage(r) : undefined;
  }

  /** Marks everything in a Clot's chat as read. */
  markRead(clot: string): void {
    const seq = (this.db.prepare("SELECT MAX(seq) FROM messages WHERE clot = ?").pluck().get(clot) as number | null) ?? 0;
    this.db.prepare("INSERT INTO read_marks (clot, seq) VALUES (?, ?) ON CONFLICT(clot) DO UPDATE SET seq = excluded.seq").run(clot, seq);
  }

  /** How many replies the Clot has written that the user has not looked at. */
  unread(clot: string): number {
    const read = (this.db.prepare("SELECT seq FROM read_marks WHERE clot = ?").pluck().get(clot) as number | undefined) ?? 0;
    return this.db.prepare("SELECT COUNT(*) FROM messages WHERE clot = ? AND kind = 'clot' AND seq > ?").pluck().get(clot, read) as number;
  }

  /** The newest ask-message ID of a Clot's chat for an ask, so the UI can scroll to its card. */
  askMessage(askId: number): MessageRow | undefined {
    const r = this.db.prepare(`${SELECT} WHERE kind = 'ask' AND ref = ? ORDER BY seq DESC LIMIT 1`).get(String(askId));
    return r ? toMessage(r) : undefined;
  }

  /** Remembers how an ask ended. Only the newest are kept. */
  recordAskOutcome(a: Omit<AskHistoryRow, "closedAt"> & { closedAt: number }): void {
    this.db.prepare("INSERT OR REPLACE INTO ask_history (id, clot, kind, summary, view, outcome, closed_at, answer_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(a.id, a.clot, a.kind, a.summary, JSON.stringify(a.view), a.outcome, a.closedAt, a.answerKey);
    this.db.prepare("DELETE FROM ask_history WHERE id <= (SELECT id FROM ask_history ORDER BY id DESC LIMIT 1 OFFSET ?)").run(ASK_HISTORY_LIMIT);
  }

  askOutcome(id: number): AskHistoryRow | undefined {
    const r: any = this.db.prepare("SELECT * FROM ask_history WHERE id = ?").get(id);
    return r && { id: r.id, clot: r.clot, kind: r.kind, summary: r.summary, view: JSON.parse(r.view), outcome: r.outcome, closedAt: r.closed_at, answerKey: r.answer_key };
  }

  /** The UI's preferences, one JSON value by key. */
  pref(key: string): unknown {
    const v = this.db.prepare("SELECT value FROM ui_prefs WHERE key = ?").pluck().get(key) as string | undefined;
    return v === undefined ? undefined : JSON.parse(v);
  }

  setPref(key: string, value: unknown): void {
    this.db.prepare("INSERT INTO ui_prefs (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, JSON.stringify(value));
  }
}
