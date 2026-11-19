import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { Store } from "../src/store.js";

let store: Store;
beforeEach(() => {
  store = new Store(":memory:");
});

describe("Composio accounts", () => {
  it("round-trips an account, keeping what is not set again", () => {
    expect(store.composio.account("linear:proton")).toBeUndefined();
    store.composio.setAccount("linear:proton", { connectionId: "ca_1", authConfigId: "ac_1", keyHash: "h1", status: "active" });
    store.composio.setAccount("linear:proton", { identity: "user-1" });
    expect(store.composio.account("linear:proton")).toEqual({ user: "linear:proton", connectionId: "ca_1", authConfigId: "ac_1", keyHash: "h1", identity: "user-1", status: "active" });
    expect(store.composio.userByConnection("ca_1")).toBe("linear:proton");
    expect(store.composio.userByConnection("ca_2")).toBeUndefined();
    store.composio.setAccount("linear:proton", { connectionId: "ca_2" });
    expect(store.composio.userByConnection("ca_1")).toBeUndefined();
    expect(store.composio.userByConnection("ca_2")).toBe("linear:proton");
    expect(store.composio.accounts().map((a) => a.user)).toEqual(["linear:proton"]);
    store.composio.deleteAccount("linear:proton");
    expect(store.composio.account("linear:proton")).toBeUndefined();
  });
});

describe("Composio triggers", () => {
  it("keeps one instance per user, slug and config key", () => {
    store.composio.setTrigger("linear:proton", "LINEAR_PRIVATE_TEAM_ISSUE_CREATED", "team-a", "ti_1");
    store.composio.setTrigger("linear:proton", "LINEAR_PRIVATE_TEAM_ISSUE_CREATED", "team-b", "ti_2");
    store.composio.setTrigger("linear:proton", "LINEAR_PRIVATE_TEAM_ISSUE_CREATED", "team-a", "ti_3");
    expect(store.composio.trigger("linear:proton", "LINEAR_PRIVATE_TEAM_ISSUE_CREATED", "team-a")).toBe("ti_3");
    expect(store.composio.triggers("linear:proton")).toEqual([
      { user: "linear:proton", slug: "LINEAR_PRIVATE_TEAM_ISSUE_CREATED", key: "team-a", triggerId: "ti_3" },
      { user: "linear:proton", slug: "LINEAR_PRIVATE_TEAM_ISSUE_CREATED", key: "team-b", triggerId: "ti_2" },
    ]);
    expect(store.composio.triggers("notion:main")).toEqual([]);
    store.composio.deleteTrigger("linear:proton", "LINEAR_PRIVATE_TEAM_ISSUE_CREATED", "team-a");
    expect(store.composio.trigger("linear:proton", "LINEAR_PRIVATE_TEAM_ISSUE_CREATED", "team-a")).toBeUndefined();
    expect(store.composio.allTriggers()).toHaveLength(1);
  });
});

