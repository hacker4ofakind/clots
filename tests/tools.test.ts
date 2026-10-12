import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { SendResult } from "../src/events/github-comment.js";
import type { ClotEvent } from "../src/events/types.js";
import { RuleWriter } from "../src/rule-writer.js";
import { parseRuleFile, Rulebook } from "../src/rulebook.js";
import type { RuleEdit, RuleScope } from "../src/rulebook-edit.js";
import { Store } from "../src/store.js";
import { makeTools, mustPropose, showRules, type DaemonTools, type TurnContext, type TurnKind } from "../src/tools.js";

const Z = "​";

let dir: string;
let rulebook: Rulebook;
let store: Store;
let opened: { clot: string; scope: RuleScope; edit: RuleEdit }[];
let said: string[];
let sent: { event: string; text: string }[];
let sendAnswer: SendResult;
let steered: boolean;

function issue(overrides: Partial<ClotEvent> = {}): ClotEvent {
  return { id: "d-1", source: "github", kind: "issue_opened", repo: "octo/widgets", actor: "alice", title: "Issue #7 opened: Login fails", body: "", url: "https://github.com/octo/widgets/issues/7", ref: "7", subject: "issue:7", automated: false, receivedAt: 0, ...overrides };
}

function tools(kind: TurnKind, event?: ClotEvent): DaemonTools {
  const ctx: TurnContext = { clot: "graphite", kind, steered: () => steered, event };
  return makeTools(
    {
      rulebook,
      writer: new RuleWriter({ rulebook, store, commit: () => undefined }),
      proposals: {
        open: async (clot, scope, edit) => {
          opened.push({ clot, scope, edit });
          return "FILED";
        },
      },
      store,
      senders: {
        github_comment: {
          send: async (event, text) => {
            sent.push({ event: event.id, text });
            return sendAnswer;
          },
        },
      },
      say: async (_clot, text) => void said.push(text),
    },
    ctx,
  );
}

const own = () => parseRuleFile(fs.readFileSync(path.join(dir, "graphite.yaml"), "utf8"));

/** Puts standing rules in the Clot's own file. */
function standing(...rules: string[]): void {
  fs.writeFileSync(path.join(dir, "graphite.yaml"), `standing:\n${rules.join("")}`);
  rulebook.load();
}

const ACK = '  - name: ack-issue\n    trigger: { kind: issue_opened }\n    via: github_comment\n    template: "Thanks for the report, @{actor}. I am looking into it."\n';

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "clots-tools-"));
  rulebook = new Rulebook(dir, ["graphite"], () => undefined);
  rulebook.ensure();
  rulebook.load();
  store = new Store(":memory:");
  opened = [];
  said = [];
  sent = [];
  sendAnswer = { ok: true, url: "https://github.com/octo/widgets/issues/7#issuecomment-1" };
  steered = false;
});

describe("mustPropose", () => {
  const ctx = (kind: TurnKind, joined = false): TurnContext => ({ clot: "graphite", kind, steered: () => joined });
  const prefilter: RuleEdit = { op: "add_prefilter", rule: { actor: "x" } };
  const line: RuleEdit = { op: "remove_guidance", line: "x" };
  const setStanding: RuleEdit = { op: "set_standing", rule: { name: "a", trigger: { kind: "issue_opened" }, via: "github_comment", template: "x" } };
  const removeStanding: RuleEdit = { op: "remove_standing", name: "a" };

  it("applies at once only a pre-filter or a triage line, in the Clot's own file, in a working turn no steered event has joined", () => {
    expect(mustPropose(ctx("work"), "own", prefilter)).toBe(false);
    expect(mustPropose(ctx("work"), "own", line)).toBe(false);
  });

  it("proposes everything else", () => {
    for (const edit of [prefilter, line]) {
      expect(mustPropose(ctx("work", true), "own", edit)).toBe(true);
      expect(mustPropose(ctx("brainstorm"), "own", edit)).toBe(true);
      expect(mustPropose(ctx("investigation"), "own", edit)).toBe(true);
      expect(mustPropose(ctx("work"), "global", edit)).toBe(true);
    }
    for (const edit of [setStanding, removeStanding]) {
      expect(mustPropose(ctx("work"), "own", edit)).toBe(true);
      expect(mustPropose(ctx("work"), "global", edit)).toBe(true);
    }
  });
});

