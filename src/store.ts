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
  /** Whether a steered event joined the turn that is running, or that was cut off and is still to be picked up. */
  steered: boolean;
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
  /** The session it was opened in: a proposal lasts as long as that session. Null in a row older than this column. */
  sessionId: string | null;
  /** A rule file ("own", "global"), or "calendar" for removing a calendar event. */
  scope: "own" | "global" | "calendar";
  /** The edit, or the calendar removal, as JSON. */
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

/** A question about a global memory, waiting for the user's answer in a temporary channel. */
export interface MemoryQuestionRow {
  file: string;
  /** The text the user is being asked about. */
  text: string;
  channelId: string;
  channelName: string;
}

/** A global memory change that spread: an approval or a deletion. Null text means the file was not there. */
export interface MemoryChangeRow {
  id: number;
  file: string;
  oldText: string | null;
  newText: string | null;
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
CREATE TABLE IF NOT EXISTS global_memories (
  file TEXT PRIMARY KEY,
  text TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS memory_questions (
  file TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  channel_id TEXT NOT NULL UNIQUE,
  channel_name TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS memory_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file TEXT NOT NULL,
  old_text TEXT,
  new_text TEXT,
  undone INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS memory_restores (
  file TEXT PRIMARY KEY
);
CREATE TABLE IF NOT EXISTS state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
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
    steered: r.steered === 1,
    active: r.active === 1,
  };
}

function toInbox(r: any): InboxRow {
  return { id: r.id, clot: r.clot, channelId: r.channel_id, text: r.text, receivedAt: r.received_at, status: r.status, kind: r.kind, eventId: r.event_id ?? null };
}

function toProposal(r: any): ProposalRow {
  return { id: r.id, clot: r.clot, channelId: r.channel_id, channelName: r.channel_name, sessionId: r.session_id ?? null, scope: r.scope, edit: r.edit, summary: r.summary };
}

function toEvent(r: any): EventRow {
  return {
    id: r.id,
    source: r.source,
    account: r.account,
    kind: r.kind,
    place: r.place,
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
    this.addColumn("sessions", "steered", "INTEGER NOT NULL DEFAULT 0");
    this.addColumn("proposals", "session_id", "TEXT");
    this.addColumn("events", "account", "TEXT NOT NULL DEFAULT 'github'");
    this.addColumn("events", "place", "TEXT NOT NULL DEFAULT ''");
    // Every event stored before 2c came from GitHub, and its place is its repository.
    this.db.exec("UPDATE events SET place = repo WHERE place = ''");
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

  /** Records whether a steered event has joined the session's turn. It outlasts a cut-off turn and a restart, so the turn that picks the work up is still treated as one. */
  setSteered(id: string, steered: boolean): void {
    this.db.prepare("UPDATE sessions SET steered = ? WHERE id = ?").run(steered ? 1 : 0, id);
  }

  enqueue(m: { id: string; clot: string; channelId: string; text: string; receivedAt: number; kind?: InboxKind; eventId?: string | null }): boolean {
    const info = this.db
      .prepare("INSERT OR IGNORE INTO inbox (id, clot, channel_id, text, received_at, kind, event_id) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(m.id, m.clot, m.channelId, m.text, m.receivedAt, m.kind ?? "message", m.eventId ?? null);
    return info.changes === 1;
  }

  /**
   * Stores a new event. Returns false when one with the same ID is already stored. The `repo`
   * column is older than `place` and gets the same value, so a database from before 2c keeps working.
   */
  insertEvent(e: ClotEvent): boolean {
    const info = this.db
      .prepare("INSERT OR IGNORE INTO events (id, source, account, kind, repo, place, actor, title, body, url, ref, subject, automated, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(e.id, e.source, e.account, e.kind, e.place, e.place, e.actor, e.title, e.body, e.url, e.ref, e.subject, e.automated ? 1 : 0, e.receivedAt);
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

  /** Replaces an event's title, when the daemon has learnt what it is about: a Notion event says only that something happened. */
  setEventTitle(id: string, title: string): void {
    this.db.prepare("UPDATE events SET title = ? WHERE id = ?").run(title, id);
  }

  /** Replaces an event's actor, when the daemon has learnt the name behind an ID: a Notion event names its author by ID. */
  setEventActor(id: string, actor: string): void {
    this.db.prepare("UPDATE events SET actor = ? WHERE id = ?").run(actor, id);
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

  /** Takes an event out of a Clot's queue if its turn has not started. Returns whether it was waiting there. */
  withdrawPendingEvent(clot: string, eventId: string): boolean {
    return this.db.prepare("UPDATE inbox SET status = 'done' WHERE clot = ? AND event_id = ? AND status = 'pending'").run(clot, eventId).changes > 0;
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
  createProposal(p: Omit<ProposalRow, "id" | "sessionId"> & { sessionId?: string | null }): number {
    const info = this.db
      .prepare("INSERT INTO proposals (clot, channel_id, channel_name, session_id, scope, edit, summary) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(p.clot, p.channelId, p.channelName, p.sessionId ?? null, p.scope, p.edit, p.summary);
    return Number(info.lastInsertRowid);
  }

  /**
   * Closes several of a Clot's proposals as unanswered and leaves the Clot one note about them,
   * all or nothing. Returns the ones this call closed: one that was answered a moment ago is not
   * among them, and its answer stands.
   */
  withdrawProposals(clot: string, proposals: ProposalRow[], note: (closed: ProposalRow[]) => string): ProposalRow[] {
    return this.db.transaction(() => {
      const closed = proposals.filter((proposal) => this.deleteProposal(proposal.id));
      if (closed.length > 0) this.addNote(clot, note(closed));
      return closed;
    })();
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

  /** The global memories in force: file name to the text the user approved, in name order. */
  approvedMemories(): Map<string, string> {
    const rows: any[] = this.db.prepare("SELECT file, text FROM global_memories ORDER BY file").all();
    return new Map(rows.map((r) => [r.file, r.text]));
  }

  private setApprovedMemory(file: string, text: string | null): void {
    if (text === null) this.db.prepare("DELETE FROM global_memories WHERE file = ?").run(file);
    else this.db.prepare("INSERT INTO global_memories (file, text) VALUES (?, ?) ON CONFLICT(file) DO UPDATE SET text = excluded.text").run(file, text);
  }

  /** Puts a change in force and logs it for undo, all or nothing. Null text removes the memory. */
  applyMemoryChange(file: string, newText: string | null): void {
    this.db.transaction(() => {
      const oldText = this.approvedMemories().get(file) ?? null;
      this.setApprovedMemory(file, newText);
      this.db.prepare("INSERT INTO memory_changes (file, old_text, new_text) VALUES (?, ?, ?)").run(file, oldText, newText);
    })();
  }

  /** The most recent change that has not been undone. */
  lastMemoryChange(): MemoryChangeRow | undefined {
    const r: any = this.db.prepare("SELECT * FROM memory_changes WHERE undone = 0 ORDER BY id DESC LIMIT 1").get();
    return r && { id: r.id, file: r.file, oldText: r.old_text, newText: r.new_text };
  }

  /** Puts back what a change replaced and marks it undone, all or nothing. */
  undoMemoryChange(change: MemoryChangeRow): void {
    this.db.transaction(() => {
      this.setApprovedMemory(change.file, change.oldText);
      this.db.prepare("UPDATE memory_changes SET undone = 1 WHERE id = ?").run(change.id);
    })();
  }

  createMemoryQuestion(q: MemoryQuestionRow): void {
    this.db.prepare("INSERT INTO memory_questions (file, text, channel_id, channel_name) VALUES (?, ?, ?, ?)").run(q.file, q.text, q.channelId, q.channelName);
  }

  /** Open questions, in file name order. */
  memoryQuestions(): MemoryQuestionRow[] {
    const rows: any[] = this.db.prepare("SELECT * FROM memory_questions ORDER BY file").all();
    return rows.map((r) => ({ file: r.file, text: r.text, channelId: r.channel_id, channelName: r.channel_name }));
  }

  memoryQuestionByChannel(channelId: string): MemoryQuestionRow | undefined {
    return this.memoryQuestions().find((q) => q.channelId === channelId);
  }

  setMemoryQuestionText(file: string, text: string): void {
    this.db.prepare("UPDATE memory_questions SET text = ? WHERE file = ?").run(text, file);
  }

  /** Closes a question. Returns false when it was closed already: only the caller that gets true may carry out its outcome. */
  deleteMemoryQuestion(file: string): boolean {
    return this.db.prepare("DELETE FROM memory_questions WHERE file = ?").run(file).changes === 1;
  }

  /** Marks the home Clot's copy of a file to be put back to the approved text, or removed when there is none. */
  addMemoryRestore(file: string): void {
    this.db.prepare("INSERT OR IGNORE INTO memory_restores (file) VALUES (?)").run(file);
  }

  memoryRestores(): string[] {
    return this.db.prepare("SELECT file FROM memory_restores ORDER BY file").pluck().all() as string[];
  }

  clearMemoryRestores(files: string[]): void {
    const remove = this.db.prepare("DELETE FROM memory_restores WHERE file = ?");
    this.db.transaction(() => {
      for (const file of files) remove.run(file);
    })();
  }

  /**
   * The daemon's own small records, by key: how far a listener has read, OAuth logins, a Notion
   * verification token, the Message-IDs of mail the daemon wrote. Keys start with what they are for.
   */
  getState(key: string): string | undefined {
    return this.db.prepare("SELECT value FROM state WHERE key = ?").pluck().get(key) as string | undefined;
  }

  setState(key: string, value: string): void {
    this.db.prepare("INSERT INTO state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  deleteState(key: string): void {
    this.db.prepare("DELETE FROM state WHERE key = ?").run(key);
  }

  /** The records whose key begins with a prefix, in key order. */
  statesWithPrefix(prefix: string): { key: string; value: string }[] {
    const rows: any[] = this.db.prepare("SELECT key, value FROM state WHERE substr(key, 1, ?) = ? ORDER BY key").all(prefix.length, prefix);
    return rows.map((r) => ({ key: r.key, value: r.value }));
  }
}
