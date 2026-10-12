import { beforeEach, describe, expect, it } from "vitest";
import type { InboundMessage } from "../src/chat/adapter.js";
import { FakeChat } from "../src/chat/fake.js";
import { PROPOSAL_FILED, PROPOSAL_NOT_ASKED, Proposals } from "../src/proposals.js";
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
let proposals: Proposals;
let category: string;
let n: number;

const dropDependabot: RuleEdit = { op: "add_prefilter", rule: { actor: "dependabot[bot]" } };
const guidance = (line: string): RuleEdit => ({ op: "add_guidance", line });

function reply(channelId: string, text: string, authorId = USER): InboundMessage {
  n += 1;
  return { id: `r${n}`, channelId, authorId, text, at: new Date(0) };
}

function build(max = 3): Proposals {
  return new Proposals({ store, chat, writer, userId: USER, max, say: async (clot, text) => void said.push({ clot, text }) });
}

beforeEach(async () => {
  store = new Store(":memory:");
  chat = new FakeChat();
  writer = new FakeWriter();
  said = [];
  n = 0;
  category = await chat.ensureCategory("graphite");
  store.upsertClot("graphite", category);
  store.createSession({ id: "s1", clot: "graphite", channelId: await chat.createChannel(category, "graphite-1210"), seed: null });
  proposals = build();
});

