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
    expect(added.inverse).toEqual({ op: "remove_standing", name: "ack-issue", was: ack });

    const changed: StandingRule = { ...ack, template: "Thank you, @{actor}." };
    const replaced = applyEdit(added.text, { op: "set_standing", rule: changed });
    expect(parseRuleFile(replaced.text).standing).toEqual([changed]);
    expect(replaced.inverse).toEqual({ op: "set_standing", rule: ack, was: changed });
    expect(replaced.summary).toContain("It replaces the rule as it is now");
    expect(replaced.summary).toContain("Thanks, @{actor}.");

    const removed = applyEdit(replaced.text, { op: "remove_standing", name: "ack-issue" });
    expect(parseRuleFile(removed.text).standing).toEqual([]);
    expect(removed.inverse).toEqual({ op: "set_standing", rule: changed, was: null });
  });

  it("refuses an inverse when the standing rule it would undo has been changed since", () => {
    const refused = (text: string, edit: RuleEdit) => {
      try {
        applyEdit(text, edit);
      } catch (error) {
        return error instanceof EditRefused ? error.message : String(error);
      }
      return "not refused";
    };
    const newer: StandingRule = { ...ack, template: "Someone else's newer text." };

    // Added, then replaced by someone else: the removal no longer fits.
    const added = applyEdit(HAND_WRITTEN, { op: "set_standing", rule: ack });
    const replaced = applyEdit(added.text, { op: "set_standing", rule: newer });
    expect(refused(replaced.text, added.inverse)).toContain("has been changed since");

    // Replaced, then replaced again: putting the first one back would overwrite the newest.
    const mine = applyEdit(added.text, { op: "set_standing", rule: { ...ack, template: "Mine." } });
    const theirs = applyEdit(mine.text, { op: "set_standing", rule: newer });
    expect(refused(theirs.text, mine.inverse)).toContain("has been changed since");

    // Removed, then added again by someone else: restoring would overwrite it.
    const removed = applyEdit(added.text, { op: "remove_standing", name: "ack-issue" });
    const again = applyEdit(removed.text, { op: "set_standing", rule: newer });
    expect(refused(again.text, removed.inverse)).toContain("has been changed since");

    // An edit with no expectation of its own is made as before.
    expect(parseRuleFile(applyEdit(replaced.text, { op: "remove_standing", name: "ack-issue" }).text).standing).toEqual([]);
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
    expect(describeEdit({ op: "add_prefilter", rule: { source: "email", account: "gmail", place: "me+news@gmail.com" } })).toBe(
      "Drop events where source is `email` and account is `gmail` and place is `me+news@gmail.com`",
    );
    expect(describeEdit({ op: "remove_prefilter", rule: { kind: "comment" } })).toBe("Stop dropping events where kind is `comment`");
    expect(describeEdit({ op: "add_guidance", line: "Typos need no action." })).toBe('Add triage guidance: "Typos need no action."');
    expect(describeEdit({ op: "remove_guidance", line: "Typos need no action." })).toBe('Remove triage guidance: "Typos need no action."');
    expect(describeEdit({ op: "set_standing", rule: ack })).toBe("Standing rule `ack-issue`: when kind is `issue_opened`, send via github_comment:\n> Thanks, @{actor}.");
    expect(describeEdit({ op: "remove_standing", name: "ack-issue" })).toBe("Remove standing rule `ack-issue`");
  });
});

describe("routing edits", () => {
  const rule = { source: "email", place: "me+shop@gmail.com", clot: "shop" };

  it("adds a routing rule and removes it again, and says what it does", () => {
    const added = applyEdit("routing: []\n", { op: "add_routing", rule });
    expect(parseRuleFile(added.text).routing).toEqual([rule]);
    expect(added.summary).toBe("Route events where source is `email` and place is `me+shop@gmail.com` to shop");
    expect(added.inverse).toEqual({ op: "remove_routing", rule });
    const removed = applyEdit(added.text, added.inverse);
    expect(parseRuleFile(removed.text).routing).toEqual([]);
    expect(removed.summary).toBe("Stop routing events where source is `email` and place is `me+shop@gmail.com` to shop");
  });

  it("refuses a routing rule that is already there, one that matches nothing, and removing one that is not there", () => {
    const text = applyEdit("", { op: "add_routing", rule }).text;
    expect(() => applyEdit(text, { op: "add_routing", rule })).toThrow(EditRefused);
    expect(() => applyEdit(text, { op: "add_routing", rule: { clot: "shop" } as never })).toThrow(EditRefused);
    expect(() => applyEdit(text, { op: "remove_routing", rule: { ...rule, clot: "other" } })).toThrow("no such routing rule");
  });
});

describe("watch recipe edits", () => {
  const recipe = { name: "notion-feedback", server: "notion", tool: "search", arguments: { query: "Feedback" }, items: "results", id: "id", ignore: [], every: 5, report: "added" as const };

  it("adds a recipe, replaces it by name, and removes it, each with its inverse", () => {
    const added = applyEdit("", { op: "set_watch", recipe });
    expect(parseRuleFile(added.text).watches).toEqual([recipe]);
    expect(added.summary).toContain("Watch recipe `notion-feedback`: every 5 minutes, call `search` on `notion`");
    const replaced = applyEdit(added.text, { op: "set_watch", recipe: { ...recipe, every: 10 } });
    expect(parseRuleFile(replaced.text).watches[0].every).toBe(10);
    expect(applyEdit(replaced.text, replaced.inverse).text).toContain("every: 5");
    const removed = applyEdit(added.text, { op: "remove_watch", name: "notion-feedback" });
    expect(parseRuleFile(removed.text).watches).toEqual([]);
    expect(() => applyEdit(removed.text, { op: "remove_watch", name: "notion-feedback" })).toThrow(EditRefused);
  });

  it("shows a recipe for a tool that may change things in bold, with a warning", () => {
    expect(applyEdit("", { op: "set_watch", recipe: { ...recipe, notReadOnly: true } }).summary).toContain("**This tool does not declare itself read-only");
  });
});

describe("webhook recipe edits", () => {
  const recipe = { name: "tracker", verify: { scheme: "token", header: "x-token", prefix: "", encoding: "hex", signed: "body", toleranceSeconds: 300, secret: "RECIPE_TRACKER" }, kinds: [{ kind: "ping", when: {} }], event: { title: "{t}" } } as never;

  it("adds and removes a recipe, and its description tells the user where the webhook goes and where the secret goes", () => {
    const added = applyEdit("", { op: "set_webhook", recipe });
    expect(parseRuleFile(added.text).webhooks).toHaveLength(1);
    expect(added.summary).toContain("Webhook recipe `tracker`");
    expect(added.summary).toContain("RECIPE_TRACKER");
    expect(parseRuleFile(applyEdit(added.text, added.inverse).text).webhooks).toEqual([]);
  });
});
