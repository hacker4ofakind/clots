import { beforeEach, describe, expect, it } from "vitest";
import { Asks, type AskKind } from "../src/asks.js";
import { askRule, RULE_FILED, ruleKind, type RulePayload } from "../src/asks/rule.js";
import type { InboundMessage } from "../src/chat/adapter.js";
import { FakeChat } from "../src/chat/fake.js";
import type { WriteResult } from "../src/rule-writer.js";
import { describeEdit, type RuleEdit, type RuleScope } from "../src/rulebook-edit.js";
import { Store } from "../src/store.js";

const USER = "user-1";

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
let chat: FakeChat;
let writer: FakeWriter;
let said: { clot: string; text: string }[];
let asks: Asks;
let kind: AskKind<RulePayload>;
let max: number;
let category: string;
let n: number;

const dropDependabot: RuleEdit = { op: "add_prefilter", rule: { actor: "dependabot[bot]" } };
const guidance = (line: string): RuleEdit => ({ op: "add_guidance", line });

function reply(channelId: string, text: string, authorId = USER): InboundMessage {
  n += 1;
  return { id: `r${n}`, channelId, authorId, text, at: new Date(0) };
}

const open = (scope: RuleScope, edit: RuleEdit, outsider = false) => askRule(asks, kind, { writer, store, max }, "graphite", scope, edit, outsider);
const rules = () => store.openAsks("graphite").filter((ask) => ask.kind === "rule");

beforeEach(async () => {
  store = new Store(":memory:");
  chat = new FakeChat();
  writer = new FakeWriter();
  said = [];
  n = 0;
  max = 3;
  category = await chat.ensureCategory("graphite");
  store.upsertClot("graphite", category);
  store.createSession({ id: "s1", clot: "graphite", channelId: await chat.createChannel(category, "graphite-1210"), seed: null });
  kind = ruleKind({ writer, store });
  asks = new Asks({ store, chat, userId: USER, now: () => 0, kick: () => undefined, say: async (clot, text) => void said.push({ clot, text }), after: () => () => undefined, kinds: [kind] });
});

describe("the rule ask", () => {
  it("asks the user in a temporary channel and tells the Clot not to wait", async () => {
    expect(await open("global", dropDependabot)).toBe(RULE_FILED);
    const [ask] = rules();
    expect(ask).toMatchObject({ channelName: "graphite-rule", payload: { scope: "global" } });
    const posted = chat.postsIn(ask.channelId)[0];
    expect(posted).toContain("<@user-1> graphite asks for a change to `global.yaml`");
    expect(posted).toContain("Drop events where actor is `dependabot[bot]`");
    expect(posted).toContain("`yes`, `sure`, `do that` or `yeah`");
    expect(writer.applied).toEqual([]);

    await open("own", guidance("Billing is urgent."));
    expect(rules().map((p) => p.channelName)).toEqual(["graphite-rule", "graphite-rule-2"]);
  });

  it("applies the edit on a yes, tells the user with the undo and the Clot, and deletes the channel", async () => {
    await open("own", dropDependabot);
    const channel = rules()[0].channelId;

    expect(await asks.onReply(reply(channel, "Yeah!"))).toBe(true);
    expect(writer.applied).toEqual([{ clot: "graphite", scope: "own", edit: dropDependabot }]);
    expect(said).toEqual([{ clot: "graphite", text: "Approved. Rule change in `graphite.yaml`: Drop events where actor is `dependabot[bot]`\n`&rules undo` takes it back." }]);
    expect(store.notes("graphite").map((note) => note.text)).toEqual(["The user approved the rule change you asked for, and it is in force: Drop events where actor is `dependabot[bot]`"]);
    expect(chat.deleted).toEqual([channel]);
    expect(rules()).toEqual([]);
  });

  it("declines on a no, and tells the Clot not to ask again", async () => {
    await open("own", dropDependabot);
    const channel = rules()[0].channelId;

    await asks.onReply(reply(channel, "no"));
    expect(writer.applied).toEqual([]);
    expect(said).toEqual([{ clot: "graphite", text: "Declined: Drop events where actor is `dependabot[bot]`" }]);
    expect(store.notes("graphite")[0].text).toBe("The user declined the rule change you asked for: Drop events where actor is `dependabot[bot]`. Do not ask for it again.");
    expect(chat.deleted).toEqual([channel]);
  });

  it("repeats the question on any other reply, and ignores anyone but the user", async () => {
    await open("own", dropDependabot);
    const channel = rules()[0].channelId;

    expect(await asks.onReply(reply(channel, "yes", "someone-else"))).toBe(true);
    expect(await asks.onReply(reply(channel, "after"))).toBe(true);
    expect(chat.postsIn(channel).at(-1)).toContain("I couldn't match that reply.");
    expect(rules()).toHaveLength(1);
    expect(writer.applied).toEqual([]);
  });

  it("lets an answer stand: a second reply does nothing", async () => {
    await open("own", dropDependabot);
    const channel = rules()[0].channelId;
    await Promise.all([asks.onReply(reply(channel, "yes")), asks.onReply(reply(channel, "no"))]);
    expect(writer.applied).toHaveLength(1);
    expect(said).toHaveLength(1);
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
    expect(chat.channels).toHaveLength(1);
  });

  it("tells the user and the Clot when an approved edit no longer fits the file", async () => {
    await open("own", dropDependabot);
    const channel = rules()[0].channelId;
    writer.refuseApply = "that pre-filter is already in the file";

    await asks.onReply(reply(channel, "yes"));
    expect(said[0].text).toBe("Approved, but it could not be applied (that pre-filter is already in the file), so nothing was changed: Drop events where actor is `dependabot[bot]`");
    expect(store.notes("graphite")[0].text).toContain("could not be applied");
    expect(chat.deleted).toEqual([channel]);
  });

  it("keeps the question open when an approved edit could not be written, and applies it on the next yes", async () => {
    await open("own", dropDependabot);
    const channel = rules()[0].channelId;
    writer.diskFails = true;

    await asks.onReply(reply(channel, "yes"));
    expect(chat.postsIn(channel).at(-1)).toContain("could not be applied just now");
    expect(rules()).toMatchObject([{ channelId: channel, state: "open" }]);
    expect(chat.deleted).toEqual([]);
    expect(said).toEqual([]);
    expect(store.notes("graphite")).toEqual([]);

    writer.diskFails = false;
    await asks.onReply(reply(channel, "yes"));
    expect(writer.applied).toHaveLength(1);
    expect(rules()).toEqual([]);
    expect(chat.deleted).toEqual([channel]);
  });

  it("tells the user and the Clot, and does not try again, when applying fails in a way it cannot account for", async () => {
    await open("own", dropDependabot);
    const channel = rules()[0].channelId;
    writer.throws = true;

    await asks.onReply(reply(channel, "yes"));
    expect(said[0].text).toContain("Approved, but it could not be applied (it failed in an unexpected way (boom); check the file)");
    expect(store.notes("graphite")[0].text).toContain("could not be applied");
    expect(rules()).toEqual([]);
    expect(chat.deleted).toEqual([channel]);
  });

  it("stays open across a rollover, and a yes after it still applies", async () => {
    await open("own", dropDependabot);
    const channel = rules()[0].channelId;
    store.createSession({ id: "s2", clot: "graphite", channelId: await chat.createChannel(category, "graphite-1310"), seed: null });
    await asks.sweep(true);
    expect(rules()).toHaveLength(1);
    await asks.onReply(reply(channel, "yes"));
    expect(writer.applied).toHaveLength(1);
  });
});
