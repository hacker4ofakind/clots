import { beforeEach, describe, expect, it } from "vitest";
import { FakeChat } from "../src/chat/fake.js";
import type { InboundMessage } from "../src/chat/adapter.js";
import type { ClotEvent } from "../src/events/types.js";
import type { Explainer } from "../src/explainer.js";
import { Steering, type ClotPort } from "../src/steering.js";
import { Store } from "../src/store.js";

const USER = "user-1";

class FakePort implements ClotPort {
  busy = true;
  accepts = true;
  steered: string[] = [];
  queued: { id: string; notice: string; kick: boolean }[] = [];
  isBusy(): boolean {
    return this.busy;
  }
  steerEvent(text: string): boolean {
    if (this.accepts) this.steered.push(text);
    return this.accepts;
  }
  async queueEvent(event: ClotEvent, notice: string, kick = true): Promise<void> {
    this.queued.push({ id: event.id, notice, kick });
  }
}

let store: Store;
let chat: FakeChat;
let port: FakePort;
let explainer: Explainer;
let steering: Steering;
let live: string;
let n: number;

function event(id: string): ClotEvent {
  const e: ClotEvent = {
    id,
    source: "github",
    kind: "ci_failed",
    repo: "octo/widgets",
    actor: "widgets-clot",
    title: "CI failed: CI on clot/fix-login",
    body: "Workflow run ID: 4242",
    url: "https://github.com/octo/widgets/actions/runs/4242",
    ref: "clot/fix-login",
    subject: "branch:clot/fix-login",
    automated: true,
    receivedAt: 0,
  };
  store.insertEvent(e);
  store.recordTriage(id, "CI failed on the branch being worked on.", false);
  return e;
}

function reply(channelId: string, text: string, authorId = USER): InboundMessage {
  n += 1;
  return { id: `r${n}`, channelId, authorId, text, at: new Date(0) };
}

/** The channel of the one open question. */
function askChannel(): string {
  return store.openAsks("graphite")[0].channelId;
}

beforeEach(async () => {
  store = new Store(":memory:");
  chat = new FakeChat();
  port = new FakePort();
  n = 0;
  explainer = { explain: async () => "CI just failed on the branch I'm editing." };
  const category = await chat.ensureCategory("graphite");
  store.upsertClot("graphite", category);
  live = await chat.createChannel(category, "graphite-1110");
  store.createSession({ id: "s1", clot: "graphite", channelId: live, seed: null });
  steering = new Steering({ store, chat, explainer, userId: USER, timeZone: "UTC", clots: new Map([["graphite", port]]) });
});

