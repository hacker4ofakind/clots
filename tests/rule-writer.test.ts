import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { ClotEvent } from "../src/events/types.js";
import { RuleWriter } from "../src/rule-writer.js";
import { parseRuleFile, Rulebook } from "../src/rulebook.js";
import { Store } from "../src/store.js";

const event: ClotEvent = { id: "d-1", source: "github", kind: "pr_opened", repo: "octo/widgets", actor: "dependabot[bot]", title: "Bump lodash", body: "", url: "u", ref: "9", subject: "pr:9", automated: true, receivedAt: 0 };

let dir: string;
let rulebook: Rulebook;
let store: Store;
let commits: { file: string; message: string }[];
let writer: RuleWriter;

const read = (name: string) => fs.readFileSync(path.join(dir, `${name}.yaml`), "utf8");

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "clots-writer-"));
  rulebook = new Rulebook(dir, ["graphite"], () => undefined);
  rulebook.ensure();
  rulebook.load();
  store = new Store(":memory:");
  commits = [];
  writer = new RuleWriter({ rulebook, store, commit: (file, message) => void commits.push({ file: path.basename(file), message }) });
});

describe("RuleWriter", () => {
  it("writes an edit to the Clot's own file, puts it in force, commits it and logs it", () => {
    const done = writer.apply("graphite", "own", { op: "add_prefilter", rule: { actor: "dependabot[bot]" } });
    expect(done).toEqual({ ok: true, file: "graphite", summary: "Drop events where actor is `dependabot[bot]`" });
    expect(parseRuleFile(read("graphite")).prefilters).toEqual([{ actor: "dependabot[bot]" }]);
    expect(read("graphite")).toContain("# Rules for the graphite Clot.");
    expect(rulebook.isDropped("graphite", event)).toBe(true);
    expect(commits).toEqual([{ file: "graphite.yaml", message: "graphite: Drop events where actor is `dependabot[bot]`" }]);
    expect(store.lastRuleEdit("graphite")).toMatchObject({ file: "graphite", summary: "Drop events where actor is `dependabot[bot]`" });
    expect(fs.readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("writes a global edit to the global file", () => {
    expect(writer.apply("graphite", "global", { op: "add_guidance", line: "Billing is urgent." })).toMatchObject({ ok: true, file: "global" });
    expect(parseRuleFile(read("global")).triage).toEqual(["Billing is urgent."]);
    expect(parseRuleFile(read("graphite")).triage).toEqual([]);
    expect(store.lastRuleEdit("graphite")).toMatchObject({ file: "global" });
  });

  it("previews without changing anything", () => {
    const before = read("graphite");
    expect(writer.preview("graphite", "own", { op: "add_guidance", line: "Billing is urgent." })).toEqual({ ok: true, file: "graphite", summary: 'Add triage guidance: "Billing is urgent."' });
    expect(read("graphite")).toBe(before);
    expect(commits).toEqual([]);
    expect(store.lastRuleEdit("graphite")).toBeUndefined();
  });

  it("refuses an edit that does not fit, and one to a file that is broken, and writes nothing", () => {
    expect(writer.apply("graphite", "own", { op: "remove_standing", name: "nope" })).toMatchObject({ ok: false });
    fs.writeFileSync(path.join(dir, "graphite.yaml"), "prefilters: [\n");
    const refused = writer.apply("graphite", "own", { op: "add_guidance", line: "x" });
    expect(refused.ok).toBe(false);
    expect(refused.ok ? "" : refused.reason).toContain("cannot be used as it is");
    expect(read("graphite")).toBe("prefilters: [\n");
    expect(commits).toEqual([]);
    expect(store.lastRuleEdit("graphite")).toBeUndefined();
  });

  it("keeps the edit when the commit fails", () => {
    writer = new RuleWriter({
      rulebook,
      store,
      commit: () => {
        throw new Error("no git here");
      },
    });
    expect(writer.apply("graphite", "own", { op: "add_guidance", line: "Billing is urgent." })).toMatchObject({ ok: true });
    expect(rulebook.guidance("graphite")).toBe("Billing is urgent.");
  });

  it("undoes edits one at a time, newest first, and says when none is left", () => {
    writer.apply("graphite", "own", { op: "add_prefilter", rule: { actor: "dependabot[bot]" } });
    writer.apply("graphite", "global", { op: "add_guidance", line: "Billing is urgent." });

    expect(writer.undo("graphite")).toEqual({ ok: true, file: "global", summary: 'Undid: Add triage guidance: "Billing is urgent."' });
    expect(parseRuleFile(read("global")).triage).toEqual([]);
    expect(writer.undo("graphite")).toMatchObject({ ok: true, file: "graphite" });
    expect(rulebook.isDropped("graphite", event)).toBe(false);
    expect(writer.undo("graphite")).toEqual({ ok: false, reason: "There is no edit made from chat left to undo." });
    expect(commits).toHaveLength(4);
  });

  it("leaves the Clot a note about an undo, and none when nothing was undone", () => {
    writer.apply("graphite", "own", { op: "add_guidance", line: "Billing is urgent." });
    expect(store.notes("graphite")).toEqual([]);
    writer.undo("graphite");
    expect(store.notes("graphite").map((note) => note.text)).toEqual([
      'The user undid this rule change, and it is no longer in force: Add triage guidance: "Billing is urgent.". Whatever the user said when asking for it no longer applies either.',
    ]);
    writer.undo("graphite");
    expect(store.notes("graphite")).toHaveLength(1);
  });

  it("does not undo an undo", () => {
    writer.apply("graphite", "own", { op: "add_guidance", line: "Billing is urgent." });
    writer.undo("graphite");
    expect(writer.undo("graphite")).toMatchObject({ ok: false });
    expect(rulebook.guidance("graphite")).toBe("");
  });

  it("says so when an edit can no longer be undone, changes nothing, and skips it the next time", () => {
    writer.apply("graphite", "own", { op: "add_prefilter", rule: { actor: "dependabot[bot]" } });
    writer.apply("graphite", "own", { op: "add_guidance", line: "Billing is urgent." });
    // The user removed the line by hand in the meantime.
    fs.writeFileSync(path.join(dir, "graphite.yaml"), "prefilters:\n  - actor: dependabot[bot]\n");

    const failed = writer.undo("graphite");
    expect(failed.ok).toBe(false);
    expect(failed.ok ? "" : failed.reason).toContain("could not be undone");
    expect(read("graphite")).toBe("prefilters:\n  - actor: dependabot[bot]\n");

    expect(writer.undo("graphite")).toMatchObject({ ok: true });
    expect(parseRuleFile(read("graphite")).prefilters).toEqual([]);
  });

  it("does not put back an older standing rule over one another Clot has set since", () => {
    const rule = (template: string) => ({ op: "set_standing" as const, rule: { name: "ack", trigger: { kind: "issue_opened" as const }, via: "github_comment" as const, template } });
    writer.apply("graphite", "global", rule("First."));
    writer.apply("graphite", "global", rule("Graphite's."));
    writer.apply("other", "global", rule("The other Clot's, approved later."));

    const failed = writer.undo("graphite");
    expect(failed.ok ? "" : failed.reason).toContain("has been changed since");
    expect(parseRuleFile(read("global")).standing[0].template).toBe("The other Clot's, approved later.");
    // That edit is skipped from now on; the one before it no longer fits either.
    expect(writer.undo("graphite")).toMatchObject({ ok: false });
    expect(parseRuleFile(read("global")).standing[0].template).toBe("The other Clot's, approved later.");
  });

  it("keeps an edit the next one to undo when the disk fails, and writes nothing", () => {
    writer.apply("graphite", "own", { op: "add_prefilter", rule: { actor: "dependabot[bot]" } });
    writer.apply("graphite", "own", { op: "add_guidance", line: "Billing is urgent." });
    const before = read("graphite");

    // A folder where the writer puts its temporary file: nothing can be written.
    const inTheWay = path.join(dir, "graphite.yaml.tmp");
    fs.mkdirSync(inTheWay);
    const failed = writer.undo("graphite");
    expect(failed).toMatchObject({ ok: false, retry: true });
    expect(failed.ok ? "" : failed.reason).toContain("could not be undone just now");
    expect(writer.apply("graphite", "own", { op: "add_guidance", line: "x" })).toMatchObject({ ok: false, retry: true });
    expect(store.notes("graphite")).toEqual([]);
    expect(read("graphite")).toBe(before);

    fs.rmdirSync(inTheWay);
    expect(writer.undo("graphite")).toMatchObject({ ok: true, summary: 'Undid: Add triage guidance: "Billing is urgent."' });
    expect(parseRuleFile(read("graphite"))).toMatchObject({ prefilters: [{ actor: "dependabot[bot]" }], triage: [] });
  });

  it("says so when an edit's undo record cannot be saved, and does not undo an older edit in its place", () => {
    let failing = false;
    const flaky: Store = Object.create(store);
    flaky.logRuleEdit = (edit) => {
      if (failing) throw new Error("database is locked");
      store.logRuleEdit(edit);
    };
    writer = new RuleWriter({ rulebook, store: flaky, commit: () => undefined });
    writer.apply("graphite", "own", { op: "add_guidance", line: "Earlier." });

    failing = true;
    expect(writer.apply("graphite", "own", { op: "add_guidance", line: "Latest." })).toEqual({ ok: true, file: "graphite", summary: 'Add triage guidance: "Latest."', unlogged: true });
    expect(writer.undo("graphite")).toMatchObject({ ok: false, retry: true });
    expect(parseRuleFile(read("graphite")).triage).toEqual(["Earlier.", "Latest."]);

    failing = false;
    expect(writer.undo("graphite")).toMatchObject({ ok: true, summary: 'Undid: Add triage guidance: "Latest."' });
    expect(writer.undo("graphite")).toMatchObject({ ok: true, summary: 'Undid: Add triage guidance: "Earlier."' });
    expect(parseRuleFile(read("graphite")).triage).toEqual([]);
  });

  it("commits in the rulebook's own repository", () => {
    writer = new RuleWriter({ rulebook, store });
    writer.apply("graphite", "own", { op: "add_guidance", line: "Billing is urgent." });
    const log = execFileSync("git", ["-C", dir, "log", "--format=%s"], { encoding: "utf8" }).trim();
    expect(log).toBe('graphite: Add triage guidance: "Billing is urgent."');
  });
});
