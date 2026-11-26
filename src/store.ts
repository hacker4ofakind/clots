import Database from "better-sqlite3";
import type { AskResult } from "@clots/ui-api-schemas";
import { ComposioStore } from "./composio/store.js";
import { ConversationStore } from "./conversation/store.js";
import { PushStore } from "./push.js";
import type { ClotEvent } from "./events/types.js";
import type { Effort, MainEffort, SeedReason, TailMessage, WorkerModel } from "./types.js";

export interface ClotRow {
  name: string;
  /** Unix seconds, or null when not paused. */
  pausedUntil: number | null;
}

export interface SessionRow {
  id: string;
  clot: string;
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

/** "digested": an event gathered into a digest row, which carries it from there. */
export type InboxStatus = "pending" | "running" | "done" | "digested";

/**
 * A message from the user, an event waiting for its own turn, a worker's report, question or
 * failure, or a choice the user did not answer in time, which runs as a worker's turn does.
 * A digest is several events that waited behind a gate, looked into in one turn.
 */
export type InboxKind = "message" | "event" | "worker" | "choice" | "digest";

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
  /** It may start while a gate holds: it was asked for in a turn of the user's own or in the investigation of an urgent event. */
  gateOk: boolean;
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
  /** The main-session turn that started it: the chat's worker card groups workers by it. Null for one started before 4a. */
  turnId: string | null;
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
    gateOk: r.gate_ok === 1,
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
    turnId: r.turn_id ?? null,
  };
}

/** What enqueue stores: a row as it arrives. */
export interface InboxInsert {
  id: string;
  clot: string;
  text: string;
  receivedAt: number;
  kind?: InboxKind;
  eventId?: string | null;
  workerId?: string | null;
  outsider?: boolean;
  /** An event held back by a gate: it waits for the gate to lift, and is then delivered with the others as a digest. */
  gated?: boolean;
}

export interface InboxRow {
  id: string;
  clot: string;
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
  /** Held back by a gate. */
  gated: boolean;
  /** Triage marked the row's event urgent. Only filled in by pendingRows. */
  urgent: boolean;
}

/** Thrown inside a transaction to roll it back when an inbox row is there already. */
class RowExists extends Error {}

/**
 * Something put to the user in the Clot's chat and in Waiting for you: waiting for the answer ("open"),
 * or being carried out after it ("busy"). The kind decides what an answer does.
 */
export interface AskRow<P = unknown> {
  id: number;
  kind: string;
  clot: string;
  payload: P;
  /** One line, for Waiting for you and notifications. */
  summary: string;
  state: AskState;
  openedAt: number;
  /** Unix milliseconds when it is decided without the user. Null only for an ask an earlier version opened. */
  deadline: number | null;
  /** Unique among the open asks of a kind and Clot. */
  dedupe: string;
  /** Opened from a turn an outsider's text started. */
  outsider: boolean;
}

export type AskState = "open" | "busy";

