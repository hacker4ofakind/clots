import type Database from "better-sqlite3";

/** The tables Composio's component keeps, given the Store's database handle so that src/store.ts does not grow. */
export const COMPOSIO_SCHEMA = `
CREATE TABLE IF NOT EXISTS composio_accounts (
  user TEXT PRIMARY KEY,
  connection_id TEXT,
  auth_config_id TEXT,
  key_hash TEXT,
  identity TEXT,
  status TEXT
);
CREATE TABLE IF NOT EXISTS composio_triggers (
  user TEXT NOT NULL,
  slug TEXT NOT NULL,
  key TEXT NOT NULL,
  trigger_id TEXT NOT NULL,
  PRIMARY KEY (user, slug, key)
);
CREATE TABLE IF NOT EXISTS composio_writes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  clot TEXT NOT NULL,
  account TEXT NOT NULL,
  slug TEXT NOT NULL,
  args TEXT NOT NULL,
  result TEXT,
  before TEXT,
  inverse TEXT,
  undone INTEGER NOT NULL DEFAULT 0,
  at INTEGER NOT NULL,
  outcome TEXT NOT NULL DEFAULT 'pending',
  touched TEXT NOT NULL DEFAULT '[]',
  created TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS composio_writes_clot ON composio_writes (clot, id);
`;

export interface ComposioAccountRow {
  /** `<toolkit>:<account>`: the Composio user. */
  user: string;
  connectionId?: string;
  authConfigId?: string;
  /** SHA-256 of the key the connection was made with. Never the key. */
  keyHash?: string;
  /** The connection's own user ID at the service, for dropping events the Clots caused. */
  identity?: string;
  status?: string;
}

export interface ComposioTriggerRow {
  user: string;
  slug: string;
  /** A hash of the instance's config: one slug can run once per Linear team. */
  key: string;
  triggerId: string;
}

/** How a write ended: it ran, its outcome is unknown (a timeout), it failed, or it has not finished. */
export type WriteOutcome = "pending" | "ran" | "unknown" | "failed";

export interface ComposioWriteRow {
  id: number;
  clot: string;
  account: string;
  slug: string;
  args: Record<string, unknown>;
  result?: unknown;
  /** The object's fields before an update, read before it ran. */
  before?: unknown;
  /** How to reverse it, from the inverse table. Absent: no undo. */
  inverse?: unknown;
  undone: boolean;
  at: number;
  outcome: WriteOutcome;
  /** The IDs of the objects the write created or changed, from its result. */
  touched: string[];
  /** The IDs of the objects the write created. */
  created: string[];
}

const json = (value: unknown): string | null => (value === undefined ? null : JSON.stringify(value));
const parse = (text: string | null): unknown => (text === null ? undefined : JSON.parse(text));

function toWrite(r: any): ComposioWriteRow {
  return {
    id: r.id,
    clot: r.clot,
    account: r.account,
    slug: r.slug,
    args: JSON.parse(r.args),
    result: parse(r.result),
    before: parse(r.before),
    inverse: parse(r.inverse),
    undone: r.undone === 1,
    at: r.at,
    outcome: r.outcome,
    touched: JSON.parse(r.touched),
    created: JSON.parse(r.created),
  };
}

function toTrigger(r: any): ComposioTriggerRow {
  return { user: r.user, slug: r.slug, key: r.key, triggerId: r.trigger_id };
}

function toAccount(r: any): ComposioAccountRow {
  return {
    user: r.user,
    ...(r.connection_id === null ? {} : { connectionId: r.connection_id }),
    ...(r.auth_config_id === null ? {} : { authConfigId: r.auth_config_id }),
    ...(r.key_hash === null ? {} : { keyHash: r.key_hash }),
    ...(r.identity === null ? {} : { identity: r.identity }),
    ...(r.status === null ? {} : { status: r.status }),
  };
}

const ACCOUNT_COLUMNS: [keyof Omit<ComposioAccountRow, "user">, string][] = [
  ["connectionId", "connection_id"],
  ["authConfigId", "auth_config_id"],
  ["keyHash", "key_hash"],
  ["identity", "identity"],
  ["status", "status"],
];

export class ComposioStore {
  constructor(private db: Database.Database) {
    db.exec(COMPOSIO_SCHEMA);
  }

  account(user: string): ComposioAccountRow | undefined {
    const r: any = this.db.prepare("SELECT * FROM composio_accounts WHERE user = ?").get(user);
    return r ? toAccount(r) : undefined;
  }

  accounts(): ComposioAccountRow[] {
    return (this.db.prepare("SELECT * FROM composio_accounts ORDER BY user").all() as any[]).map(toAccount);
  }