describe("the rulebook tools", () => {
  it("apply an edit at once in a working turn, and the daemon tells the user", async () => {
    const reply = await tools("work").prefilter({ action: "add", file: "own", rule: { actor: "dependabot[bot]" } });
    expect(reply).toContain("Applied");
    expect(own().prefilters).toEqual([{ actor: "dependabot[bot]" }]);
    expect(said).toEqual(["Rule change in `graphite.yaml`: Drop events where actor is `dependabot[bot]`"]);
    expect(opened).toEqual([]);

    await tools("work").guidance({ action: "add", file: "own", line: "Billing is urgent." });
    await tools("work").prefilter({ action: "remove", file: "own", rule: { actor: "dependabot[bot]" } });
    expect(own()).toMatchObject({ prefilters: [], triage: ["Billing is urgent."] });
  });

  it("file a proposal instead in a locked turn, and once a steered event has joined the turn", async () => {
    expect(await tools("investigation", issue()).prefilter({ action: "add", file: "own", rule: { actor: "a" } })).toBe("FILED");
    expect(await tools("brainstorm").guidance({ action: "add", file: "own", line: "b" })).toBe("FILED");
    steered = true;
    expect(await tools("work").prefilter({ action: "add", file: "own", rule: { actor: "c" } })).toBe("FILED");
    expect(opened.map((p) => p.edit.op)).toEqual(["add_prefilter", "add_guidance", "add_prefilter"]);
    expect(own()).toMatchObject({ prefilters: [], triage: [] });
    expect(said).toEqual([]);
  });

  it("always file a proposal for the global file and for a standing rule", async () => {
    const t = tools("work");
    await t.guidance({ action: "add", file: "global", line: "x" });
    await t.standing({ action: "set", file: "own", name: "ack-issue", trigger: { kind: "issue_opened" }, template: "Thanks, @{actor}." });
    await t.standing({ action: "remove", file: "own", name: "ack-issue" });
    expect(opened).toEqual([
      { clot: "graphite", scope: "global", edit: { op: "add_guidance", line: "x" } },
      { clot: "graphite", scope: "own", edit: { op: "set_standing", rule: { name: "ack-issue", trigger: { kind: "issue_opened" }, via: "github_comment", template: "Thanks, @{actor}." } } },
      { clot: "graphite", scope: "own", edit: { op: "remove_standing", name: "ack-issue" } },
    ]);
  });

  it("say why an edit was not made", async () => {
    expect(await tools("work").prefilter({ action: "remove", file: "own", rule: { actor: "nobody" } })).toContain("Not applied: there is no such pre-filter");
    expect(await tools("work").standing({ action: "set", file: "own", name: "ack-issue" })).toContain("needs a trigger and a template");
    expect(said).toEqual([]);
  });

  it("show the rules in force and the open proposals", async () => {
    fs.writeFileSync(path.join(dir, "global.yaml"), "prefilters:\n  - actor: dependabot[bot]\ntriage:\n  - Billing is urgent.\n");
    standing(ACK);
    store.createProposal({ clot: "graphite", channelId: "ch-9", channelName: "graphite-rule", scope: "own", edit: "{}", summary: "Drop events where kind is `comment`\nmore" });
    const shown = await tools("work").show();
    expect(shown).toBe(showRules({ rulebook, store }, "graphite"));
    expect(shown).toContain("Rules in force for graphite");
    expect(shown).toContain("- [global] actor is `dependabot[bot]`");
    expect(shown).toContain("- [global] Billing is urgent.");
    expect(shown).toContain("- [graphite] `ack-issue`: when kind is `issue_opened`, send via github_comment:");
    expect(shown).toContain("- Drop events where kind is `comment`");
    expect(shown).not.toContain("more");
    expect(showRules({ rulebook, store }, "other")).toContain("Standing rules:\n- none");
  });
});