/** One calendar change a Clot made, with what it replaced, for `/calendar undo`. Events are ScriptEvent JSON. */
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
  /** For a removal: the script said the event was removed. Its check can still find a deleted event for a while, so this is what an undo trusts. */
  confirmed: boolean;
  /** The row now records what an undo left: the event put back, or the event an undo removed. */
  restored: boolean;
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
  mode TEXT NOT NULL DEFAULT 'action',
  paused_until INTEGER
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  clot TEXT NOT NULL,
  seed TEXT,
  started INTEGER NOT NULL DEFAULT 0,
  interrupted INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS inbox (
  id TEXT PRIMARY KEY,
  clot TEXT NOT NULL,
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
CREATE TABLE IF NOT EXISTS tail (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  clot TEXT NOT NULL,
  role TEXT NOT NULL,
  text TEXT NOT NULL
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
  payload TEXT NOT NULL,
  summary TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'open',
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
CREATE TABLE IF NOT EXISTS spend (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  clot TEXT NOT NULL,
  who TEXT NOT NULL,
  usd REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS spend_at ON spend (at);
CREATE TABLE IF NOT EXISTS session_costs (
  session_id TEXT PRIMARY KEY,
  total REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS digests (
  digest_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  PRIMARY KEY (digest_id, event_id)
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
  return { id: r.id, clot: r.clot, text: r.text, receivedAt: r.received_at, status: r.status, kind: r.kind, eventId: r.event_id ?? null, workerId: r.worker_id ?? null, outsider: r.outsider === 1, gated: r.gated === 1, urgent: r.ev_urgent === 1 };
}

function toAsk(r: any): AskRow {
  return {
    id: r.id,
    kind: r.kind,
    clot: r.clot,
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
  return { id: r.id, clot: r.clot, account: r.account, op: r.op, uid: r.uid, before: r.before, after: r.after, outsider: r.outsider === 1, at: r.at, confirmed: r.confirmed === 1, restored: r.restored === 1 };
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
  private workerListeners: ((worker: WorkerRow) => void)[] = [];
  /** What Composio keeps: accounts, trigger instances and the log of the Clots' writes. */
  readonly composio: ComposioStore;
  /** Every Clot's chat, the closed asks and the UI's preferences. */
  readonly conversation: ConversationStore;
  /** The devices that asked for notifications. */
  readonly push: PushStore;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.migrateFromChannels();
    this.db.exec(SCHEMA);
    this.composio = new ComposioStore(this.db);
    this.conversation = new ConversationStore(this.db);
    this.push = new PushStore(this.db);
    this.addColumn("sessions", "seed_reason", "TEXT NOT NULL DEFAULT 'context'");
    this.addColumn("clots", "next_effort", "TEXT");
    this.addColumn("inbox", "kind", "TEXT NOT NULL DEFAULT 'message'");
    this.addColumn("sessions", "interrupted_kind", "TEXT NOT NULL DEFAULT 'message'");
    this.addColumn("events", "enriched", "INTEGER NOT NULL DEFAULT 0");
    this.addColumn("events", "subject", "TEXT NOT NULL DEFAULT ''");
    this.addColumn("events", "automated", "INTEGER NOT NULL DEFAULT 0");
    this.addColumn("inbox", "event_id", "TEXT");
    this.addColumn("sessions", "interrupted_event", "TEXT");
    this.addColumn("events", "account", "TEXT NOT NULL DEFAULT 'github'");
    this.addColumn("events", "place", "TEXT NOT NULL DEFAULT ''");
    this.addColumn("events", "outsider", "INTEGER NOT NULL DEFAULT 0");
    this.addColumn("inbox", "worker_id", "TEXT");
    this.addColumn("inbox", "outsider", "INTEGER NOT NULL DEFAULT 0");
    this.addColumn("inbox", "gated", "INTEGER NOT NULL DEFAULT 0");
    // Workers an earlier version started were never held by a gate.
    this.addColumn("workers", "gate_ok", "INTEGER NOT NULL DEFAULT 1");
    this.addColumn("sessions", "interrupted_outsider", "INTEGER NOT NULL DEFAULT 0");
    this.addColumn("workers", "outsider", "INTEGER NOT NULL DEFAULT 0");
    this.addColumn("workers", "turn_id", "TEXT");
    this.addColumn("rule_edits", "edit", "TEXT");
    this.addColumn("calendar_changes", "confirmed", "INTEGER NOT NULL DEFAULT 0");
    this.addColumn("calendar_changes", "restored", "INTEGER NOT NULL DEFAULT 0");
    // Every event stored before 2c came from GitHub, and its place is its repository.
    this.db.exec("UPDATE events SET place = repo WHERE place = ''");
    // Events can no longer be asked about or fed into a running turn: one a question was open on runs from the start again; one fed into a turn is done.
    this.db.exec("UPDATE events SET status = 'received' WHERE status = 'asking'");
    this.db.exec("UPDATE events SET status = 'dropped', note = 'fed into a turn' WHERE status = 'steered'");
    // Calendar changes logged before 2e hold iCal UIDs that the Composio calendar cannot address: one undo of them would fail, so there is nothing to put back.
    if (this.getState("composio.migrated") === undefined) {
      this.db.exec("DELETE FROM calendar_changes");
      this.setState("composio.migrated", "1");
    }
  }

  close(): void {
    this.db.close();
  }

  /**
   * Stage 4a took the chat out of Discord, so the channel and category columns go. SQLite cannot drop a
   * column that is UNIQUE, so `sessions` and `user_asks` are rebuilt; `clots` and `inbox` just lose a column.
   * What an earlier version left in its own ask tables (rule proposals, send reviews, memory questions,
   * steering questions) is dropped, with a note to the Clot for each proposal and review. It runs in one
   * transaction, so a stop in the middle leaves the database as it was. Done once, marked by `user_version`.
   */
  private migrateFromChannels(): void {
    if ((this.db.pragma("user_version", { simple: true }) as number) >= 1) return;
    const has = (table: string) => (this.db.pragma(`table_info(${table})`) as { name: string }[]).length > 0;
    const columns = (table: string) => (this.db.pragma(`table_info(${table})`) as { name: string }[]).map((c) => c.name);
    this.db.transaction(() => {
      if (has("clots") && columns("clots").includes("category_id")) this.db.exec("ALTER TABLE clots DROP COLUMN category_id");
      if (has("inbox") && columns("inbox").includes("channel_id")) this.db.exec("ALTER TABLE inbox DROP COLUMN channel_id");
      if (has("sessions") && columns("sessions").includes("channel_id")) {
        const old = columns("sessions");
        this.db.exec("ALTER TABLE sessions RENAME TO sessions_old");
        this.db.exec(`CREATE TABLE sessions (
          id TEXT PRIMARY KEY,
          clot TEXT NOT NULL,
          seed TEXT,
          started INTEGER NOT NULL DEFAULT 0,
          interrupted INTEGER NOT NULL DEFAULT 0,
          active INTEGER NOT NULL DEFAULT 1,
          seed_reason TEXT NOT NULL DEFAULT 'context',
          interrupted_kind TEXT NOT NULL DEFAULT 'message',
          interrupted_event TEXT,
          interrupted_outsider INTEGER NOT NULL DEFAULT 0
        )`);
        // Only the columns the new table has: an older version left others behind (`steered`), and the channel ones go.
        const keep = columns("sessions").filter((c) => old.includes(c));
        this.db.exec(`INSERT INTO sessions (${keep.join(", ")}) SELECT ${keep.join(", ")} FROM sessions_old ORDER BY rowid`);
        this.db.exec("DROP TABLE sessions_old");
      }
      if (has("user_asks") && columns("user_asks").includes("channel_id")) {
        this.db.exec("ALTER TABLE user_asks RENAME TO user_asks_old");
        this.db.exec(`CREATE TABLE user_asks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          kind TEXT NOT NULL,
          clot TEXT NOT NULL,
          payload TEXT NOT NULL,
          summary TEXT NOT NULL,
          state TEXT NOT NULL DEFAULT 'open',
          opened_at INTEGER NOT NULL,
          deadline INTEGER,
          dedupe TEXT NOT NULL,
          outsider INTEGER NOT NULL DEFAULT 0
        )`);
        // An ask that was still being shown was never answerable; the others keep their IDs and state.
        this.db.exec("INSERT INTO user_asks (id, kind, clot, payload, summary, state, opened_at, deadline, dedupe, outsider) SELECT id, kind, clot, payload, summary, state, opened_at, deadline, dedupe, outsider FROM user_asks_old WHERE state != 'posting' ORDER BY id");
        this.db.exec("DROP TABLE user_asks_old");
      }
      if (has("notes")) {
        if (has("proposals")) for (const r of this.db.prepare("SELECT clot, summary FROM proposals ORDER BY id").all() as { clot: string; summary: string }[]) this.db.prepare("INSERT INTO notes (clot, text) VALUES (?, ?)").run(r.clot, `Withdrawn when the daemon was updated: the rule change ${r.summary.split("\n")[0]}. Ask again if it still makes sense.`);
        if (has("send_reviews")) {
          for (const r of this.db.prepare("SELECT clot, mail, account FROM send_reviews ORDER BY id").all() as { clot: string; mail: string; account: string }[]) {
            let what = "an email";
            try {
              const mail = JSON.parse(r.mail) as { to?: string[]; subject?: string };
              what = `the email to ${(mail.to ?? []).join(", ")}, "${mail.subject ?? ""}" (${r.account})`;
            } catch {
              // The note names the account only.
            }
            this.db.prepare("INSERT INTO notes (clot, text) VALUES (?, ?)").run(r.clot, `Withdrawn when the daemon was updated: ${what}. Ask again if it still makes sense.`);
          }
        }
      }
      for (const table of ["proposals", "send_reviews", "memory_questions", "asks"]) this.db.exec(`DROP TABLE IF EXISTS ${table}`);
      this.db.pragma("user_version = 1");
    })();
  }

  /** Runs fn in one transaction: everything it writes is stored, or nothing is. */
  inTransaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  /** Called after a worker is made or changed, with the worker as it is then. */
  onWorkerChange(fn: (worker: WorkerRow) => void): void {
    this.workerListeners.push(fn);
  }

  private workerChanged(id: string): void {
    if (this.workerListeners.length === 0) return;
    const worker = this.getWorker(id);
    if (worker) for (const fn of this.workerListeners) fn(worker);
  }

  createWorker(w: Pick<WorkerRow, "id" | "clot" | "title" | "brief" | "model" | "effort" | "branch" | "base" | "worktree" | "urgent"> & { outsider?: boolean; gateOk?: boolean; turnId?: string | null }): void {
    this.db
      .prepare("INSERT INTO workers (id, clot, title, brief, model, effort, branch, base, worktree, urgent, outsider, gate_ok, turn_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(w.id, w.clot, w.title, w.brief, w.model, w.effort, w.branch, w.base, w.worktree, w.urgent ? 1 : 0, w.outsider ? 1 : 0, w.gateOk === false ? 0 : 1, w.turnId ?? null);
    this.workerChanged(w.id);
  }

  /** The workers a main-session turn started, in the order they were made. */
  workersOfTurn(turnId: string): WorkerRow[] {
    return this.db.prepare("SELECT * FROM workers WHERE turn_id = ? ORDER BY rowid").all(turnId).map(toWorker);
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
    this.workerChanged(id);
  }

  /** Puts a worker at the back of the queue. */
  queueWorker(id: string): void {
    const seq = Number(this.getState("worker-queue-seq") ?? "0") + 1;
    this.setState("worker-queue-seq", String(seq));
    this.db.prepare("UPDATE workers SET status = 'queued', queued_seq = ? WHERE id = ?").run(seq, id);
    this.workerChanged(id);
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

  upsertClot(name: string): void {
    this.db.prepare("INSERT OR IGNORE INTO clots (name) VALUES (?)").run(name);
  }

  getClot(name: string): ClotRow | undefined {
    const r: any = this.db.prepare("SELECT * FROM clots WHERE name = ?").get(name);
    return r && { name: r.name, pausedUntil: r.paused_until };
  }

  setPausedUntil(name: string, pausedUntil: number | null): void {
    this.db.prepare("UPDATE clots SET paused_until = ? WHERE name = ?").run(pausedUntil, name);
  }

  createSession(s: { id: string; clot: string; seed: string | null; seedReason?: SeedReason }): void {
    this.db.transaction(() => {
      this.db.prepare("UPDATE sessions SET active = 0 WHERE clot = ?").run(s.clot);
      this.db
        .prepare("INSERT INTO sessions (id, clot, seed, seed_reason) VALUES (?, ?, ?, ?)")
        .run(s.id, s.clot, s.seed, s.seedReason ?? "context");
    })();
  }

  activeSession(clot: string): SessionRow | undefined {
    const r = this.db.prepare("SELECT * FROM sessions WHERE clot = ? AND active = 1").get(clot);
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
      .prepare("INSERT OR IGNORE INTO inbox (id, clot, text, received_at, kind, event_id, worker_id, outsider, gated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(m.id, m.clot, m.text, m.receivedAt, m.kind ?? "message", m.eventId ?? null, m.workerId ?? null, m.outsider ? 1 : 0, m.gated ? 1 : 0);
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

  nextPending(clot: string): InboxRow | undefined {
    const r = this.db.prepare("SELECT * FROM inbox WHERE clot = ? AND status = 'pending' ORDER BY rowid LIMIT 1").get(clot);
    return r ? toInbox(r) : undefined;
  }

  /** Every pending row of a Clot in the order they arrived, each with whether its event is urgent. */
  pendingRows(clot: string): InboxRow[] {
    return this.db
      .prepare("SELECT inbox.*, events.urgent AS ev_urgent FROM inbox LEFT JOIN events ON events.id = inbox.event_id WHERE inbox.clot = ? AND inbox.status = 'pending' ORDER BY inbox.rowid")
      .all(clot)
      .map(toInbox);
  }

  /** Forgets a removed Clot's waiting messages. Its chat, its sessions' transcripts and its volumes stay. */
  clearInbox(clot: string): void {
    this.db.prepare("DELETE FROM inbox WHERE clot = ? AND status = 'pending'").run(clot);
  }

  setGated(id: string, gated: boolean): void {
    this.db.prepare("UPDATE inbox SET gated = ? WHERE id = ?").run(gated ? 1 : 0, id);
  }

  /**
   * Gathers waiting event rows into one digest row, all or nothing: the digest's own row (an outsider's
   * when any of its events is), the list of its events, and the gathered rows set to "digested".
   * Returns the new row.
   */
  makeDigest(clot: string, rows: InboxRow[]): InboxRow {
    const first = rows[0]!;
    const id = `digest:${clot}:${first.id}`;
    return this.inTransaction(() => {
      this.enqueue({ id, clot, text: "", receivedAt: first.receivedAt, kind: "digest", eventId: id, outsider: rows.some((r) => r.outsider) });
      rows.forEach((r, position) => {
        this.db.prepare("INSERT OR IGNORE INTO digests (digest_id, event_id, position) VALUES (?, ?, ?)").run(id, r.eventId, position);
        this.setInboxStatus(r.id, "digested");
      });
      return this.pendingRows(clot).find((r) => r.id === id)!;
    });
  }

  /** The events of a digest, in the order they arrived. */
  digestEvents(digestId: string): EventRow[] {
    return this.db.prepare("SELECT events.* FROM digests JOIN events ON events.id = digests.event_id WHERE digests.digest_id = ? ORDER BY digests.position").all(digestId).map(toEvent);
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

  /** Stores an ask, open, and returns its ID. IDs are never reused. */
  createAsk(a: Pick<AskRow, "kind" | "clot" | "payload" | "summary" | "openedAt" | "deadline" | "dedupe" | "outsider">): number {
    const info = this.db
      .prepare("INSERT INTO user_asks (kind, clot, payload, summary, opened_at, deadline, dedupe, outsider) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(a.kind, a.clot, JSON.stringify(a.payload), a.summary, a.openedAt, a.deadline, a.dedupe, a.outsider ? 1 : 0);
    return Number(info.lastInsertRowid);
  }

  askById(id: number): AskRow | undefined {
    const r = this.db.prepare("SELECT * FROM user_asks WHERE id = ?").get(id);
    return r ? toAsk(r) : undefined;
  }

  /** Every ask not yet closed, in any state, oldest first: one Clot's, or everyone's. */
  openAsks(clot?: string): AskRow[] {
    const rows = clot === undefined ? this.db.prepare("SELECT * FROM user_asks ORDER BY id").all() : this.db.prepare("SELECT * FROM user_asks WHERE clot = ? ORDER BY id").all(clot);
    return rows.map(toAsk);
  }

  /** Sets the deadline of an ask that has none: one an earlier version opened. */
  setAskDeadline(id: number, deadline: number): void {
    this.db.prepare("UPDATE user_asks SET deadline = ? WHERE id = ? AND deadline IS NULL").run(deadline, id);
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
  closeAsk(id: number, clot: string, note: string | null, o: { inbox?: InboxInsert; onlyOpen?: boolean; also?: () => void; history?: { view: unknown; outcome: string; result: AskResult; closedAt: number; answerKey: string | null } } = {}): boolean {
    try {
      return this.db.transaction(() => {
        const before = o.history === undefined ? undefined : this.askById(id);
        const deleted = o.onlyOpen ? this.db.prepare("DELETE FROM user_asks WHERE id = ? AND state = 'open'").run(id) : this.db.prepare("DELETE FROM user_asks WHERE id = ?").run(id);
        if (deleted.changes !== 1) return false;
        if (before !== undefined && o.history !== undefined) this.conversation.recordAskOutcome({ id, clot, kind: before.kind, summary: before.summary, view: o.history.view, outcome: o.history.outcome, result: o.history.result, closedAt: o.history.closedAt, answerKey: o.history.answerKey });
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

  /** Logs a calendar change a Clot made. Returns its ID. */
  addCalendarChange(c: Omit<CalendarChangeRow, "id" | "confirmed" | "restored">): number {
    return Number(
      this.db
        .prepare("INSERT INTO calendar_changes (clot, account, op, uid, before, after, outsider, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(c.clot, c.account, c.op, c.uid, c.before, c.after, c.outsider ? 1 : 0, c.at).lastInsertRowid,
    );
  }

  /**
   * Records an undone change as the state it left, so calendar_list can show it before the feed
   * does. It stays claimed, so the next undo steps past it.
   */
  settleCalendarChange(id: number, s: { op: CalendarChangeRow["op"]; uid: string; before: string | null; after: string | null; restored: boolean }): void {
    this.db.prepare("UPDATE calendar_changes SET op = ?, uid = ?, before = ?, after = ?, restored = ?, restoring = 1 WHERE id = ?").run(s.op, s.uid, s.before, s.after, s.restored ? 1 : 0, id);
  }

  /** Records that the script said a removal was done. */
  confirmCalendarChange(id: number): void {
    this.db.prepare("UPDATE calendar_changes SET confirmed = 1 WHERE id = ?").run(id);
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

  /**
   * Stores a sweep's findings and its new record in one transaction, so that a restart never keeps a record
   * without its events. Returns the events that were new: a repeat is dropped by its ID.
   */
  recordSweep(record: string, events: ClotEvent[]): ClotEvent[] {
    return this.inTransaction(() => {
      const inserted = events.filter((event) => this.insertEvent(event));
      this.setState("sweep-record", record);
      return inserted;
    });
  }

  /** Deletes a state value only while it is still `value`. */
  deleteStateIf(key: string, value: string): void {
    this.db.prepare("DELETE FROM state WHERE key = ? AND value = ?").run(key, value);
  }

  /** Replaces a state value only while it is still `from`. Returns whether this call replaced it. */
  swapState(key: string, from: string, to: string): boolean {
    return this.db.prepare("UPDATE state SET value = ? WHERE key = ? AND value = ?").run(to, key, from).changes === 1;
  }

  /** Sets a state value only when the key is not set yet. Returns whether this call set it: only that caller carries on. */
  claimState(key: string, value: string): boolean {
    return this.db.prepare("INSERT OR IGNORE INTO state (key, value) VALUES (?, ?)").run(key, value).changes === 1;
  }

  /**
   * Books the cost of a model call, in one transaction. With a session, the cost is the increase of its
   * running total since the last one booked (a total that dropped is the cost in full); without one it is
   * the total. Nothing is booked for a cost of 0 or less. Returns what was booked.
   */
  bookSpend(a: { at: number; clot: string; who: string; sessionId?: string; total: number }): number {
    return this.inTransaction(() => {
      let usd = a.total;
      if (a.sessionId !== undefined) {
        const last = this.db.prepare("SELECT total FROM session_costs WHERE session_id = ?").pluck().get(a.sessionId) as number | undefined;
        usd = last !== undefined && a.total >= last ? a.total - last : a.total;
        this.db.prepare("INSERT INTO session_costs (session_id, total) VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET total = excluded.total").run(a.sessionId, a.total);
      }
      if (!(usd > 0)) return 0;
      this.db.prepare("INSERT INTO spend (at, clot, who, usd) VALUES (?, ?, ?, ?)").run(a.at, a.clot, a.who, usd);
      return usd;
    });
  }

  /** What was spent from a moment on, by Clot and kind of call. */
  spendSince(from: number): { clot: string; who: string; usd: number }[] {
    return this.db.prepare("SELECT clot, who, SUM(usd) AS usd FROM spend WHERE at >= ? GROUP BY clot, who ORDER BY MIN(id)").all(from) as { clot: string; who: string; usd: number }[];
  }

  /** The records whose key begins with a prefix, in key order. */
  statesWithPrefix(prefix: string): { key: string; value: string }[] {
    const rows: any[] = this.db.prepare("SELECT key, value FROM state WHERE substr(key, 1, ?) = ? ORDER BY key").all(prefix.length, prefix);
    return rows.map((r) => ({ key: r.key, value: r.value }));
  }
}
