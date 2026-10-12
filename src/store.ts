import Database from "better-sqlite3";
import type { ClotEvent } from "./events/types.js";
import type { Effort, Mode, SeedReason, TailMessage } from "./types.js";

export interface ClotRow {
  name: string;
  categoryId: string;
  mode: Mode;
  /** Unix seconds, or null when not paused. */
  pausedUntil: number | null;
}

export interface SessionRow {
  id: string;
  clot: string;
  channelId: string;
  seed: string | null;
  seedReason: SeedReason;
  started: boolean;
  interrupted: boolean;
  /** What the cut-off turn was for, so that picking it up again keeps an investigation locked. */
  interruptedKind: InboxKind;
  /** The event the cut-off turn was looking into, when it was an investigation. */
  interruptedEvent: string | null;
  active: boolean;
}

export type InboxStatus = "pending" | "running" | "done";

/** A message from the user, or an event waiting for its own locked turn. */
export type InboxKind = "message" | "event";

export interface InboxRow {
  id: string;
  clot: string;
  channelId: string;
  text: string;
  receivedAt: number;
  status: InboxStatus;
  kind: InboxKind;
  /** The event this row's turn is for, when it is an investigation. */
  eventId: string | null;
}

/** A rule change waiting for the user's yes or no, in a temporary channel of its own. */
export interface ProposalRow {
  id: number;
  clot: string;
  channelId: string;
  channelName: string;
  scope: "own" | "global";
  /** The edit, as JSON. */
  edit: string;
  summary: string;
}

/** Something the daemon has to tell a Clot at the start of its next turn. */
export interface NoteRow {
  seq: number;
  text: string;
}

/** An edit made from chat, kept with the edit that undoes it. */
export interface RuleEditRow {
  id: number;
  clot: string;
  /** "global", or the name of a Clot. */
  file: string;
  /** The undoing edit, as JSON. */
  inverse: string;
  summary: string;
}

/**
 * Where an event stands. "received": stored, the pipeline has not finished with it.
 * "held": an automated event waiting a short while for others about the same subject.
 * "merged": gathered into a batch event, or a repeat of another; the note names it.
 * "asking": a steering question is open. "queued": waiting for, or given, its own turn.
 * "steered": fed into a running turn. "dropped": will not be acted on; the note says why.
 */
export type EventStatus = "received" | "held" | "merged" | "asking" | "queued" | "steered" | "dropped";

export interface EventRow extends ClotEvent {
  clot: string | null;
  status: EventStatus;
  note: string | null;
  triageMessage: string | null;
  urgent: boolean;
}