describe("Proposals", () => {
  it("asks the user in a temporary channel and tells the Clot not to wait", async () => {
    expect(await proposals.open("graphite", "global", dropDependabot)).toBe(PROPOSAL_FILED);
    const open = store.openProposals("graphite");
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ channelName: "graphite-rule", scope: "global" });
    const posted = chat.postsIn(open[0].channelId)[0];
    expect(posted).toContain("<@user-1>");
    expect(posted).toContain("`global.yaml`");
    expect(posted).toContain("Drop events where actor is `dependabot[bot]`");
    expect(posted).toContain("`yes`, `sure`, `do that` or `yeah`");
    expect(writer.applied).toEqual([]);

    await proposals.open("graphite", "own", guidance("Billing is urgent."));
    expect(store.openProposals("graphite").map((p) => p.channelName)).toEqual(["graphite-rule", "graphite-rule-2"]);
  });

  it("applies the edit on a yes, tells the user and the Clot, and deletes the channel", async () => {
    await proposals.open("graphite", "own", dropDependabot);
    const channel = store.openProposals("graphite")[0].channelId;

    expect(await proposals.onReply(reply(channel, "Yeah!"))).toBe(true);
    expect(writer.applied).toEqual([{ clot: "graphite", scope: "own", edit: dropDependabot }]);
    expect(said).toEqual([{ clot: "graphite", text: "Approved. Rule change in `graphite.yaml`: Drop events where actor is `dependabot[bot]`" }]);
    expect(store.notes("graphite").map((note) => note.text)).toEqual(["The user approved the rule change you proposed, and it is in force: Drop events where actor is `dependabot[bot]`"]);
    expect(chat.deleted).toEqual([channel]);
    expect(store.openProposals("graphite")).toEqual([]);
  });

  it("declines on a no, and tells the Clot not to propose it again", async () => {
    await proposals.open("graphite", "own", dropDependabot);
    const channel = store.openProposals("graphite")[0].channelId;

    await proposals.onReply(reply(channel, "no"));
    expect(writer.applied).toEqual([]);
    expect(said).toEqual([{ clot: "graphite", text: "Declined: Drop events where actor is `dependabot[bot]`" }]);
    expect(store.notes("graphite")[0].text).toBe("The user declined the rule change you proposed: Drop events where actor is `dependabot[bot]`. Do not propose it again.");
    expect(chat.deleted).toEqual([channel]);
  });

  it("repeats the question on any other reply, and ignores anyone but the user", async () => {
    await proposals.open("graphite", "own", dropDependabot);
    const channel = store.openProposals("graphite")[0].channelId;

    expect(await proposals.onReply(reply(channel, "yes", "someone-else"))).toBe(true);
    expect(await proposals.onReply(reply(channel, "after"))).toBe(true);
    expect(chat.postsIn(channel).at(-1)).toContain("I couldn't match that reply.");
    expect(store.openProposals("graphite")).toHaveLength(1);
    expect(writer.applied).toEqual([]);
  });

  it("leaves messages in other channels alone", async () => {
    expect(await proposals.onReply(reply("somewhere-else", "yes"))).toBe(false);
  });

  it("lets an answer stand: a second reply does nothing", async () => {
    await proposals.open("graphite", "own", dropDependabot);
    const channel = store.openProposals("graphite")[0].channelId;
    await Promise.all([proposals.onReply(reply(channel, "yes")), proposals.onReply(reply(channel, "no"))]);
    expect(writer.applied).toHaveLength(1);
    expect(said).toHaveLength(1);
  });

  it("does not ask the same thing twice, and stops at the limit", async () => {
    proposals = build(2);
    await proposals.open("graphite", "own", dropDependabot);
    expect(await proposals.open("graphite", "own", dropDependabot)).toContain("already with the user");
    await proposals.open("graphite", "own", guidance("one"));
    expect(await proposals.open("graphite", "own", guidance("two"))).toContain("2 proposals are already waiting");
    expect(store.openProposals("graphite")).toHaveLength(2);
    // The same edit for the other file is a different proposal, but the limit still holds.
    expect(await proposals.open("graphite", "global", dropDependabot)).toContain("already waiting");
  });

  it("does not ask about an edit that could not be made anyway", async () => {
    writer.refusePreview = "that pre-filter is already in the file";
    expect(await proposals.open("graphite", "own", dropDependabot)).toBe("Not proposed: that pre-filter is already in the file.");
    expect(store.openProposals("graphite")).toEqual([]);
    expect(chat.channels).toHaveLength(1);
  });

  it("says so when the user could not be asked", async () => {
    chat.createChannel = async () => {
      throw new Error("Discord is down");
    };
    expect(await proposals.open("graphite", "own", dropDependabot)).toBe(PROPOSAL_NOT_ASKED);
    expect(store.openProposals("graphite")).toEqual([]);
  });

  it("closes the proposal when its question cannot be posted", async () => {
    const post = chat.post.bind(chat);
    chat.post = async (channelId, text) => {
      if (text.includes("proposes a change")) throw new Error("Discord is down");
      return post(channelId, text);
    };
    expect(await proposals.open("graphite", "own", dropDependabot)).toBe(PROPOSAL_NOT_ASKED);
    expect(store.openProposals("graphite")).toEqual([]);
    expect(chat.deleted).toHaveLength(1);
  });

  it("tells the user and the Clot when an approved edit no longer fits the file", async () => {
    await proposals.open("graphite", "own", dropDependabot);
    const channel = store.openProposals("graphite")[0].channelId;
    writer.refuseApply = "that pre-filter is already in the file";

    await proposals.onReply(reply(channel, "yes"));
    expect(said[0].text).toBe("Approved, but it could not be applied (that pre-filter is already in the file), so nothing was changed: Drop events where actor is `dependabot[bot]`");
    expect(store.notes("graphite")[0].text).toContain("could not be applied");
    expect(chat.deleted).toEqual([channel]);
  });

  it("closes a session's open proposals as unanswered, with one note for the next session", async () => {
    await proposals.open("graphite", "own", dropDependabot);
    await proposals.open("graphite", "own", guidance("Billing is urgent."));
    const channels = store.openProposals("graphite").map((p) => p.channelId);

    await proposals.closeForSession("graphite");
    expect(store.openProposals("graphite")).toEqual([]);
    expect(chat.deleted).toEqual(channels);
    expect(store.notes("graphite").map((note) => note.text)).toEqual([
      'These rule changes you proposed were still unanswered when the previous session closed, and were withdrawn: Drop events where actor is `dependabot[bot]`; Add triage guidance: "Billing is urgent."',
    ]);
    expect(writer.applied).toEqual([]);

    await proposals.closeForSession("graphite");
    expect(store.notes("graphite")).toHaveLength(1);
  });

  it("keeps the question open when an approved edit could not be written, and applies it on the next yes", async () => {
    await proposals.open("graphite", "own", dropDependabot);
    const channel = store.openProposals("graphite")[0].channelId;
    writer.diskFails = true;

    await proposals.onReply(reply(channel, "yes"));
    expect(chat.postsIn(channel).at(-1)).toContain("could not be applied just now");
    expect(store.openProposals("graphite")).toMatchObject([{ channelId: channel, sessionId: "s1", scope: "own" }]);
    expect(chat.deleted).toEqual([]);
    expect(said).toEqual([]);
    expect(store.notes("graphite")).toEqual([]);

    writer.diskFails = false;
    await proposals.onReply(reply(channel, "yes"));
    expect(writer.applied).toHaveLength(1);
    expect(store.openProposals("graphite")).toEqual([]);
    expect(chat.deleted).toEqual([channel]);
  });

  it("tells the user and the Clot, and does not try again, when applying fails in a way it cannot account for", async () => {
    await proposals.open("graphite", "own", dropDependabot);
    const channel = store.openProposals("graphite")[0].channelId;
    writer.throws = true;

    await proposals.onReply(reply(channel, "yes"));
    expect(said[0].text).toContain("Approved, but it could not be applied (it failed in an unexpected way (boom); check the file)");
    expect(store.notes("graphite")[0].text).toContain("could not be applied");
    expect(store.openProposals("graphite")).toEqual([]);
    expect(chat.deleted).toEqual([channel]);
  });

  it("withdraws, at startup, the proposals of a session that has been replaced", async () => {
    await proposals.open("graphite", "own", dropDependabot);
    await proposals.open("graphite", "own", guidance("Billing is urgent."));
    const channels = store.openProposals("graphite").map((p) => p.channelId);
    // The daemon stopped after the new session was saved and before the old one's proposals were closed.
    store.createSession({ id: "s2", clot: "graphite", channelId: await chat.createChannel(category, "graphite-1310"), seed: null });

    await build().closeOrphans();
    expect(store.openProposals("graphite")).toEqual([]);
    expect(chat.deleted).toEqual(channels);
    expect(store.notes("graphite")).toHaveLength(1);
    expect(store.notes("graphite")[0].text).toContain("when the previous session closed");
    expect(await proposals.onReply(reply(channels[0], "yes"))).toBe(false);
    expect(writer.applied).toEqual([]);
  });

  it("closes every proposal of the session before it touches a channel", async () => {
    await proposals.open("graphite", "own", dropDependabot);
    await proposals.open("graphite", "own", guidance("Billing is urgent."));
    let openWhenFirstChannelGoes = -1;
    const remove = chat.deleteChannel.bind(chat);
    chat.deleteChannel = async (channelId) => {
      if (openWhenFirstChannelGoes < 0) openWhenFirstChannelGoes = store.openProposals("graphite").length;
      return remove(channelId);
    };
    await proposals.closeForSession("graphite");
    expect(openWhenFirstChannelGoes).toBe(0);
  });

  it("tells a proposal's channel by what it is, not by its name, at startup", async () => {
    await proposals.open("graphite", "own", dropDependabot);
    await proposals.open("graphite", "own", guidance("Billing is urgent."));
    const [renamed, replaced] = store.openProposals("graphite");
    chat.channels.find((channel) => channel.id === renamed.channelId)!.name = "ask-me-here";
    chat.channels = chat.channels.filter((channel) => channel.id !== replaced.channelId);
    await chat.createChannel(category, replaced.channelName);

    await build().closeOrphans();
    expect(store.openProposals("graphite").map((p) => p.id)).toEqual([renamed.id]);
    expect(chat.deleted).toEqual([replaced.channelId]);
  });

  it("closes nothing at startup when it cannot find out which channels exist", async () => {
    await proposals.open("graphite", "own", dropDependabot);
    chat.channelExists = async () => {
      throw new Error("Discord is down");
    };
    await build().closeOrphans();
    expect(store.openProposals("graphite")).toHaveLength(1);
  });

  it("closes a proposal whose channel has disappeared, at startup", async () => {
    await proposals.open("graphite", "own", dropDependabot);
    await proposals.open("graphite", "own", guidance("Billing is urgent."));
    const [gone, kept] = store.openProposals("graphite");
    chat.channels = chat.channels.filter((channel) => channel.id !== gone.channelId);

    await build().closeOrphans();
    expect(store.openProposals("graphite").map((p) => p.id)).toEqual([kept.id]);
    expect(store.notes("graphite")[0].text).toContain("Drop events where actor is `dependabot[bot]`");
  });
});
