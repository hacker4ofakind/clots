import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { Store } from "../src/store.js";

/** A database as stage 3 left it: Discord channel and category columns, and the old ask tables. */
function stage3Database(legacyColumns = false): string {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "clots-migrate-")), "clots.db");
  const db = new Database(file);
  const sql = fs.readFileSync(path.join(import.meta.dirname, "fixtures/stage3-schema.sql"), "utf8");
  db.exec(sql.split("\n").filter((line) => !line.startsWith("ALTER")).join("\n"));
  // Columns the schema did not have at first were added one by one; a column the schema has already is left as it is.
  for (const line of sql.split("\n").filter((l) => l.startsWith("ALTER"))) {
    try {
      db.exec(line);
    } catch (error) {
      if (!String(error).includes("duplicate column")) throw error;
    }
  }
  // A column an even older version added and later versions stopped using: a real database had `steered` on sessions.
  if (legacyColumns) for (const [table, column] of [["sessions", "steered"], ["user_asks", "steered"], ["inbox", "steered"]] as const) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 7`);
  db.prepare("INSERT INTO clots (name, category_id, paused_until) VALUES (?, ?, ?)").run("graphite", "cat-1", 1234);
  db.prepare("INSERT INTO sessions (id, clot, channel_id, seed, started, active, seed_reason, interrupted_kind, interrupted_outsider) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run("s1", "graphite", "ch-1", null, 1, 0, "context", "message", 0);
  db.prepare("INSERT INTO sessions (id, clot, channel_id, seed, started, active, seed_reason, interrupted_kind, interrupted_outsider, channel_removed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run("s2", "graphite", "ch-2", "the recap", 1, 1, "user", "event", 1, 0);
  db.prepare("INSERT INTO inbox (id, clot, channel_id, text, received_at, status, kind, outsider) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run("m1", "graphite", "ch-2", "hello", 5, "pending", "message", 0);
  const ask = db.prepare("INSERT INTO user_asks (kind, clot, channel_id, channel_name, payload, summary, state, opened_at, deadline, dedupe, outsider) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  ask.run("rule", "graphite", "a-1", "graphite-rule", '{"x":1}', "Rule", "open", 10, null, "d1", 0);
  ask.run("merge", "graphite", "a-2", "graphite-ask", '{"y":2}', "Merge", "posting", 11, null, "d2", 0);
  ask.run("choice", "graphite", "a-3", "graphite-choice", '{"z":3}', "Choice", "busy", 12, 99_000, "d3", 1);
  db.prepare("INSERT INTO proposals (clot, channel_id, channel_name, scope, edit, summary) VALUES (?, ?, ?, ?, ?, ?)").run("graphite", "p-1", "graphite-rule", "own", "{}", "Drop events where actor is `x`\nmore");
  db.prepare("INSERT INTO send_reviews (clot, channel_id, account, mail, opened_at) VALUES (?, ?, ?, ?, ?)").run("graphite", "r-1", "tady", JSON.stringify({ to: ["jane@x.com"], subject: "Hi" }), 0);
  db.prepare("INSERT INTO memory_questions (file, text, channel_id, channel_name) VALUES (?, ?, ?, ?)").run("global-clot-a.md", "x", "q-1", "home-memory");
  db.prepare("INSERT INTO asks (event_id, clot, channel_id) VALUES (?, ?, ?)").run("e-1", "graphite", "steer-1");
  db.prepare("INSERT INTO notes (clot, text) VALUES (?, ?)").run("graphite", "an old note");
  db.close();
  return file;
}

const columns = (file: string, table: string) => {
  const db = new Database(file, { readonly: true });
  const names = (db.pragma(`table_info(${table})`) as { name: string }[]).map((c) => c.name);
  db.close();
  return names;
};

describe("the migration off Discord's channels", () => {
  it("keeps the sessions, the inbox and the open asks, and drops the channel and category columns", () => {
    const file = stage3Database();
    const store = new Store(file);
    expect(store.getClot("graphite")).toEqual({ name: "graphite", pausedUntil: 1234 });
    expect(store.activeSession("graphite")).toMatchObject({ id: "s2", seed: "the recap", started: true, active: true, seedReason: "user", interruptedKind: "event", interruptedOutsider: true });
    expect(store.pendingRows("graphite").map((r) => [r.id, r.text])).toEqual([["m1", "hello"]]);
    expect(store.openAsks().map((a) => [a.id, a.kind, a.state, a.payload, a.deadline, a.outsider])).toEqual([
      [1, "rule", "open", { x: 1 }, null, false],
      [3, "choice", "busy", { z: 3 }, 99_000, true],
    ]);
    store.close();
    for (const [table, gone] of [["clots", "category_id"], ["sessions", "channel_id"], ["sessions", "channel_removed"], ["inbox", "channel_id"], ["user_asks", "channel_id"], ["user_asks", "channel_name"]] as const) {
      expect(columns(file, table)).not.toContain(gone);
    }
  });

  it("migrates a database that has columns an older version left behind, and drops them", () => {
    const file = stage3Database(true);
    const store = new Store(file);
    expect(store.activeSession("graphite")).toMatchObject({ id: "s2", seed: "the recap", started: true, active: true });
    expect(store.openAsks().map((a) => [a.id, a.kind, a.state])).toEqual([[1, "rule", "open"], [3, "choice", "busy"]]);
    expect(store.pendingRows("graphite").map((r) => r.id)).toEqual(["m1"]);
    store.close();
    expect(columns(file, "sessions")).not.toContain("steered");
    expect(columns(file, "user_asks")).not.toContain("steered");
  });

  it("drops the old ask tables, leaving a note for each rule proposal and send review", () => {
    const file = stage3Database();
    const store = new Store(file);
    expect(store.notes("graphite").map((n) => n.text)).toEqual([
      "an old note",
      "Withdrawn when the daemon was updated: the rule change Drop events where actor is `x`. Ask again if it still makes sense.",
      'Withdrawn when the daemon was updated: the email to jane@x.com, "Hi" (tady). Ask again if it still makes sense.',
    ]);
    store.close();
    const db = new Database(file, { readonly: true });
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name);
    db.close();
    for (const gone of ["proposals", "send_reviews", "memory_questions", "asks"]) expect(tables).not.toContain(gone);
    for (const made of ["messages", "message_images", "ask_history", "ui_prefs"]) expect(tables).toContain(made);
  });

  it("runs once: a second open changes nothing, and new rows work without channels", () => {
    const file = stage3Database();
    new Store(file).close();
    const store = new Store(file);
    expect(store.notes("graphite")).toHaveLength(3);
    store.createSession({ id: "s3", clot: "graphite", seed: "next", seedReason: "context" });
    expect(store.activeSession("graphite")!.id).toBe("s3");
    expect(store.createAsk({ kind: "rule", clot: "graphite", payload: {}, summary: "s", openedAt: 0, deadline: 1, dedupe: "n", outsider: false })).toBeGreaterThan(3);
    expect(store.enqueue({ id: "m2", clot: "graphite", text: "x", receivedAt: 1 })).toBe(true);
    store.close();
  });

  it("opens a new database without trouble, and records that it is migrated", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "clots-fresh-")), "clots.db");
    new Store(file).close();
    const db = new Database(file, { readonly: true });
    expect(db.pragma("user_version", { simple: true })).toBe(1);
    db.close();
  });
});