/** An open steering question: the temporary channel in which the user is asked about an event. */
export interface AskRow {
  eventId: string;
  clot: string;
  channelId: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS clots (
  name TEXT PRIMARY KEY,
  category_id TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'action',
  paused_until INTEGER
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  clot TEXT NOT NULL,
  channel_id TEXT NOT NULL UNIQUE,
  seed TEXT,
  started INTEGER NOT NULL DEFAULT 0,
  interrupted INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS inbox (
  id TEXT PRIMARY KEY,
  clot TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  text TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
);
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  kind TEXT NOT NULL,
  repo TEXT NOT NULL,
  actor TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  url TEXT NOT NULL,
  ref TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT '',
  automated INTEGER NOT NULL DEFAULT 0,
  received_at INTEGER NOT NULL,
  clot TEXT,
  status TEXT NOT NULL DEFAULT 'received',
  note TEXT,
  triage_message TEXT,
  urgent INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS asks (
  event_id TEXT PRIMARY KEY,
  clot TEXT NOT NULL,
  channel_id TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS tail (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  clot TEXT NOT NULL,
  role TEXT NOT NULL,
  text TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS proposals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  clot TEXT NOT NULL,
  channel_id TEXT NOT NULL UNIQUE,
  channel_name TEXT NOT NULL,
  scope TEXT NOT NULL,
  edit TEXT NOT NULL,
  summary TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS notes (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  clot TEXT NOT NULL,
  text TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS rule_edits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  clot TEXT NOT NULL,
  file TEXT NOT NULL,
  inverse TEXT NOT NULL,
  summary TEXT NOT NULL,
  undone INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS sends (
  event_id TEXT NOT NULL,
  rule TEXT NOT NULL,
  url TEXT,
  PRIMARY KEY (event_id, rule)
);
`;

function toSession(r: any): SessionRow {
  return {
    id: r.id,
    clot: r.clot,
    channelId: r.channel_id,
    seed: r.seed,
    seedReason: r.seed_reason,
    started: r.started === 1,
    interrupted: r.interrupted === 1,
    interruptedKind: r.interrupted_kind,
    interruptedEvent: r.interrupted_event ?? null,
    active: r.active === 1,
  };
}

function toInbox(r: any): InboxRow {
  return { id: r.id, clot: r.clot, channelId: r.channel_id, text: r.text, receivedAt: r.received_at, status: r.status, kind: r.kind, eventId: r.event_id ?? null };
}

function toProposal(r: any): ProposalRow {
  return { id: r.id, clot: r.clot, channelId: r.channel_id, channelName: r.channel_name, scope: r.scope, edit: r.edit, summary: r.summary };
}

function toEvent(r: any): EventRow {
  return {
    id: r.id,
    source: r.source,
    kind: r.kind,
    repo: r.repo,
    actor: r.actor,
    title: r.title,
    body: r.body,
    url: r.url,
    ref: r.ref,
    subject: r.subject,
    automated: r.automated === 1,
    receivedAt: r.received_at,
    clot: r.clot,
    status: r.status,
    note: r.note,
    triageMessage: r.triage_message,
    urgent: r.urgent === 1,
  };
}

function toAsk(r: any): AskRow {
  return { eventId: r.event_id, clot: r.clot, channelId: r.channel_id };
}

export class Store {
  private db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA);
    this.addColumn("sessions", "seed_reason", "TEXT NOT NULL DEFAULT 'context'");
    this.addColumn("clots", "next_effort", "TEXT");
    this.addColumn("inbox", "kind", "TEXT NOT NULL DEFAULT 'message'");
    this.addColumn("sessions", "interrupted_kind", "TEXT NOT NULL DEFAULT 'message'");
    this.addColumn("events", "enriched", "INTEGER NOT NULL DEFAULT 0");
    this.addColumn("events", "subject", "TEXT NOT NULL DEFAULT ''");
    this.addColumn("events", "automated", "INTEGER NOT NULL DEFAULT 0");
    this.addColumn("inbox", "event_id", "TEXT");
    this.addColumn("sessions", "interrupted_event", "TEXT");
  }

  /** Columns added after the first release, so a database created by an earlier version keeps working. */
  private addColumn(table: string, column: string, definition: string): void {
    const columns = this.db.pragma(`table_info(${table})`) as { name: string }[];
    if (!columns.some((c) => c.name === column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  /** Sets the effort for the next message only. */
  setNextEffort(name: string, effort: Effort | null): void {
    this.db.prepare("UPDATE clots SET next_effort = ? WHERE name = ?").run(effort, name);
  }

  /** The one-off effort, if any, left in place. */
  nextEffort(name: string): Effort | null {
    const r: any = this.db.prepare("SELECT next_effort FROM clots WHERE name = ?").get(name);
    return r?.next_effort ?? null;
  }

  /** Returns the one-off effort, if any, and clears it. */
  takeNextEffort(name: string): Effort | null {
    const effort = this.nextEffort(name);
    if (effort !== null) this.setNextEffort(name, null);
    return effort;
  }

  clearSeed(id: string): void {
    this.db.prepare("UPDATE sessions SET seed = NULL WHERE id = ?").run(id);
  }

  clearTail(clot: string): void {
    this.db.prepare("DELETE FROM tail WHERE clot = ?").run(clot);
  }

  upsertClot(name: string, categoryId: string): void {
    this.db
      .prepare("INSERT INTO clots (name, category_id) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET category_id = excluded.category_id")
      .run(name, categoryId);
  }

  getClot(name: string): ClotRow | undefined {
    const r: any = this.db.prepare("SELECT * FROM clots WHERE name = ?").get(name);
    return r && { name: r.name, categoryId: r.category_id, mode: r.mode, pausedUntil: r.paused_until };
  }

  setMode(name: string, mode: Mode): void {
    this.db.prepare("UPDATE clots SET mode = ? WHERE name = ?").run(mode, name);
  }

  setPausedUntil(name: string, pausedUntil: number | null): void {
    this.db.prepare("UPDATE clots SET paused_until = ? WHERE name = ?").run(pausedUntil, name);
  }

  createSession(s: { id: string; clot: string; channelId: string; seed: string | null; seedReason?: SeedReason }): void {
    this.db.transaction(() => {
      this.db.prepare("UPDATE sessions SET active = 0 WHERE clot = ?").run(s.clot);
      this.db
        .prepare("INSERT INTO sessions (id, clot, channel_id, seed, seed_reason) VALUES (?, ?, ?, ?, ?)")
        .run(s.id, s.clot, s.channelId, s.seed, s.seedReason ?? "context");
    })();
  }

  activeSession(clot: string): SessionRow | undefined {
    const r = this.db.prepare("SELECT * FROM sessions WHERE clot = ? AND active = 1").get(clot);
    return r ? toSession(r) : undefined;
  }

  sessionByChannel(channelId: string): SessionRow | undefined {
    const r = this.db.prepare("SELECT * FROM sessions WHERE channel_id = ?").get(channelId);
    return r ? toSession(r) : undefined;
  }

  markSessionStarted(id: string): void {
    this.db.prepare("UPDATE sessions SET started = 1, seed = NULL WHERE id = ?").run(id);
  }

  setInterrupted(id: string, interrupted: boolean, kind: InboxKind = "message", eventId: string | null = null): void {
    this.db
      .prepare("UPDATE sessions SET interrupted = ?, interrupted_kind = ?, interrupted_event = ? WHERE id = ?")
      .run(interrupted ? 1 : 0, interrupted ? kind : "message", interrupted ? eventId : null, id);
  }

  enqueue(m: { id: string; clot: string; channelId: string; text: string; receivedAt: number; kind?: InboxKind; eventId?: string | null }): boolean {
    const info = this.db
      .prepare("INSERT OR IGNORE INTO inbox (id, clot, channel_id, text, received_at, kind, event_id) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(m.id, m.clot, m.channelId, m.text, m.receivedAt, m.kind ?? "message", m.eventId ?? null);
    return info.changes === 1;
  }

  /** Stores a new event. Returns false when one with the same ID is already stored. */
  insertEvent(e: ClotEvent): boolean {
    const info = this.db
      .prepare("INSERT OR IGNORE INTO events (id, source, kind, repo, actor, title, body, url, ref, subject, automated, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(e.id, e.source, e.kind, e.repo, e.actor, e.title, e.body, e.url, e.ref, e.subject, e.automated ? 1 : 0, e.receivedAt);
    return info.changes === 1;
  }

  getEvent(id: string): EventRow | undefined {
    const r = this.db.prepare("SELECT * FROM events WHERE id = ?").get(id);
    return r ? toEvent(r) : undefined;
  }

  /** Events in a given state, oldest first. */
  eventsWithStatus(status: EventStatus): EventRow[] {
    return this.db.prepare("SELECT * FROM events WHERE status = ? ORDER BY rowid").all(status).map(toEvent);
  }

  setEventStatus(id: string, status: EventStatus, note: string | null = null): void {
    this.db.prepare("UPDATE events SET status = ?, note = ? WHERE id = ?").run(status, note, id);
  }

  /** Replaces an event's body, after the daemon has added to it. */
  setEventBody(id: string, body: string): void {
    this.db.prepare("UPDATE events SET body = ?, enriched = 1 WHERE id = ?").run(body, id);
  }

  /** Whether the daemon has already added to this event's body. Kept apart from the body, whose text is the source's to write. */
  isEnriched(id: string): boolean {
    return this.db.prepare("SELECT enriched FROM events WHERE id = ?").pluck().get(id) === 1;
  }

  /**
   * Records what releasing a group of held events produced, all or nothing: the event that goes
   * on (stored now when it is a new batch), and every event it stands in for as merged into it.
   * Done in one step so that a restart never finds some of a group merged and the rest still held.
   */
  recordRelease(r: { event: ClotEvent; clot: string; isNew: boolean; absorbed: string[] }): void {
    this.db.transaction(() => {
      if (r.isNew) {
        this.insertEvent(r.event);
        this.setEventClot(r.event.id, r.clot);
      } else {
        this.setEventStatus(r.event.id, "received");
      }
      for (const id of r.absorbed) this.setEventStatus(id, "merged", `into ${r.event.id}`);
    })();
  }

  setEventClot(id: string, clot: string): void {
    this.db.prepare("UPDATE events SET clot = ? WHERE id = ?").run(clot, id);
  }

  recordTriage(id: string, message: string, urgent: boolean): void {
    this.db.prepare("UPDATE events SET triage_message = ?, urgent = ? WHERE id = ?").run(message, urgent ? 1 : 0, id);
  }

  createAsk(a: AskRow): void {
    this.db.prepare("INSERT INTO asks (event_id, clot, channel_id) VALUES (?, ?, ?)").run(a.eventId, a.clot, a.channelId);
  }

  askByChannel(channelId: string): AskRow | undefined {
    const r = this.db.prepare("SELECT * FROM asks WHERE channel_id = ?").get(channelId);
    return r ? toAsk(r) : undefined;
  }

  /** Open steering questions for a Clot, oldest first. */
  openAsks(clot: string): AskRow[] {
    return this.db.prepare("SELECT * FROM asks WHERE clot = ? ORDER BY rowid").all(clot).map(toAsk);
  }

  /** Closes a question. Returns false when it was closed already: only the caller that gets true may carry out its outcome. */
  deleteAsk(eventId: string): boolean {
    return this.db.prepare("DELETE FROM asks WHERE event_id = ?").run(eventId).changes === 1;
  }

  nextPending(clot: string): InboxRow | undefined {
    const r = this.db.prepare("SELECT * FROM inbox WHERE clot = ? AND status = 'pending' ORDER BY rowid LIMIT 1").get(clot);
    return r ? toInbox(r) : undefined;
  }

  setInboxStatus(id: string, status: InboxStatus): void {
    this.db.prepare("UPDATE inbox SET status = ? WHERE id = ?").run(status, id);
  }

  finishRunning(clot: string): void {
    this.db.prepare("UPDATE inbox SET status = 'done' WHERE clot = ? AND status = 'running'").run(clot);
  }

  requeueRunning(clot: string): number {
    return this.db.prepare("UPDATE inbox SET status = 'pending' WHERE clot = ? AND status = 'running'").run(clot).changes;
  }

  appendTail(clot: string, role: TailMessage["role"], text: string): void {
    this.db.prepare("INSERT INTO tail (clot, role, text) VALUES (?, ?, ?)").run(clot, role, text);
  }

  tail(clot: string, n: number): TailMessage[] {
    const rows: any[] = this.db.prepare("SELECT role, text FROM tail WHERE clot = ? ORDER BY seq DESC LIMIT ?").all(clot, n);
    return rows.reverse().map((r) => ({ role: r.role, text: r.text }));
  }

  /** The events that were gathered into a batch, oldest first. */
  eventsMergedInto(id: string): EventRow[] {
    return this.db.prepare("SELECT * FROM events WHERE status = 'merged' AND note = ? ORDER BY rowid").all(`into ${id}`).map(toEvent);
  }

  /** Stores an open proposal and returns its ID. */
  createProposal(p: Omit<ProposalRow, "id">): number {
    const info = this.db
      .prepare("INSERT INTO proposals (clot, channel_id, channel_name, scope, edit, summary) VALUES (?, ?, ?, ?, ?, ?)")
      .run(p.clot, p.channelId, p.channelName, p.scope, p.edit, p.summary);
    return Number(info.lastInsertRowid);
  }

  proposalByChannel(channelId: string): ProposalRow | undefined {
    const r = this.db.prepare("SELECT * FROM proposals WHERE channel_id = ?").get(channelId);
    return r ? toProposal(r) : undefined;
  }

  /** Open proposals, oldest first: one Clot's, or everyone's. */
  openProposals(clot?: string): ProposalRow[] {
    const rows = clot === undefined ? this.db.prepare("SELECT * FROM proposals ORDER BY id").all() : this.db.prepare("SELECT * FROM proposals WHERE clot = ? ORDER BY id").all(clot);
    return rows.map(toProposal);
  }

  /** Closes a proposal. Returns false when it was closed already: only the caller that gets true may carry out its outcome. */
  deleteProposal(id: number): boolean {
    return this.db.prepare("DELETE FROM proposals WHERE id = ?").run(id).changes === 1;
  }

  addNote(clot: string, text: string): void {
    this.db.prepare("INSERT INTO notes (clot, text) VALUES (?, ?)").run(clot, text);
  }

  /** The notes waiting for a Clot, oldest first. */
  notes(clot: string): NoteRow[] {
    const rows: any[] = this.db.prepare("SELECT seq, text FROM notes WHERE clot = ? ORDER BY seq").all(clot);
    return rows.map((r) => ({ seq: r.seq, text: r.text }));
  }

  /** Removes a Clot's notes up to and including one of them, or all of them. */
  clearNotes(clot: string, upTo: number = Number.MAX_SAFE_INTEGER): void {
    this.db.prepare("DELETE FROM notes WHERE clot = ? AND seq <= ?").run(clot, upTo);
  }

  logRuleEdit(e: Omit<RuleEditRow, "id">): void {
    this.db.prepare("INSERT INTO rule_edits (clot, file, inverse, summary) VALUES (?, ?, ?, ?)").run(e.clot, e.file, e.inverse, e.summary);
  }

  /** The most recent edit made from chat through a Clot that has not been undone. */
  lastRuleEdit(clot: string): RuleEditRow | undefined {
    const r: any = this.db.prepare("SELECT * FROM rule_edits WHERE clot = ? AND undone = 0 ORDER BY id DESC LIMIT 1").get(clot);
    return r && { id: r.id, clot: r.clot, file: r.file, inverse: r.inverse, summary: r.summary };
  }

  markRuleEditUndone(id: number): void {
    this.db.prepare("UPDATE rule_edits SET undone = 1 WHERE id = ?").run(id);
  }

  /** Whether a standing rule has been sent, or is being sent, for an event. */
  hasSend(eventId: string, rule: string): boolean {
    return this.db.prepare("SELECT 1 FROM sends WHERE event_id = ? AND rule = ?").get(eventId, rule) !== undefined;
  }

  /** Records that a rule is being sent for an event. Returns false when it already was: a rule is sent once per event. */
  claimSend(eventId: string, rule: string): boolean {
    return this.db.prepare("INSERT OR IGNORE INTO sends (event_id, rule) VALUES (?, ?)").run(eventId, rule).changes === 1;
  }

  setSendUrl(eventId: string, rule: string, url: string): void {
    this.db.prepare("UPDATE sends SET url = ? WHERE event_id = ? AND rule = ?").run(url, eventId, rule);
  }

  /** Withdraws a claim, when the message was definitely not sent. */
  releaseSend(eventId: string, rule: string): void {
    this.db.prepare("DELETE FROM sends WHERE event_id = ? AND rule = ?").run(eventId, rule);
  }
}