describe("send_from_template", () => {
  it("sends the filled-in template on the event's thread, records it, and shows the user", async () => {
    standing(ACK);
    const reply = await tools("investigation", issue()).send({ rule: "ack-issue" });
    expect(sent).toEqual([{ event: "d-1", text: "Thanks for the report, @alice. I am looking into it." }]);
    expect(reply).toContain("Sent");
    expect(said).toEqual(["Sent under standing rule `ack-issue`: Thanks for the report, @alice. I am looking into it. <https://github.com/octo/widgets/issues/7#issuecomment-1>"]);
    expect(store.hasSend("d-1", "ack-issue")).toBe(true);
  });

  it("accepts the Clot's wording within five words, and lets its words mention nobody", async () => {
    standing(ACK);
    await tools("investigation", issue()).send({ rule: "ack-issue", text: "Thanks for the report, @alice. I am looking into it now, @bob." });
    expect(sent[0].text).toBe(`Thanks for the report, @alice. I am looking into it now, @${Z}bob.`);
  });

  it("refuses outside an investigation, and for a rule that does not apply to this event", async () => {
    standing(ACK);
    expect(await tools("work").send({ rule: "ack-issue" })).toContain("Refused");
    expect(await tools("brainstorm").send({ rule: "ack-issue" })).toContain("Refused");
    expect(await tools("investigation", issue({ kind: "pr_opened", subject: "pr:7" })).send({ rule: "ack-issue" })).toContain('no standing rule named "ack-issue" applies');
    expect(await tools("investigation", issue()).send({ rule: "unknown" })).toContain("applies");
    expect(sent).toEqual([]);
  });

  it("refuses when the event has no thread, when the rule was already sent, and when too many words differ", async () => {
    standing(ACK, '  - name: ci-note\n    trigger: { kind: ci_failed }\n    via: github_comment\n    template: "Looking at the failure."\n');
    expect(await tools("investigation", issue({ kind: "ci_failed", subject: "branch:main" })).send({ rule: "ci-note" })).toContain("about a branch");

    const t = tools("investigation", issue());
    expect(await t.send({ rule: "ack-issue", text: "Hello there alice, we will get back to you soon." })).toContain("at most 5");
    expect(await t.send({ rule: "ack-issue", text: "x ".repeat(3000) })).toContain("too long");
    expect(sent).toEqual([]);
    await t.send({ rule: "ack-issue" });
    expect(await t.send({ rule: "ack-issue" })).toContain("already been sent");
    expect(sent).toHaveLength(1);
  });

  it("can be tried again after a definite refusal, and not after an uncertain failure", async () => {
    standing(ACK);
    const t = tools("investigation", issue());
    sendAnswer = { ok: false, refused: true, reason: "GitHub answered 403" };
    expect(await t.send({ rule: "ack-issue" })).toBe("Not sent: GitHub answered 403.");
    expect(store.hasSend("d-1", "ack-issue")).toBe(false);

    sendAnswer = { ok: false, refused: false, reason: "GitHub answered 502" };
    expect(await t.send({ rule: "ack-issue" })).toContain("may or may not have been posted");
    expect(await t.send({ rule: "ack-issue" })).toContain("already been sent");
    expect(said).toEqual([]);
  });

  it("matches a batch through its reports and fills the template from the one that matched", async () => {
    standing('  - name: rebase\n    trigger: { kind: pr_opened, actor: "dependabot[bot]" }\n    via: github_comment\n    template: "@{actor} rebase"\n');
    const part = (id: string, overrides: Partial<ClotEvent>) => issue({ id, ref: "14", subject: "pr:14", automated: true, ...overrides });
    store.insertEvent(part("d-2", { kind: "comment", actor: "vercel[bot]" }));
    store.insertEvent(part("d-3", { kind: "pr_opened", actor: "dependabot[bot]" }));
    const batch = part("batch:d-2", { kind: "batch", actor: "vercel[bot], dependabot[bot]" });
    store.recordRelease({ event: batch, clot: "graphite", isNew: true, absorbed: ["d-2", "d-3"] });

    await tools("investigation", batch).send({ rule: "rebase" });
    expect(sent).toEqual([{ event: "batch:d-2", text: "@dependabot[bot] rebase" }]);
    expect(store.hasSend("batch:d-2", "rebase")).toBe(true);
  });
});