describe("Composio writes", () => {
  const write = { clot: "graphite", account: "linear:proton", slug: "LINEAR_CREATE_LINEAR_ISSUE", args: { title: "x" }, at: 1_000 };

  it("round-trips a write with its result, before-values, inverse and the objects it touched", () => {
    const id = store.composio.addWrite({ ...write, before: { title: "old" }, inverse: { slug: "LINEAR_ARCHIVE_ISSUE" } });
    expect(store.composio.write(id)).toMatchObject({ id, clot: "graphite", account: "linear:proton", slug: "LINEAR_CREATE_LINEAR_ISSUE", args: { title: "x" }, result: undefined, before: { title: "old" }, inverse: { slug: "LINEAR_ARCHIVE_ISSUE" }, undone: false, outcome: "pending", touched: [], created: [] });
    store.composio.finishWrite(id, { outcome: "ran", result: { id: "issue-1" }, touched: ["issue-1"], created: ["issue-1"] });
    expect(store.composio.write(id)).toMatchObject({ outcome: "ran", result: { id: "issue-1" }, touched: ["issue-1"], created: ["issue-1"] });
  });

  it("finds what a Clot's write touched in a window, and what it created", () => {
    const id = store.composio.addWrite(write);
    store.composio.finishWrite(id, { outcome: "ran", result: {}, touched: ["a", "b"], created: ["a"] });
    expect(store.composio.touchedSince("linear:proton", "b", 500)).toBe(true);
    expect(store.composio.touchedSince("linear:proton", "b", 1_001)).toBe(false);
    expect(store.composio.touchedSince("notion:main", "b", 500)).toBe(false);
    expect(store.composio.createdByClot("linear:proton", "a")).toBe(true);
    expect(store.composio.createdByClot("linear:proton", "b")).toBe(false);
    expect(store.composio.createdByClot("notion:main", "a")).toBe(false);
  });

  it("hands out this Clot's newest un-undone write with an inverse, once each, newest first", () => {
    const first = store.composio.addWrite({ ...write, inverse: { slug: "A" }, at: 1 });
    const second = store.composio.addWrite({ ...write, inverse: { slug: "B" }, at: 2 });
    store.composio.addWrite({ ...write, at: 3 }); // no inverse
    store.composio.addWrite({ ...write, clot: "other", inverse: { slug: "C" }, at: 4 });
    for (const id of [first, second]) store.composio.finishWrite(id, { outcome: "ran", result: {}, touched: [], created: [] });
    expect(store.composio.latestUndoable("graphite")?.id).toBe(second);
    expect(store.composio.claimUndo(second)).toBe(true);
    expect(store.composio.claimUndo(second)).toBe(false);
    expect(store.composio.latestUndoable("graphite")?.id).toBe(first);
    store.composio.releaseUndo(second);
    expect(store.composio.latestUndoable("graphite")?.id).toBe(second);
  });

  it("sets the inverse once the result is known", () => {
    const id = store.composio.addWrite(write);
    store.composio.finishWrite(id, { outcome: "ran", result: { id: "x" }, touched: ["x"], created: ["x"] });
    expect(store.composio.latestUndoable("graphite")).toBeUndefined();
    store.composio.setWriteInverse(id, { slug: "LINEAR_ARCHIVE_ISSUE", args: { issue_id: "x" } });
    expect(store.composio.latestUndoable("graphite")?.inverse).toEqual({ slug: "LINEAR_ARCHIVE_ISSUE", args: { issue_id: "x" } });
  });

  it("does not offer a write that did not run for undo", () => {
    const id = store.composio.addWrite({ ...write, inverse: { slug: "B" } });
    expect(store.composio.latestUndoable("graphite")).toBeUndefined();
    store.composio.finishWrite(id, { outcome: "unknown", touched: [], created: [] });
    expect(store.composio.latestUndoable("graphite")).toBeUndefined();
  });
});

describe("the 2e migration", () => {
  it("empties the calendar log of the Apps Script era once, and keeps what is logged after", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "clots-store-")), "clots.db");
    const old = new Store(file);
    old.addCalendarChange({ clot: "graphite", account: "me", op: "create", uid: "ical-uid@google.com", before: null, after: "{}", outsider: false, at: 1 });
    // A database from before 2e has no record of the migration.
    old.deleteState("composio.migrated");
    old.close();
    const upgraded = new Store(file);
    expect(upgraded.latestCalendarChange("graphite")).toBeUndefined();
    upgraded.addCalendarChange({ clot: "graphite", account: "me", op: "create", uid: "google-id", before: null, after: "{}", outsider: false, at: 2 });
    upgraded.close();
    expect(new Store(file).latestCalendarChange("graphite")).toMatchObject({ uid: "google-id" });
  });

  it("starts a new database already migrated", () => {
    expect(store.getState("composio.migrated")).toBe("1");
  });
});