describe("Steering", () => {
  it("asks in a temporary channel, mentioning the user and listing the replies it accepts", async () => {
    expect(await steering.ask("graphite", event("d-1"), "CI failed.")).toBe(true);

    const channel = chat.channels.find((c) => c.name === "graphite-ask")!;
    expect(chat.postsIn(channel.id)).toHaveLength(1);
    expect(chat.postsIn(channel.id)[0]).toContain("<@user-1> CI just failed on the branch I'm editing.");
    expect(chat.postsIn(channel.id)[0]).toContain("`after`");
    expect(store.getEvent("d-1")!.status).toBe("asking");
    expect(store.askByChannel(channel.id)).toMatchObject({ eventId: "d-1", clot: "graphite" });
  });

  it("numbers the channel when another question is open", async () => {
    await steering.ask("graphite", event("d-1"), "CI failed.");
    await steering.ask("graphite", event("d-2"), "CI failed again.");
    expect(chat.channels.map((c) => c.name)).toContain("graphite-ask-2");
  });

  it("on yes, feeds the event into the running turn as untrusted data, says so in the live channel, and deletes the channel", async () => {
    await steering.ask("graphite", event("d-1"), "CI failed.");
    const channel = askChannel();

    expect(await steering.onReply(reply(channel, "Yeah!"))).toBe(true);

    expect(port.steered).toHaveLength(1);
    expect(port.steered[0]).toContain("an event the user approved handling now");
    expect(port.steered[0]).toContain("title: CI failed: CI on clot/fix-login");
    expect(store.getEvent("d-1")!.status).toBe("steered");
    expect(chat.postsIn(live).at(-1)).toBe("CI failed on the branch being worked on. <https://github.com/octo/widgets/actions/runs/4242> (handling it now, as you approved)");
    expect(chat.deleted).toEqual([channel]);
    expect(store.openAsks("graphite")).toEqual([]);
  });

  it("on after, queues the event and deletes the channel", async () => {
    await steering.ask("graphite", event("d-1"), "CI failed.");
    const channel = askChannel();
    await steering.onReply(reply(channel, "not rn"));
    expect(port.steered).toEqual([]);
    expect(port.queued).toEqual([{ id: "d-1", notice: "CI failed on the branch being worked on.", kick: true }]);
    expect(chat.deleted).toEqual([channel]);
  });

  it("on no, drops the event and deletes the channel", async () => {
    await steering.ask("graphite", event("d-1"), "CI failed.");
    const channel = askChannel();
    await steering.onReply(reply(channel, "don't"));
    expect(port.steered).toEqual([]);
    expect(port.queued).toEqual([]);
    expect(store.getEvent("d-1")).toMatchObject({ status: "dropped", note: "declined by the user" });
    expect(chat.deleted).toEqual([channel]);
  });

  it("asks again when the reply is not one it accepts, and keeps the question open", async () => {
    await steering.ask("graphite", event("d-1"), "CI failed.");
    const channel = askChannel();
    await steering.onReply(reply(channel, "ok go on then"));
    expect(chat.postsIn(channel).at(-1)).toContain("I couldn't match that reply.");
    expect(chat.deleted).toEqual([]);
    await steering.onReply(reply(channel, "yes"));
    expect(port.steered).toHaveLength(1);
  });

  it("ignores other people in the question's channel, and leaves other channels alone", async () => {
    await steering.ask("graphite", event("d-1"), "CI failed.");
    const channel = askChannel();
    expect(await steering.onReply(reply(channel, "yes", "stranger"))).toBe(true);
    expect(port.steered).toEqual([]);
    expect(await steering.onReply(reply(live, "yes"))).toBe(false);
  });

  it("queues a yes that came too late for the turn to accept", async () => {
    await steering.ask("graphite", event("d-1"), "CI failed.");
    port.accepts = false;
    await steering.onReply(reply(askChannel(), "yes"));
    expect(port.queued.map((q) => q.id)).toEqual(["d-1"]);
    expect(store.getEvent("d-1")!.status).not.toBe("steered");
  });

  it("lapses every open question to the queue, without kicking the Clot's drain", async () => {
    await steering.ask("graphite", event("d-1"), "CI failed.");
    await steering.ask("graphite", event("d-2"), "CI failed again.");
    const channels = store.openAsks("graphite").map((a) => a.channelId);

    await steering.lapse("graphite");

    expect(port.queued).toEqual([
      { id: "d-1", notice: "CI failed on the branch being worked on.", kick: false },
      { id: "d-2", notice: "CI failed on the branch being worked on.", kick: false },
    ]);
    expect(chat.deleted).toEqual(channels);
    expect(await steering.onReply(reply(channels[0], "yes"))).toBe(false);
  });

  it("queues at once when the turn ended while the question was being written", async () => {
    port.busy = false;
    expect(await steering.ask("graphite", event("d-1"), "CI failed.")).toBe(true);
    expect(port.queued.map((q) => q.id)).toEqual(["d-1"]);
    expect(store.openAsks("graphite")).toEqual([]);
  });

  it("uses the bare facts when the explainer fails", async () => {
    explainer.explain = async () => {
      throw new Error("model unavailable");
    };
    await steering.ask("graphite", event("d-1"), "CI failed.");
    expect(chat.postsIn(askChannel())[0]).toContain("CI failed.\nCI failed: CI on clot/fix-login");
  });

  it("reports that it could not ask when the channel cannot be created", async () => {
    chat.createChannel = async () => {
      throw new Error("Missing Permissions");
    };
    expect(await steering.ask("graphite", event("d-1"), "CI failed.")).toBe(false);
    expect(store.openAsks("graphite")).toEqual([]);
    expect(await steering.ask("unknown", event("d-2"), "CI failed.")).toBe(false);
  });

  it("queues the event when the question cannot be posted", async () => {
    const post = chat.post.bind(chat);
    chat.post = async (channelId, text) => {
      if (text.includes("Reply with one of")) throw new Error("Discord is down");
      return post(channelId, text);
    };
    expect(await steering.ask("graphite", event("d-1"), "CI failed.")).toBe(true);
    expect(port.queued.map((q) => q.id)).toEqual(["d-1"]);
    expect(store.openAsks("graphite")).toEqual([]);
  });
});
