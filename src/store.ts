import Database from "better-sqlite3";
import type { ClotEvent } from "./events/types.js";
import type { Effort, MainEffort, SeedReason, TailMessage, WorkerModel } from "./types.js";

export interface ClotRow {
  name: string;
  categoryId: string;
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
  /** The cut-off turn came from an outsider's text, so its continuation does too. */
  interruptedOutsider: boolean;
  active: boolean;
}

export type InboxStatus = "pending" | "running" | "done";

/**
 * A message from the user, an event waiting for its own turn, a worker's report, question or
 * failure, or a choice the user did not answer in time, which runs as a worker's turn does.
 */
export type InboxKind = "message" | "event" | "worker" | "choice";

export type WorkerStatus = "queued" | "running" | "idle" | "stopped" | "closed" | "failed";

/** A worker session the daemon started for a Clot's main session. */
export interface WorkerRow {
  /** A UUID, which is also its session ID. */
  id: string;
  clot: string;
  title: string;
  brief: string;
  model: WorkerModel;
  effort: Effort;
  branch: string | null;
  /** The default branch the worktree was made from; null for a home Clot worker. */
  base: string | null;
  worktree: string;
  status: WorkerStatus;
  urgent: boolean;
  queuedSeq: number | null;
  /** Its session exists on disk. */
  started: boolean;
  interrupted: boolean;
  /** A question asked with ask_main in the turn that is running or just ended. */
  asked: string | null;
  prUrl: string | null;
  prNumber: number | null;
  prRepo: string | null;
  lastStep: string | null;
  turnSeq: number;
  failure: string | null;
  /** Turns in a row that failed before any model response. */
  retries: number;
  /** Unix milliseconds since it became idle, or null. */
  idleSince: number | null;
  /** It was started, or told something, by a turn an outsider's text started: its reports carry none of the user's trust. */
  outsider: boolean;
}

export type WorkerChange = Partial<Pick<WorkerRow, "status" | "started" | "interrupted" | "asked" | "prUrl" | "prNumber" | "prRepo" | "lastStep" | "turnSeq" | "failure" | "retries" | "idleSince" | "base" | "outsider">>;

const WORKER_COLUMNS: Record<keyof WorkerChange, string> = {
  status: "status",
  started: "started",
  interrupted: "interrupted",
  asked: "asked",
  prUrl: "pr_url",
  prNumber: "pr_number",
  prRepo: "pr_repo",
  lastStep: "last_step",
  turnSeq: "turn_seq",
  failure: "failure",
  retries: "retries",
  idleSince: "idle_since",
  base: "base",
  outsider: "outsider",
};

function toWorker(r: any): WorkerRow {
  return {
    id: r.id,
    clot: r.clot,
    title: r.title,
    brief: r.brief,
    model: r.model,
    effort: r.effort,
    branch: r.branch,
    base: r.base,
    worktree: r.worktree,
    status: r.status,
    urgent: r.urgent === 1,
    queuedSeq: r.queued_seq,
    started: r.started === 1,
    interrupted: r.interrupted === 1,
    asked: r.asked,
    prUrl: r.pr_url,
    prNumber: r.pr_number,
    prRepo: r.pr_repo,
    lastStep: r.last_step,
    turnSeq: r.turn_seq,
    failure: r.failure,
    retries: r.retries,
    idleSince: r.idle_since,
    outsider: r.outsider === 1,
  };
}

/** What enqueue stores: a row as it arrives. */
export interface InboxInsert {
  id: string;
  clot: string;
  channelId: string;
  text: string;
  receivedAt: number;
  kind?: InboxKind;
  eventId?: string | null;
  workerId?: string | null;
  outsider?: boolean;
}

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
  /** The worker this row is about, when it is a worker's report, question or failure. */
  workerId: string | null;
  /** The row carries an outsider's text, or comes from a turn that did: rulebook edits from its turn are asked. */
  outsider: boolean;
}

/** Thrown inside a transaction to roll it back when an inbox row is there already. */
class RowExists extends Error {}

/**
 * Something put to the user in a temporary channel of its own: shown ("posting"), waiting for the
 * answer ("open"), or being carried out after it ("busy"). The kind decides what an answer does.
 */
