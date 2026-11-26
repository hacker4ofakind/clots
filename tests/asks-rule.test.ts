import { beforeEach, describe, expect, it } from "vitest";
import { Asks, type AskKind } from "../src/asks.js";
import { askRule, RULE_FILED, ruleKind, type RulePayload } from "../src/asks/rule.js";
import type { WriteResult } from "../src/rule-writer.js";
import { describeEdit, type RuleEdit, type RuleScope } from "../src/rulebook-edit.js";
import { Store } from "../src/store.js";
import { FakeConversation } from "./helpers/conversation.js";

class FakeWriter {
  refusePreview?: string;
  refuseApply?: string;
  /** The disk fails: nothing is changed, and the same edit may go through later. */
  diskFails = false;
  throws = false;
  applied: { clot: string; scope: RuleScope; edit: RuleEdit }[] = [];
  preview(clot: string, scope: RuleScope, edit: RuleEdit): WriteResult {
    if (this.refusePreview) return { ok: false, reason: this.refusePreview };
    return { ok: true, file: scope === "global" ? "global" : clot, summary: describeEdit(edit) };
  }
  apply(clot: string, scope: RuleScope, edit: RuleEdit): WriteResult {
    if (this.throws) throw new Error("boom");
    if (this.diskFails) return { ok: false, reason: "the file could not be written (EACCES)", retry: true };
    if (this.refuseApply) return { ok: false, reason: this.refuseApply };
    this.applied.push({ clot, scope, edit });
    return { ok: true, file: scope === "global" ? "global" : clot, summary: describeEdit(edit) };
  }
}

let store: Store;
let conv: FakeConversation;
let writer: FakeWriter;
let asks: Asks;
let kind: AskKind<RulePayload>;
let max: number;
let now: number;

const dropDependabot: RuleEdit = { op: "add_prefilter", rule: { actor: "dependabot[bot]" } };
const guidance = (line: string): RuleEdit => ({ op: "add_guidance", line });

const open = (scope: RuleScope, edit: RuleEdit, outsider = false) => askRule(asks, kind, { writer, store, max }, "graphite", scope, edit, outsider);
const rules = () => store.openAsks("graphite").filter((ask) => ask.kind === "rule");
const allow = () => asks.answer(rules()[0]!.id, { action: "allow" });
const block = () => asks.answer(rules()[0]!.id, { action: "block" });

beforeEach(() => {
  store = new Store(":memory:");
  conv = new FakeConversation();
  writer = new FakeWriter();
  max = 3;
  now = 1_000_000;
  store.upsertClot("graphite");
  store.createSession({ id: "s1", clot: "graphite", seed: null });
  kind = ruleKind({ writer, store });
  asks = new Asks({ store, conv, now: () => now, kick: () => undefined, after: () => () => undefined, emit: () => undefined, timeoutMs: () => 10 * 60_000, kinds: [kind] });
});