  /** Sets the fields given and keeps the rest. */
  setAccount(user: string, fields: Partial<Omit<ComposioAccountRow, "user">>): void {
    this.db.prepare("INSERT OR IGNORE INTO composio_accounts (user) VALUES (?)").run(user);
    for (const [field, column] of ACCOUNT_COLUMNS) {
      if (field in fields) this.db.prepare(`UPDATE composio_accounts SET ${column} = ? WHERE user = ?`).run(fields[field] ?? null, user);
    }
  }

  deleteAccount(user: string): void {
    this.db.prepare("DELETE FROM composio_accounts WHERE user = ?").run(user);
  }

  /** The user whose connection this is, from a delivery's connected account ID. */
  userByConnection(connectionId: string): string | undefined {
    return this.db.prepare("SELECT user FROM composio_accounts WHERE connection_id = ?").pluck().get(connectionId) as string | undefined;
  }

  trigger(user: string, slug: string, key: string): string | undefined {
    return this.db.prepare("SELECT trigger_id FROM composio_triggers WHERE user = ? AND slug = ? AND key = ?").pluck().get(user, slug, key) as string | undefined;
  }

  triggers(user: string): ComposioTriggerRow[] {
    return (this.db.prepare("SELECT * FROM composio_triggers WHERE user = ? ORDER BY slug, key").all(user) as any[]).map(toTrigger);
  }

  allTriggers(): ComposioTriggerRow[] {
    return (this.db.prepare("SELECT * FROM composio_triggers ORDER BY user, slug, key").all() as any[]).map(toTrigger);
  }

  setTrigger(user: string, slug: string, key: string, triggerId: string): void {
    this.db
      .prepare("INSERT INTO composio_triggers (user, slug, key, trigger_id) VALUES (?, ?, ?, ?) ON CONFLICT(user, slug, key) DO UPDATE SET trigger_id = excluded.trigger_id")
      .run(user, slug, key, triggerId);
  }

  deleteTrigger(user: string, slug: string, key: string): void {
    this.db.prepare("DELETE FROM composio_triggers WHERE user = ? AND slug = ? AND key = ?").run(user, slug, key);
  }

  /** Logs a write before it runs, with what its undo needs. Returns its ID. */
  addWrite(w: { clot: string; account: string; slug: string; args: Record<string, unknown>; before?: unknown; inverse?: unknown; at: number }): number {
    return Number(
      this.db
        .prepare("INSERT INTO composio_writes (clot, account, slug, args, before, inverse, at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(w.clot, w.account, w.slug, JSON.stringify(w.args), json(w.before), json(w.inverse), w.at).lastInsertRowid,
    );
  }

  /** Records how a write ended, and the objects its result names. */
  finishWrite(id: number, f: { outcome: WriteOutcome; result?: unknown; touched: string[]; created: string[] }): void {
    this.db.prepare("UPDATE composio_writes SET outcome = ?, result = ?, touched = ?, created = ? WHERE id = ?").run(f.outcome, json(f.result), JSON.stringify(f.touched), JSON.stringify(f.created), id);
  }

  /** Records how to reverse a write, once its result is known: an inverse is often made of what the write created. */
  setWriteInverse(id: number, inverse: unknown): void {
    this.db.prepare("UPDATE composio_writes SET inverse = ? WHERE id = ?").run(json(inverse), id);
  }

  write(id: number): ComposioWriteRow | undefined {
    const r = this.db.prepare("SELECT * FROM composio_writes WHERE id = ?").get(id);
    return r ? toWrite(r) : undefined;
  }

  /** Whether a write in this account touched the object since a time: such an event is the Clots' own doing. */
  touchedSince(account: string, objectId: string, since: number): boolean {
    return (
      this.db
        .prepare("SELECT 1 FROM composio_writes, json_each(composio_writes.touched) WHERE account = ? AND at >= ? AND json_each.value = ? LIMIT 1")
        .get(account, since, objectId) !== undefined
    );
  }

  /** Whether a Clot's own write created the object. */
  createdByClot(account: string, objectId: string): boolean {
    return this.db.prepare("SELECT 1 FROM composio_writes, json_each(composio_writes.created) WHERE account = ? AND json_each.value = ? LIMIT 1").get(account, objectId) !== undefined;
  }

  /** This Clot's newest write that ran, has an inverse and is not undone. */
  latestUndoable(clot: string): ComposioWriteRow | undefined {
    const r = this.db.prepare("SELECT * FROM composio_writes WHERE clot = ? AND undone = 0 AND inverse IS NOT NULL AND outcome = 'ran' ORDER BY id DESC LIMIT 1").get(clot);
    return r ? toWrite(r) : undefined;
  }

  /** Marks a write as being undone. Returns false when another undo already took it. */
  claimUndo(id: number): boolean {
    return this.db.prepare("UPDATE composio_writes SET undone = 1 WHERE id = ? AND undone = 0").run(id).changes === 1;
  }

  releaseUndo(id: number): void {
    this.db.prepare("UPDATE composio_writes SET undone = 0 WHERE id = ?").run(id);
  }
}
