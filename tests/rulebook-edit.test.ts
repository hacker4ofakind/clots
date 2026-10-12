import { describe, expect, it } from "vitest";
import { parseRuleFile, type StandingRule } from "../src/rulebook.js";
import { applyEdit, describeEdit, EditRefused, type RuleEdit } from "../src/rulebook-edit.js";

const HAND_WRITTEN = [
  "# Rules for the graphite Clot.",
  "prefilters:",
  "  # bots we never want to hear from",
  "  - actor: dependabot[bot]",
  "",
  "# what matters",
  "triage:",
  "  - Billing is urgent.",
  "standing: []",
  "",
].join("\n");

const ack: StandingRule = { name: "ack-issue", trigger: { kind: "issue_opened" }, via: "github_comment", template: "Thanks, @{actor}." };

/** Applies an edit and then its inverse, and returns both texts. */
function roundTrip(text: string, edit: RuleEdit): { after: string; back: string } {
  const done = applyEdit(text, edit);
  return { after: done.text, back: applyEdit(done.text, done.inverse).text };
}

describe("applyEdit", () => {
  it("adds a pre-filter and keeps everything written by hand", () => {
    const done = applyEdit(HAND_WRITTEN, { op: "add_prefilter", rule: { kind: "pr_opened", titleContains: "wip" } });
    expect(parseRuleFile(done.text).prefilters).toEqual([{ actor: "dependabot[bot]" }, { kind: "pr_opened", titleContains: "wip" }]);
    for (const kept of ["# Rules for the graphite Clot.", "# bots we never want to hear from", "# what matters", "- Billing is urgent."]) expect(done.text).toContain(kept);
    expect(done.inverse).toEqual({ op: "remove_prefilter", rule: { kind: "pr_opened", titleContains: "wip" } });
    expect(done.summary).toBe('Drop events where kind is `pr_opened` and title contains "wip"');
  });

  it("writes into the starter file's empty lists as a block list", () => {
    const starter = "# comment\nprefilters: []\n\ntriage: []\n\nstanding: []\n";
    const done = applyEdit(starter, { op: "add_prefilter", rule: { actor: "dependabot[bot]" } });
    expect(done.text).toContain("prefilters:\n  - actor: dependabot[bot]");
    expect(done.text).toContain("# comment");
  });

  it("writes a list it has emptied as [] on the key's line", () => {
    const done = applyEdit(HAND_WRITTEN, { op: "remove_guidance", line: "Billing is urgent." });
    expect(done.text).toContain("triage: []");
    expect(done.text).toContain("# what matters");
  });

  it("works on an empty file and on one that holds only comments", () => {
    expect(parseRuleFile(applyEdit("", { op: "add_guidance", line: "Typos need no action." }).text).triage).toEqual(["Typos need no action."]);
    const done = applyEdit("# nothing yet\n", { op: "add_prefilter", rule: { actor: "someone" } });
    expect(parseRuleFile(done.text).prefilters).toEqual([{ actor: "someone" }]);
    expect(done.text).toContain("# nothing yet");
  });

  it("removes a pre-filter whatever the letter case, and gives back the rule as the file had it", () => {
    const done = applyEdit(HAND_WRITTEN, { op: "remove_prefilter", rule: { actor: "Dependabot[bot]" } });
    expect(parseRuleFile(done.text).prefilters).toEqual([]);
    expect(done.inverse).toEqual({ op: "add_prefilter", rule: { actor: "dependabot[bot]" } });
  });

  it("adds and removes a triage line, tidied to one line", () => {
    const added = applyEdit(HAND_WRITTEN, { op: "add_guidance", line: "  Typos in docs\n need no action. " });
    expect(parseRuleFile(added.text).triage).toEqual(["Billing is urgent.", "Typos in docs need no action."]);
    expect(added.inverse).toEqual({ op: "remove_guidance", line: "Typos in docs need no action." });
    expect(parseRuleFile(applyEdit(added.text, { op: "remove_guidance", line: "Billing is urgent." }).text).triage).toEqual(["Typos in docs need no action."]);
  });

  it("turns a single block of triage text into a list when it adds a line", () => {
    const done = applyEdit("triage: Ignore typo reports.\n", { op: "add_guidance", line: "Billing is urgent." });
    expect(parseRuleFile(done.text).triage).toEqual(["Ignore typo reports.", "Billing is urgent."]);
  });

  it("adds a standing rule, replaces one of the same name, and removes one", () => {
    const added = applyEdit(HAND_WRITTEN, { op: "set_standing", rule: ack });
    expect(parseRuleFile(added.text).standing).toEqual([ack]);
    expect(added.inverse).toEqual({ op: "remove_standing", name: "ack-issue" });

    const changed: StandingRule = { ...ack, template: "Thank you, @{actor}." };
    const replaced = applyEdit(added.text, { op: "set_standing", rule: changed });
    expect(parseRuleFile(replaced.text).standing).toEqual([changed]);
    expect(replaced.inverse).toEqual({ op: "set_standing", rule: ack });
    expect(replaced.summary).toContain("It replaces the rule as it is now");
    expect(replaced.summary).toContain("Thanks, @{actor}.");

    const removed = applyEdit(replaced.text, { op: "remove_standing", name: "ack-issue" });
    expect(parseRuleFile(removed.text).standing).toEqual([]);
    expect(removed.inverse).toEqual({ op: "set_standing", rule: changed });
  });

  it("is undone exactly by its inverse", () => {
    const edits: RuleEdit[] = [
      { op: "add_prefilter", rule: { kind: "comment", actor: "vercel[bot]" } },
      { op: "remove_prefilter", rule: { actor: "dependabot[bot]" } },
      { op: "add_guidance", line: "Typos need no action." },
      { op: "remove_guidance", line: "Billing is urgent." },
      { op: "set_standing", rule: ack },
    ];
    for (const edit of edits) expect(parseRuleFile(roundTrip(HAND_WRITTEN, edit).back)).toEqual(parseRuleFile(HAND_WRITTEN));
  });

  it("refuses what is already there, what is not there, and what does not fit", () => {
    const refused = (edit: RuleEdit, text = HAND_WRITTEN) => {
      try {
        applyEdit(text, edit);
      } catch (error) {
        return error instanceof EditRefused ? error.message : `not an EditRefused: ${String(error)}`;
      }
      return "not refused";
    };
    expect(refused({ op: "add_prefilter", rule: { actor: "DEPENDABOT[bot]" } })).toContain("already");
    expect(refused({ op: "remove_prefilter", rule: { actor: "nobody" } })).toContain("actor is `dependabot[bot]`");
    expect(refused({ op: "add_prefilter", rule: {} })).toContain("at least one");
    expect(refused({ op: "add_guidance", line: "Billing is urgent." })).toContain("already");
    expect(refused({ op: "add_guidance", line: "   " })).toContain("empty");
    expect(refused({ op: "remove_guidance", line: "Never said." })).toContain("Billing is urgent.");
    expect(refused({ op: "remove_standing", name: "ack-issue" })).toContain("no standing rule");
    expect(refused({ op: "set_standing", rule: { ...ack, template: "Hi {username}" } })).toContain("{actor}");
    expect(refused({ op: "add_guidance", line: "x" }, "prefilters: [\n")).toContain("cannot be used as it is");
  });
});

describe("describeEdit", () => {
  it("says what each edit does", () => {
    expect(describeEdit({ op: "add_prefilter", rule: { actor: "dependabot[bot]", repo: "octo/widgets" } })).toBe("Drop events where actor is `dependabot[bot]` and repository is `octo/widgets`");
    expect(describeEdit({ op: "remove_prefilter", rule: { kind: "comment" } })).toBe("Stop dropping events where kind is `comment`");
    expect(describeEdit({ op: "add_guidance", line: "Typos need no action." })).toBe('Add triage guidance: "Typos need no action."');
    expect(describeEdit({ op: "remove_guidance", line: "Typos need no action." })).toBe('Remove triage guidance: "Typos need no action."');
    expect(describeEdit({ op: "set_standing", rule: ack })).toBe("Standing rule `ack-issue`: when kind is `issue_opened`, send via github_comment:\n> Thanks, @{actor}.");
    expect(describeEdit({ op: "remove_standing", name: "ack-issue" })).toBe("Remove standing rule `ack-issue`");
  });
});