export interface AskRow<P = unknown> {
  id: number;
  kind: string;
  clot: string;
  channelId: string;
  channelName: string;
  payload: P;
  /** One line, for clots-waiting and &rules. */
  summary: string;
  state: AskState;
  openedAt: number;
  /** Unix milliseconds when it is decided without the user, or null. */
  deadline: number | null;
  /** Unique among the open asks of a kind and Clot. */
  dedupe: string;
  /** Opened from a turn an outsider's text started. */
  outsider: boolean;
}

export type AskState = "posting" | "open" | "busy";

/** One calendar change a Clot made, with what it replaced, for `&calendar undo`. Events are ScriptEvent JSON. */
export interface CalendarChangeRow {
  id: number;
  clot: string;
  account: string;
  op: "create" | "update" | "remove";
  uid: string;
  before: string | null;
  after: string | null;
  outsider: boolean;
  at: number;
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
 * "queued": waiting for, or given, its own turn. "dropped": will not be acted on; the note says why.
 */
export type EventStatus = "received" | "held" | "merged" | "queued" | "dropped";

export interface EventRow extends ClotEvent {
  clot: string | null;
  status: EventStatus;
  note: string | null;
  triageMessage: string | null;
  urgent: boolean;
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
CREATE TABLE IF NOT EXISTS send_reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  clot TEXT NOT NULL,
  channel_id TEXT NOT NULL UNIQUE,
  account TEXT NOT NULL,
  event_id TEXT,
  mail TEXT NOT NULL,
  opened_at INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'open'
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
CREATE TABLE IF NOT EXISTS workers (
  id TEXT PRIMARY KEY,
  clot TEXT NOT NULL,
  title TEXT NOT NULL,
  brief TEXT NOT NULL,
  model TEXT NOT NULL,
  effort TEXT NOT NULL,
  branch TEXT,
  base TEXT,
  worktree TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  urgent INTEGER NOT NULL DEFAULT 0,
  queued_seq INTEGER,
  started INTEGER NOT NULL DEFAULT 0,
  interrupted INTEGER NOT NULL DEFAULT 0,
  asked TEXT,
  pr_url TEXT,
  pr_number INTEGER,
  pr_repo TEXT,
  last_step TEXT,
  turn_seq INTEGER NOT NULL DEFAULT 0,
  failure TEXT,
  retries INTEGER NOT NULL DEFAULT 0,
  idle_since INTEGER
);
CREATE TABLE IF NOT EXISTS worker_messages (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  worker_id TEXT NOT NULL,
  text TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS user_asks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  clot TEXT NOT NULL,
  channel_id TEXT NOT NULL UNIQUE,
  channel_name TEXT NOT NULL,
  payload TEXT NOT NULL,
  summary TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'posting',
  opened_at INTEGER NOT NULL,
  deadline INTEGER,
  dedupe TEXT NOT NULL,
  outsider INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS calendar_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  clot TEXT NOT NULL,
  account TEXT NOT NULL,
  op TEXT NOT NULL,
  uid TEXT NOT NULL,
  before TEXT,
  after TEXT,
  by_clot INTEGER NOT NULL DEFAULT 1,
  outsider INTEGER NOT NULL DEFAULT 0,
  at INTEGER NOT NULL,
  restoring INTEGER NOT NULL DEFAULT 0
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
    interruptedOutsider: r.interrupted_outsider === 1,
    active: r.active === 1,
  };
}

function toInbox(r: any): InboxRow {
  return { id: r.id, clot: r.clot, channelId: r.channel_id, text: r.text, receivedAt: r.received_at, status: r.status, kind: r.kind, eventId: r.event_id ?? null, workerId: r.worker_id ?? null, outsider: r.outsider === 1 };
}

function toAsk(r: any): AskRow {
  return {
    id: r.id,
    kind: r.kind,
    clot: r.clot,
    channelId: r.channel_id,
    channelName: r.channel_name,
    payload: JSON.parse(r.payload),
    summary: r.summary,
    state: r.state,
    openedAt: r.opened_at,
    deadline: r.deadline ?? null,
    dedupe: r.dedupe,
    outsider: r.outsider === 1,
  };
}

function toCalendarChange(r: any): CalendarChangeRow {
  return { id: r.id, clot: r.clot, account: r.account, op: r.op, uid: r.uid, before: r.before, after: r.after, outsider: r.outsider === 1, at: r.at };
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
    outsider: r.outsider === 1,
    receivedAt: r.received_at,
    clot: r.clot,
    status: r.status,
    note: r.note,
    triageMessage: r.triage_message,
    urgent: r.urgent === 1,
  };
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
    this.addColumn("proposals", "session_id", "TEXT");
    this.addColumn("send_reviews", "state", "TEXT NOT NULL DEFAULT 'open'");
    this.addColumn("events", "account", "TEXT NOT NULL DEFAULT 'github'");
    this.addColumn("events", "place", "TEXT NOT NULL DEFAULT ''");
    this.addColumn("events", "outsider", "INTEGER NOT NULL DEFAULT 0");
    this.addColumn("inbox", "worker_id", "TEXT");
    this.addColumn("inbox", "outsider", "INTEGER NOT NULL DEFAULT 0");
    this.addColumn("sessions", "interrupted_outsider", "INTEGER NOT NULL DEFAULT 0");
    this.addColumn("workers", "outsider", "INTEGER NOT NULL DEFAULT 0");
    this.addColumn("rule_edits", "edit", "TEXT");
    this.addColumn("sessions", "channel_removed", "INTEGER NOT NULL DEFAULT 0");
    // Every event stored before 2c came from GitHub, and its place is its repository.
    this.db.exec("UPDATE events SET place = repo WHERE place = ''");
    // Events can no longer be asked about or fed into a running turn: one a question was open on runs from the start again; one fed into a turn is done.
    this.db.exec("UPDATE events SET status = 'received' WHERE status = 'asking'");
    this.db.exec("UPDATE events SET status = 'dropped', note = 'fed into a turn' WHERE status = 'steered'");
  }

  close(): void {
    this.db.close();
  }

  /** Runs fn in one transaction: everything it writes is stored, or nothing is. */
  inTransaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  createWorker(w: Pick<WorkerRow, "id" | "clot" | "title" | "brief" | "model" | "effort" | "branch" | "base" | "worktree" | "urgent"> & { outsider?: boolean }): void {
    this.db
      .prepare("INSERT INTO workers (id, clot, title, brief, model, effort, branch, base, worktree, urgent, outsider) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(w.id, w.clot, w.title, w.brief, w.model, w.effort, w.branch, w.base, w.worktree, w.urgent ? 1 : 0, w.outsider ? 1 : 0);
  }

  getWorker(id: string): WorkerRow | undefined {
    const r = this.db.prepare("SELECT * FROM workers WHERE id = ?").get(id);
    return r ? toWorker(r) : undefined;
  }

  /** The workers a Clot's main session is shown: queued, running and idle, oldest first. */
  listedWorkers(clot: string): WorkerRow[] {
    return this.db.prepare("SELECT * FROM workers WHERE clot = ? AND status IN ('queued', 'running', 'idle') ORDER BY rowid").all(clot).map(toWorker);
  }

  /** Every worker a Clot has had, oldest first. */
  workersOf(clot: string): WorkerRow[] {
    return this.db.prepare("SELECT * FROM workers WHERE clot = ? ORDER BY rowid").all(clot).map(toWorker);
  }

  /** Every worker on a branch, of any Clot, newest first. */
  workersOnBranch(branch: string): WorkerRow[] {
    return this.db.prepare("SELECT * FROM workers WHERE branch = ? ORDER BY rowid DESC").all(branch).map(toWorker);
  }

  workersWithStatus(status: WorkerStatus): WorkerRow[] {
    return this.db.prepare("SELECT * FROM workers WHERE status = ? ORDER BY rowid").all(status).map(toWorker);
  }

  /** The queue across every Clot, in the order workers start: urgent first, then oldest. */
  queuedWorkers(): WorkerRow[] {
    return this.db.prepare("SELECT * FROM workers WHERE status = 'queued' ORDER BY urgent DESC, queued_seq ASC").all().map(toWorker);
  }

  nextQueuedWorker(): WorkerRow | undefined {
    return this.queuedWorkers()[0];
  }

  setWorker(id: string, change: WorkerChange): void {
    const entries = Object.entries(change) as [keyof WorkerChange, unknown][];
    if (entries.length === 0) return;
    const values = entries.map(([, value]) => (typeof value === "boolean" ? (value ? 1 : 0) : value));
    this.db.prepare(`UPDATE workers SET ${entries.map(([key]) => `${WORKER_COLUMNS[key]} = ?`).join(", ")} WHERE id = ?`).run(...values, id);
  }

  /** Puts a worker at the back of the queue. */
  queueWorker(id: string): void {
    const seq = Number(this.getState("worker-queue-seq") ?? "0") + 1;
    this.setState("worker-queue-seq", String(seq));
    this.db.prepare("UPDATE workers SET status = 'queued', queued_seq = ? WHERE id = ?").run(seq, id);
  }

  addWorkerMessage(id: string, text: string): void {
    this.db.prepare("INSERT INTO worker_messages (worker_id, text) VALUES (?, ?)").run(id, text);
  }

  hasWorkerMessages(id: string): boolean {
    return this.db.prepare("SELECT 1 FROM worker_messages WHERE worker_id = ? LIMIT 1").get(id) !== undefined;
  }

  /** Returns the messages stored for a worker, in order, and deletes them. */
  takeWorkerMessages(id: string): string[] {
    return this.inTransaction(() => {
      const rows = this.db.prepare("SELECT text FROM worker_messages WHERE worker_id = ? ORDER BY seq").all(id) as { text: string }[];
      this.db.prepare("DELETE FROM worker_messages WHERE worker_id = ?").run(id);
      return rows.map((r) => r.text);
    });
  }

  /** The worker of a Clot on a branch, unless it is closed. */
  workerByBranch(clot: string, branch: string): WorkerRow | undefined {
    const r = this.db.prepare("SELECT * FROM workers WHERE clot = ? AND branch = ? AND status != 'closed' ORDER BY rowid DESC LIMIT 1").get(clot, branch);
    return r ? toWorker(r) : undefined;
  }

  /** Columns added after the first release, so a database created by an earlier version keeps working. */
  private addColumn(table: string, column: string, definition: string): void {
    const columns = this.db.pragma(`table_info(${table})`) as { name: string }[];
    if (!columns.some((c) => c.name === column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  /** Sets the effort for the next message only. */
  setNextEffort(name: string, effort: MainEffort | null): void {
    this.db.prepare("UPDATE clots SET next_effort = ? WHERE name = ?").run(effort, name);
  }

  /** The one-off effort, if any, left in place. One an earlier version stored that is no longer allowed reads as none. */
  nextEffort(name: string): MainEffort | null {
    const r: any = this.db.prepare("SELECT next_effort FROM clots WHERE name = ?").get(name);
    return r?.next_effort === "low" || r?.next_effort === "medium" ? r.next_effort : null;
  }

  /** Returns the one-off effort, if any, and clears it. */
  takeNextEffort(name: string): MainEffort | null {
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
    return r && { name: r.name, categoryId: r.category_id, pausedUntil: r.paused_until };
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

  setInterrupted(id: string, interrupted: boolean, kind: InboxKind = "message", eventId: string | null = null, outsider = false): void {
    this.db
      .prepare("UPDATE sessions SET interrupted = ?, interrupted_kind = ?, interrupted_event = ?, interrupted_outsider = ? WHERE id = ?")
      .run(interrupted ? 1 : 0, interrupted ? kind : "message", interrupted ? eventId : null, interrupted && outsider ? 1 : 0, id);
  }

  enqueue(m: InboxInsert): boolean {
    const info = this.db
      .prepare("INSERT OR IGNORE INTO inbox (id, clot, channel_id, text, received_at, kind, event_id, worker_id, outsider) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(m.id, m.clot, m.channelId, m.text, m.receivedAt, m.kind ?? "message", m.eventId ?? null, m.workerId ?? null, m.outsider ? 1 : 0);
    return info.changes === 1;
  }

  /**
   * Stores a new event. Returns false when one with the same ID is already stored. The `repo`
   * column is older than `place` and gets the same value, so a database from before 2c keeps working.
   */
  insertEvent(e: ClotEvent): boolean {
    const info = this.db
      .prepare("INSERT OR IGNORE INTO events (id, source, account, kind, repo, place, actor, title, body, url, ref, subject, automated, outsider, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(e.id, e.source, e.account, e.kind, e.place, e.place, e.actor, e.title, e.body, e.url, e.ref, e.subject, e.automated ? 1 : 0, e.outsider ? 1 : 0, e.receivedAt);
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

  /** Channels of the steering questions an earlier version left open about events, which nothing answers any more. */
  steeringAskChannels(): string[] {
    return (this.db.prepare("SELECT channel_id FROM asks ORDER BY rowid").all() as { channel_id: string }[]).map((r) => r.channel_id);
  }

  clearSteeringAsks(): void {
    this.db.prepare("DELETE FROM asks").run();
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

  /** Stores an ask, in "posting", and returns its ID. IDs are never reused. */
  createAsk(a: Pick<AskRow, "kind" | "clot" | "channelId" | "channelName" | "payload" | "summary" | "openedAt" | "deadline" | "dedupe" | "outsider">): number {
    const info = this.db
      .prepare("INSERT INTO user_asks (kind, clot, channel_id, channel_name, payload, summary, opened_at, deadline, dedupe, outsider) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(a.kind, a.clot, a.channelId, a.channelName, JSON.stringify(a.payload), a.summary, a.openedAt, a.deadline, a.dedupe, a.outsider ? 1 : 0);
    return Number(info.lastInsertRowid);
  }

  askById(id: number): AskRow | undefined {
    const r = this.db.prepare("SELECT * FROM user_asks WHERE id = ?").get(id);
    return r ? toAsk(r) : undefined;
  }

  askByChannel(channelId: string): AskRow | undefined {
    const r = this.db.prepare("SELECT * FROM user_asks WHERE channel_id = ?").get(channelId);
    return r ? toAsk(r) : undefined;
  }

  /** Every ask not yet closed, in any state, oldest first: one Clot's, or everyone's. */
  openAsks(clot?: string): AskRow[] {
    const rows = clot === undefined ? this.db.prepare("SELECT * FROM user_asks ORDER BY id").all() : this.db.prepare("SELECT * FROM user_asks WHERE clot = ? ORDER BY id").all(clot);
    return rows.map(toAsk);
  }

  /** Moves an ask from one state to another, with a new payload if given. Returns false when it was not in that state: only the caller that gets true goes on. */
  moveAsk(id: number, from: AskState, to: AskState, payload?: unknown): boolean {
    if (payload === undefined) return this.db.prepare("UPDATE user_asks SET state = ? WHERE id = ? AND state = ?").run(to, id, from).changes === 1;
    return this.db.prepare("UPDATE user_asks SET state = ?, payload = ? WHERE id = ? AND state = ?").run(to, JSON.stringify(payload), id, from).changes === 1;
  }

  /**
   * Closes an ask, with the note for its Clot, the inbox row that hands it over and any other store writes in `also`, in one
   * transaction. Returns false when it was closed already, or (with onlyOpen) is not open, or the
   * inbox row already exists: then nothing is written. Only the caller that gets true carries on.
   */
  closeAsk(id: number, clot: string, note: string | null, o: { inbox?: InboxInsert; onlyOpen?: boolean; also?: () => void } = {}): boolean {
    try {
      return this.db.transaction(() => {
        const deleted = o.onlyOpen ? this.db.prepare("DELETE FROM user_asks WHERE id = ? AND state = 'open'").run(id) : this.db.prepare("DELETE FROM user_asks WHERE id = ?").run(id);
        if (deleted.changes !== 1) return false;
        if (note !== null) this.addNote(clot, note);
        if (o.inbox !== undefined && !this.enqueue(o.inbox)) throw new RowExists();
        o.also?.();
        return true;
      })();
    } catch (error) {
      if (error instanceof RowExists) return false;
      throw error;
    }
  }

  /** The asks an earlier version kept in its own tables: rule proposals, send reviews and memory questions. */
  legacyAsks(): { table: "proposals" | "send_reviews" | "memory_questions"; clot: string | null; channelId: string; summary: string | null; mail: string | null; account: string | null }[] {
    const proposals = (this.db.prepare("SELECT clot, channel_id, summary FROM proposals ORDER BY id").all() as any[]).map((r) => ({ table: "proposals" as const, clot: r.clot, channelId: r.channel_id, summary: r.summary, mail: null, account: null }));
    const reviews = (this.db.prepare("SELECT clot, channel_id, mail, account FROM send_reviews ORDER BY id").all() as any[]).map((r) => ({ table: "send_reviews" as const, clot: r.clot, channelId: r.channel_id, summary: null, mail: r.mail, account: r.account }));
    const questions = (this.db.prepare("SELECT channel_id FROM memory_questions ORDER BY file").all() as any[]).map((r) => ({ table: "memory_questions" as const, clot: null, channelId: r.channel_id, summary: null, mail: null, account: null }));
    return [...proposals, ...reviews, ...questions];
  }

  /** Drops every legacy ask, leaves the notes given, and sets a state value, all or nothing. */
  dropLegacyAsks(notes: { clot: string; text: string }[], key: string): void {
    this.db.transaction(() => {
      this.db.exec("DELETE FROM proposals; DELETE FROM send_reviews; DELETE FROM memory_questions;");
      for (const note of notes) this.addNote(note.clot, note.text);
      this.setState(key, "1");
    })();
  }

  /** Logs a calendar change a Clot made. Returns its ID. */
  addCalendarChange(c: Omit<CalendarChangeRow, "id">): number {
    return Number(
      this.db
        .prepare("INSERT INTO calendar_changes (clot, account, op, uid, before, after, outsider, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(c.clot, c.account, c.op, c.uid, c.before, c.after, c.outsider ? 1 : 0, c.at).lastInsertRowid,
    );
  }

  /** Records what a change led to, once its answer is known. */
  setCalendarChangeAfter(id: number, uid: string, after: string): void {
    this.db.prepare("UPDATE calendar_changes SET uid = ?, after = ? WHERE id = ?").run(uid, after, id);
  }

  /** A Clot's newest change that is not being undone. */
  latestCalendarChange(clot: string): CalendarChangeRow | undefined {
    const r = this.db.prepare("SELECT * FROM calendar_changes WHERE clot = ? AND restoring = 0 ORDER BY id DESC LIMIT 1").get(clot);
    return r ? toCalendarChange(r) : undefined;
  }

  /** Marks a change as being undone. Returns false when another undo already took it. */
  claimCalendarChange(id: number): boolean {
    return this.db.prepare("UPDATE calendar_changes SET restoring = 1 WHERE id = ? AND restoring = 0").run(id).changes === 1;
  }

  releaseCalendarChange(id: number): void {
    this.db.prepare("UPDATE calendar_changes SET restoring = 0 WHERE id = ?").run(id);
  }

  deleteCalendarChange(id: number): void {
    this.db.prepare("DELETE FROM calendar_changes WHERE id = ?").run(id);
  }

  /** Every Clot's calendar changes since a time, oldest first. */
  calendarChangesSince(since: number): CalendarChangeRow[] {
    return this.db.prepare("SELECT * FROM calendar_changes WHERE at >= ? ORDER BY id").all(since).map(toCalendarChange);
  }

  /** Whether any Clot added this event: only such an event may an outsider's turn change. */
  clotCreated(account: string, uid: string): boolean {
    return this.db.prepare("SELECT 1 FROM calendar_changes WHERE account = ? AND uid = ? AND op = 'create' LIMIT 1").get(account, uid) !== undefined;
  }

  /** How many events a Clot added from outsiders' turns since a time. */
  outsiderCreatesSince(clot: string, since: number): number {
    return this.db.prepare("SELECT COUNT(*) FROM calendar_changes WHERE clot = ? AND op = 'create' AND outsider = 1 AND at >= ?").pluck().get(clot, since) as number;
  }

  /** The channels of a Clot's closed sessions that are still there, oldest first. */
  closedSessionChannels(clot: string): string[] {
    return this.db.prepare("SELECT channel_id FROM sessions WHERE clot = ? AND active = 0 AND channel_removed = 0 ORDER BY rowid").pluck().all(clot) as string[];
  }

  markSessionChannelRemoved(channelId: string): void {
    this.db.prepare("UPDATE sessions SET channel_removed = 1 WHERE channel_id = ?").run(channelId);
  }

  addNote(clot: string, text: string): void {
    this.db.prepare("INSERT INTO notes (clot, text) VALUES (?, ?)").run(clot, text);
  }

  /** Leaves a Clot notes and sets a state value with them, all or nothing. */
  addNotesWithState(clot: string, texts: string[], key: string, value: string): void {
    this.db.transaction(() => {
      for (const text of texts) this.addNote(clot, text);
      this.setState(key, value);
    })();
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

  logRuleEdit(e: Omit<RuleEditRow, "id"> & { edit?: string }): void {
    this.db.prepare("INSERT INTO rule_edits (clot, file, inverse, summary, edit) VALUES (?, ?, ?, ?, ?)").run(e.clot, e.file, e.inverse, e.summary, e.edit ?? null);
  }

  /** Whether the user undid this very edit, made through this Clot in this file. */
  wasUndone(clot: string, file: string, edit: string): boolean {
    return this.db.prepare("SELECT 1 FROM rule_edits WHERE clot = ? AND file = ? AND edit = ? AND undone = 1 LIMIT 1").get(clot, file, edit) !== undefined;
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