describe("the rule ask", () => {
  it("shows the edit as a card, and tells the Clot not to wait", async () => {
    expect(await open("global", dropDependabot)).toBe(RULE_FILED);
    const [ask] = rules();
    expect(ask).toMatchObject({ payload: { scope: "global" } });
    const view = asks.snapshot(ask)!.view;
    expect(view).toMatchObject({ heading: "Allow graphite to change a rule?", rows: [{ label: "File", value: "global.yaml" }], labels: { allow: "Apply", block: "Decline" } });
    expect(view.body).toContain("Drop events where actor is `dependabot[bot]`");
    expect(writer.applied).toEqual([]);
    await open("own", guidance("Billing is urgent."));
    expect(rules()).toHaveLength(2);
  });

  it("applies the edit on Allow, and tells the user with the undo and the Clot", async () => {
    await open("own", dropDependabot);
    await allow();
    expect(writer.applied).toEqual([{ clot: "graphite", scope: "own", edit: dropDependabot }]);
    expect(conv.postsFor("graphite")).toEqual(["Approved. Rule change in `graphite.yaml`: Drop events where actor is `dependabot[bot]`\n`/rules undo` takes it back."]);
    expect(store.notes("graphite").map((note) => note.text)).toEqual(["The user approved the rule change you asked for, and it is in force: Drop events where actor is `dependabot[bot]`"]);
    expect(rules()).toEqual([]);
    expect(store.conversation.askOutcome(1)?.result).toBe("approved");
  });

  it("declines on Block, and tells the Clot not to ask again", async () => {
    await open("own", dropDependabot);
    await block();
    expect(writer.applied).toEqual([]);
    expect(conv.postsFor("graphite")).toEqual(["Declined: Drop events where actor is `dependabot[bot]`"]);
    expect(store.notes("graphite")[0]!.text).toBe("The user declined the rule change you asked for: Drop events where actor is `dependabot[bot]`. Do not ask for it again.");
    expect(store.conversation.askOutcome(1)?.result).toBe("declined");
  });

  it("is blocked at its deadline: nothing is applied and the Clot is told", async () => {
    await open("own", dropDependabot);
    now += 10 * 60_000;
    await asks.sweep(false);
    expect(rules()).toEqual([]);
    expect(writer.applied).toEqual([]);
    expect(conv.postsFor("graphite")).toEqual(["Blocked: no answer within 10 minutes."]);
    expect(store.notes("graphite")[0]!.text).toContain("so it was not applied");
    expect(store.conversation.askOutcome(1)?.result).toBe("timed_out");
  });

  it("leaves a message typed in the chat to the Clot: a rule ask takes no feedback", async () => {
    await open("own", dropDependabot);
    expect(await asks.onUserMessage("graphite", "after")).toBe(false);
    expect(rules()).toHaveLength(1);
    expect(writer.applied).toEqual([]);
  });

  it("lets an answer stand: a second answer does nothing", async () => {
    await open("own", dropDependabot);
    const id = rules()[0]!.id;
    await Promise.all([asks.answer(id, { action: "allow" }), asks.answer(id, { action: "block" })]);
    expect(writer.applied).toHaveLength(1);
    expect(conv.postsFor("graphite")).toHaveLength(1);
  });

  it("does not ask the same thing twice, and stops at the limit", async () => {
    max = 2;
    await open("own", dropDependabot);
    expect(await open("own", dropDependabot)).toContain("already with the user");
    await open("own", guidance("one"));
    expect(await open("own", guidance("two"))).toContain("2 rule changes already wait");
    expect(rules()).toHaveLength(2);
    // The same edit for the other file is a different ask, but the limit still holds.
    expect(await open("global", dropDependabot)).toContain("already wait");
  });

  it("keeps two slots of its own for asks from outsiders' turns", async () => {
    await open("own", guidance("one"), true);
    await open("own", guidance("two"), true);
    expect(await open("own", guidance("three"), true)).toContain("2 rule changes already wait");
    expect(await open("own", guidance("mine"))).toBe(RULE_FILED);
  });

  it("does not ask about an edit that could not be made anyway", async () => {
    writer.refusePreview = "that pre-filter is already in the file";
    expect(await open("own", dropDependabot)).toBe("Not asked: that pre-filter is already in the file.");
    expect(rules()).toEqual([]);
    expect(conv.asksPosted).toEqual([]);
  });

  it("tells the user and the Clot when an approved edit no longer fits the file", async () => {
    await open("own", dropDependabot);
    writer.refuseApply = "that pre-filter is already in the file";
    await allow();
    expect(conv.postsFor("graphite")[0]).toBe("Approved, but it could not be applied (that pre-filter is already in the file), so nothing was changed: Drop events where actor is `dependabot[bot]`");
    expect(store.notes("graphite")[0]!.text).toContain("could not be applied");
    expect(store.conversation.askOutcome(1)?.result).toBe("failed");
  });

  it("keeps the question open when an approved edit could not be written, and applies it on the next Allow", async () => {
    await open("own", dropDependabot);
    writer.diskFails = true;
    await allow();
    expect(conv.postsFor("graphite").at(-1)).toContain("could not be applied just now");
    expect(rules()).toMatchObject([{ state: "open" }]);
    expect(store.notes("graphite")).toEqual([]);

    writer.diskFails = false;
    await allow();
    expect(writer.applied).toHaveLength(1);
    expect(rules()).toEqual([]);
  });

  it("tells the user and the Clot, and does not try again, when applying fails in a way it cannot account for", async () => {
    await open("own", dropDependabot);
    writer.throws = true;
    await allow();
    expect(conv.postsFor("graphite")[0]).toContain("Approved, but it could not be applied (it failed in an unexpected way (boom); check the file)");
    expect(store.notes("graphite")[0]!.text).toContain("could not be applied");
    expect(rules()).toEqual([]);
  });

  it("stays open across a rollover, and an Allow after it still applies", async () => {
    await open("own", dropDependabot);
    store.createSession({ id: "s2", clot: "graphite", seed: null });
    await asks.sweep(true);
    expect(rules()).toHaveLength(1);
    await allow();
    expect(writer.applied).toHaveLength(1);
  });
});
