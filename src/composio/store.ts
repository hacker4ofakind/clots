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
CREATE TABLE IF NOT EXISTS composio_deliveries (
  webhook_id TEXT PRIMARY KEY,
  user TEXT NOT NULL,
  slug TEXT NOT NULL,
  event_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  clipped INTEGER NOT NULL DEFAULT 0,
  received_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS composio_deliveries_event ON composio_deliveries (event_id);
CREATE INDEX IF NOT EXISTS composio_deliveries_user ON composio_deliveries (user, slug, received_at);
CREATE TABLE IF NOT EXISTS composio_reads (
  account TEXT NOT NULL,
  tool TEXT NOT NULL,
  args_hash TEXT NOT NULL,
  data TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (account, tool, args_hash)
);
`;

/** How many payloads of each trigger of each account are kept, and for how long. A delivery younger than the grace is never pruned, so its enrichment can still read it. */
export const DELIVERY_KEEP = { perTrigger: 5, maxAgeMs: 7 * 86_400_000, graceMs: 60 * 60_000, payloadChars: 64_000 };
/** A recipe read's data is served from the store for this long. */
export const READ_CACHE_MS = 24 * 3_600_000;

/** A trigger delivery kept for samples and for enrichment. */
export interface DeliveryRow {
  webhookId: string;
  /** `<toolkit>:<account>` */
  user: string;
  slug: string;
  /** The event the delivery became, or "" when none was stored. */
  eventId: string;
  /** The delivery's `data` as JSON text, clipped at 64,000 characters. */
  payload: string;
  /** The payload was longer and has been cut: it is no longer JSON. */
  clipped: boolean;
  receivedAt: number;
}

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

function toDelivery(r: any): DeliveryRow {
  return { webhookId: r.webhook_id, user: r.user, slug: r.slug, eventId: r.event_id, payload: r.payload, clipped: r.clipped === 1, receivedAt: r.received_at };
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

  /**
   * Keeps a trigger delivery (once per webhook ID), then prunes: per account and trigger the newest 5 stay, with anything
   * younger than an hour; anything older than 7 days goes. `payload` is clipped to 64,000 characters.
   */
  keepDelivery(d: Omit<DeliveryRow, "payload" | "clipped"> & { payload: unknown }): void {
    const text = typeof d.payload === "string" ? d.payload : JSON.stringify(d.payload ?? null);
    const clipped = text.length > DELIVERY_KEEP.payloadChars;
    this.db
      .prepare("INSERT OR IGNORE INTO composio_deliveries (webhook_id, user, slug, event_id, payload, clipped, received_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(d.webhookId, d.user, d.slug, d.eventId, clipped ? text.slice(0, DELIVERY_KEEP.payloadChars) : text, clipped ? 1 : 0, d.receivedAt);
    this.pruneDeliveries(d.receivedAt);
  }

  /** The delivery an event came from, by the event's ID. */
  deliveryByEvent(eventId: string): DeliveryRow | undefined {
    if (eventId === "") return undefined;
    const r = this.db.prepare("SELECT * FROM composio_deliveries WHERE event_id = ? ORDER BY received_at LIMIT 1").get(eventId);
    return r ? toDelivery(r) : undefined;
  }

  /** The kept deliveries of an account, newest first, at most 5 per trigger; of one trigger when `slug` is given. */
  samples(user: string, slug?: string): DeliveryRow[] {
    const rows = (slug === undefined
      ? this.db.prepare("SELECT * FROM composio_deliveries WHERE user = ? ORDER BY received_at DESC, rowid DESC").all(user)
      : this.db.prepare("SELECT * FROM composio_deliveries WHERE user = ? AND slug = ? ORDER BY received_at DESC, rowid DESC").all(user, slug)) as any[];
    const perSlug = new Map<string, number>();
    return rows.map(toDelivery).filter((r) => {
      const n = (perSlug.get(r.slug) ?? 0) + 1;
      perSlug.set(r.slug, n);
      return n <= DELIVERY_KEEP.perTrigger;
    });
  }

  /** One kept delivery by its webhook ID. */
  delivery(webhookId: string): DeliveryRow | undefined {
    const r = this.db.prepare("SELECT * FROM composio_deliveries WHERE webhook_id = ?").get(webhookId);
    return r ? toDelivery(r) : undefined;
  }

  /** Prunes by the rules of `keepDelivery`. Runs on each insert and in the daily check. */
  pruneDeliveries(now: number): void {
    this.db.prepare("DELETE FROM composio_deliveries WHERE received_at < ?").run(now - DELIVERY_KEEP.maxAgeMs);
    this.db
      .prepare(
        `DELETE FROM composio_deliveries WHERE received_at < ? AND webhook_id IN (
           SELECT webhook_id FROM (
             SELECT webhook_id, ROW_NUMBER() OVER (PARTITION BY user, slug ORDER BY received_at DESC, rowid DESC) AS n FROM composio_deliveries
           ) WHERE n > ?
         )`,
      )
      .run(now - DELIVERY_KEEP.graceMs, DELIVERY_KEEP.perTrigger);
  }

  /** A recipe read's data, when it was read within the last 24 hours. */
  cachedRead(account: string, tool: string, argsHash: string, now: number): unknown | undefined {
    const r: any = this.db.prepare("SELECT data, at FROM composio_reads WHERE account = ? AND tool = ? AND args_hash = ?").get(account, tool, argsHash);
    return r !== undefined && now - r.at < READ_CACHE_MS ? JSON.parse(r.data) : undefined;
  }

  keepRead(account: string, tool: string, argsHash: string, data: unknown, now: number): void {
    this.db
      .prepare("INSERT INTO composio_reads (account, tool, args_hash, data, at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(account, tool, args_hash) DO UPDATE SET data = excluded.data, at = excluded.at")
      .run(account, tool, argsHash, JSON.stringify(data ?? null), now);
  }

  pruneReads(now: number): void {
    this.db.prepare("DELETE FROM composio_reads WHERE at < ?").run(now - READ_CACHE_MS);
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
