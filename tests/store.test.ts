import { beforeEach, describe, expect, it } from "vitest";
import { Store } from "../src/store.js";

let store: Store;
beforeEach(() => {
  store = new Store(":memory:");
  store.upsertClot("graphite", "cat-1");
});

describe("Store", () => {
  it("creates a clot in action mode, not paused", () => {
    expect(store.getClot("graphite")).toEqual({ name: "graphite", categoryId: "cat-1", mode: "action", pausedUntil: null });
  });

  it("keeps one active session per clot", () => {
    store.createSession({ id: "s1", clot: "graphite", channelId: "ch-1", seed: null });
    store.createSession({ id: "s2", clot: "graphite", channelId: "ch-2", seed: "recap" });
    expect(store.activeSession("graphite")).toMatchObject({ id: "s2", channelId: "ch-2", seed: "recap", started: false });
    expect(store.sessionByChannel("ch-1")).toMatchObject({ id: "s1", active: false });
  });

  it("rejects a duplicate inbox id", () => {
    const msg = { id: "m1", clot: "graphite", channelId: "ch-1", text: "hi", receivedAt: 1 };
    expect(store.enqueue(msg)).toBe(true);
    expect(store.enqueue(msg)).toBe(false);
  });

  it("returns pending messages in arrival order", () => {
    store.enqueue({ id: "m1", clot: "graphite", channelId: "ch-1", text: "first", receivedAt: 1 });
    store.enqueue({ id: "m2", clot: "graphite", channelId: "ch-1", text: "second", receivedAt: 2 });
    expect(store.nextPending("graphite")?.text).toBe("first");
    store.setInboxStatus("m1", "running");
    expect(store.nextPending("graphite")?.text).toBe("second");
  });

  it("requeues running messages after a crash", () => {
    store.enqueue({ id: "m1", clot: "graphite", channelId: "ch-1", text: "first", receivedAt: 1 });
    store.setInboxStatus("m1", "running");
    expect(store.requeueRunning("graphite")).toBe(1);
    expect(store.nextPending("graphite")?.id).toBe("m1");
  });

  it("records why a session was started", () => {
    store.createSession({ id: "s1", clot: "graphite", channelId: "ch-1", seed: null });
    expect(store.activeSession("graphite")!.seedReason).toBe("context");
    store.createSession({ id: "s2", clot: "graphite", channelId: "ch-2", seed: "recap", seedReason: "user" });
    expect(store.activeSession("graphite")!.seedReason).toBe("user");
  });

  it("hands out a one-off effort override exactly once", () => {
    expect(store.takeNextEffort("graphite")).toBeNull();
    store.setNextEffort("graphite", "high");
    expect(store.takeNextEffort("graphite")).toBe("high");
    expect(store.takeNextEffort("graphite")).toBeNull();
  });

  it("shows a one-off effort override without using it up", () => {
    store.setNextEffort("graphite", "low");
    expect(store.nextEffort("graphite")).toBe("low");
    expect(store.nextEffort("graphite")).toBe("low");
  });

  it("drops a session's seed", () => {
    store.createSession({ id: "s1", clot: "graphite", channelId: "ch-1", seed: "recap" });
    store.clearSeed("s1");
    expect(store.activeSession("graphite")!.seed).toBeNull();
  });

  it("clears the tail", () => {
    store.appendTail("graphite", "user", "old");
    store.clearTail("graphite");
    expect(store.tail("graphite", 4)).toEqual([]);
  });

  it("remembers what a cut-off turn was for, and forgets it when the session carries on", () => {
    store.upsertClot("kinds", "cat-9");
    store.createSession({ id: "k1", clot: "kinds", channelId: "ch-k", seed: null });
    expect(store.activeSession("kinds")).toMatchObject({ interrupted: false, interruptedKind: "message" });
    store.setInterrupted("k1", true, "event");
    expect(store.activeSession("kinds")).toMatchObject({ interrupted: true, interruptedKind: "event" });
    store.setInterrupted("k1", false);
    expect(store.activeSession("kinds")).toMatchObject({ interrupted: false, interruptedKind: "message" });
  });

  it("marks inbox rows as messages unless told they are events", () => {
    store.enqueue({ id: "m1", clot: "graphite", channelId: "ch-1", text: "hi", receivedAt: 1 });
    store.enqueue({ id: "event:d-1", clot: "graphite", channelId: "ch-1", text: "<event>", receivedAt: 2, kind: "event" });
    expect(store.nextPending("graphite")!.kind).toBe("message");
    store.setInboxStatus("m1", "done");
    expect(store.nextPending("graphite")!.kind).toBe("event");
  });

  describe("events", () => {
    const event = {
      id: "d-1",
      source: "github" as const,
      kind: "issue_opened" as const,
      repo: "octo/widgets",
      actor: "someone",
      title: "Issue #7 opened: Login fails",
      body: "Steps...",
      url: "https://github.com/octo/widgets/issues/7",
      ref: "7",
      subject: "issue:7",
      automated: false,
      receivedAt: 1000,
    };

    it("stores an event once and gives it back unchanged", () => {
      expect(store.insertEvent(event)).toBe(true);
      expect(store.insertEvent(event)).toBe(false);
      expect(store.getEvent("d-1")).toEqual({ ...event, clot: null, status: "received", note: null, triageMessage: null, urgent: false });
      expect(store.getEvent("missing")).toBeUndefined();
    });

    it("records the Clot, the triage answer and the status with its reason", () => {
      store.insertEvent(event);
      store.setEventClot("d-1", "graphite");
      store.recordTriage("d-1", "Login fails. Looking into it.", true);
      store.setEventStatus("d-1", "dropped", "declined by the user");
      expect(store.getEvent("d-1")).toMatchObject({ clot: "graphite", triageMessage: "Login fails. Looking into it.", urgent: true, status: "dropped", note: "declined by the user" });
      store.setEventStatus("d-1", "queued");
      expect(store.getEvent("d-1")).toMatchObject({ status: "queued", note: null });
    });

    it("replaces an event's body, and keeps what it is about and whether a machine made it", () => {
      store.insertEvent({ ...event, subject: "pr:14", automated: true });
      store.setEventBody("d-1", "Steps...\n\nInline comments:\n- a.ts:3: rename");
      store.setEventStatus("d-1", "held");
      expect(store.getEvent("d-1")).toMatchObject({ body: "Steps...\n\nInline comments:\n- a.ts:3: rename", subject: "pr:14", automated: true, status: "held" });
    });

    it("remembers that an event's body was added to, whatever the body says", () => {
      store.insertEvent({ ...event, body: "See the Inline comments: they explain it." });
      expect(store.isEnriched("d-1")).toBe(false);
      store.setEventBody("d-1", "See the Inline comments: they explain it.");
      expect(store.isEnriched("d-1")).toBe(true);
      expect(store.isEnriched("missing")).toBe(false);
    });

    it("records the release of a held group in one step", () => {
      for (const id of ["d-1", "d-2", "d-3"]) {
        store.insertEvent({ ...event, id });
        store.setEventStatus(id, "held");
      }
      store.recordRelease({ event: { ...event, id: "batch:d-1", kind: "batch" }, clot: "graphite", isNew: true, absorbed: ["d-1", "d-2"] });
      expect(store.getEvent("batch:d-1")).toMatchObject({ status: "received", clot: "graphite" });
      expect(store.eventsWithStatus("merged").map((e) => [e.id, e.note])).toEqual([
        ["d-1", "into batch:d-1"],
        ["d-2", "into batch:d-1"],
      ]);

      store.recordRelease({ event: store.getEvent("d-3")!, clot: "graphite", isNew: false, absorbed: [] });
      expect(store.getEvent("d-3")!.status).toBe("received");
      expect(store.eventsWithStatus("held")).toEqual([]);
    });

    it("lets only one caller close a question", () => {
      store.createAsk({ eventId: "d-1", clot: "graphite", channelId: "ask-1" });
      expect(store.deleteAsk("d-1")).toBe(true);
      expect(store.deleteAsk("d-1")).toBe(false);
    });

    it("lists events by status, oldest first", () => {
      store.insertEvent(event);
      store.insertEvent({ ...event, id: "d-2" });
      store.insertEvent({ ...event, id: "d-3" });
      store.setEventStatus("d-2", "queued");
      expect(store.eventsWithStatus("received").map((e) => e.id)).toEqual(["d-1", "d-3"]);
    });

    it("keeps open steering questions by channel and by Clot", () => {
      store.createAsk({ eventId: "d-1", clot: "graphite", channelId: "ask-1" });
      store.createAsk({ eventId: "d-2", clot: "graphite", channelId: "ask-2" });
      expect(store.askByChannel("ask-2")).toEqual({ eventId: "d-2", clot: "graphite", channelId: "ask-2" });
      expect(store.openAsks("graphite").map((a) => a.eventId)).toEqual(["d-1", "d-2"]);
      store.deleteAsk("d-1");
      expect(store.askByChannel("ask-1")).toBeUndefined();
      expect(store.openAsks("graphite").map((a) => a.eventId)).toEqual(["d-2"]);
      expect(store.openAsks("other")).toEqual([]);
    });
  });

  it("returns the last n tail messages, oldest first", () => {
    for (const n of [1, 2, 3, 4, 5]) store.appendTail("graphite", n % 2 ? "user" : "clot", `t${n}`);
    expect(store.tail("graphite", 4).map((m) => m.text)).toEqual(["t2", "t3", "t4", "t5"]);
  });
});

describe("Store, stage 2b", () => {
  const proposal = (clot: string, channelId: string) => ({ clot, channelId, channelName: `${clot}-rule`, scope: "own" as const, edit: '{"op":"add_guidance","line":"x"}', summary: 'Add triage guidance: "x"' });

  it("keeps proposals until they are closed, and closes each exactly once", () => {
    const store = new Store(":memory:");
    const first = store.createProposal(proposal("graphite", "ch-1"));
    store.createProposal(proposal("graphite", "ch-2"));
    store.createProposal(proposal("other", "ch-3"));
    expect(store.openProposals("graphite").map((p) => p.channelId)).toEqual(["ch-1", "ch-2"]);
    expect(store.openProposals().map((p) => p.channelId)).toEqual(["ch-1", "ch-2", "ch-3"]);
    expect(store.proposalByChannel("ch-1")).toMatchObject({ id: first, clot: "graphite", scope: "own", channelName: "graphite-rule" });
    expect(store.deleteProposal(first)).toBe(true);
    expect(store.deleteProposal(first)).toBe(false);
    expect(store.proposalByChannel("ch-1")).toBeUndefined();
  });

  it("keeps notes in order and clears them up to a point", () => {
    const store = new Store(":memory:");
    store.addNote("graphite", "first");
    store.addNote("graphite", "second");
    store.addNote("other", "theirs");
    const notes = store.notes("graphite");
    expect(notes.map((n) => n.text)).toEqual(["first", "second"]);
    store.addNote("graphite", "third");
    store.clearNotes("graphite", notes[1].seq);
    expect(store.notes("graphite").map((n) => n.text)).toEqual(["third"]);
    store.clearNotes("graphite");
    expect(store.notes("graphite")).toEqual([]);
    expect(store.notes("other").map((n) => n.text)).toEqual(["theirs"]);
  });

  it("gives back the latest edit that has not been undone, per Clot", () => {
    const store = new Store(":memory:");
    store.logRuleEdit({ clot: "graphite", file: "graphite", inverse: "{}", summary: "one" });
    store.logRuleEdit({ clot: "other", file: "global", inverse: "{}", summary: "theirs" });
    store.logRuleEdit({ clot: "graphite", file: "global", inverse: "{}", summary: "two" });
    const last = store.lastRuleEdit("graphite")!;
    expect(last).toMatchObject({ summary: "two", file: "global" });
    store.markRuleEditUndone(last.id);
    expect(store.lastRuleEdit("graphite")).toMatchObject({ summary: "one" });
    store.markRuleEditUndone(store.lastRuleEdit("graphite")!.id);
    expect(store.lastRuleEdit("graphite")).toBeUndefined();
  });

  it("lets a rule be sent for an event once, and again only after the claim is released", () => {
    const store = new Store(":memory:");
    expect(store.hasSend("d-1", "ack")).toBe(false);
    expect(store.claimSend("d-1", "ack")).toBe(true);
    expect(store.claimSend("d-1", "ack")).toBe(false);
    expect(store.claimSend("d-1", "other-rule")).toBe(true);
    expect(store.claimSend("d-2", "ack")).toBe(true);
    store.setSendUrl("d-1", "ack", "https://example.test/c1");
    expect(store.hasSend("d-1", "ack")).toBe(true);
    store.releaseSend("d-1", "ack");
    expect(store.claimSend("d-1", "ack")).toBe(true);
  });

  it("lists the events a batch was made from, oldest first", () => {
    const store = new Store(":memory:");
    const event = (id: string) => ({ id, source: "github" as const, kind: "comment" as const, repo: "octo/widgets", actor: "vercel[bot]", title: "t", body: "", url: "u", ref: "14", subject: "pr:14", automated: true, receivedAt: 0 });
    store.insertEvent(event("d-1"));
    store.insertEvent(event("d-2"));
    store.insertEvent(event("d-3"));
    store.recordRelease({ event: { ...event("batch:d-1"), kind: "batch" }, clot: "graphite", isNew: true, absorbed: ["d-1", "d-2"] });
    expect(store.eventsMergedInto("batch:d-1").map((e) => e.id)).toEqual(["d-1", "d-2"]);
    expect(store.eventsMergedInto("d-3")).toEqual([]);
  });

  it("remembers which event an inbox row and a cut-off turn belong to", () => {
    const store = new Store(":memory:");
    store.upsertClot("graphite", "cat");
    store.createSession({ id: "s1", clot: "graphite", channelId: "ch-1", seed: null });
    store.enqueue({ id: "event:d-1", clot: "graphite", channelId: "ch-1", text: "x", receivedAt: 0, kind: "event", eventId: "d-1" });
    store.enqueue({ id: "m1", clot: "graphite", channelId: "ch-1", text: "hi", receivedAt: 1 });
    expect(store.nextPending("graphite")).toMatchObject({ id: "event:d-1", eventId: "d-1" });
    store.setInboxStatus("event:d-1", "done");
    expect(store.nextPending("graphite")).toMatchObject({ id: "m1", eventId: null });

    store.setInterrupted("s1", true, "event", "d-1");
    expect(store.activeSession("graphite")).toMatchObject({ interrupted: true, interruptedKind: "event", interruptedEvent: "d-1" });
    store.setInterrupted("s1", false);
    expect(store.activeSession("graphite")).toMatchObject({ interrupted: false, interruptedEvent: null });
  });
});

describe("Store, global memory", () => {
  it("keeps the approved set, logs each change with what it replaced, and undoes the latest first", () => {
    const store = new Store(":memory:");
    store.applyMemoryChange("global-clot-b.md", "b1");
    store.applyMemoryChange("global-clot-a.md", "a1");
    store.applyMemoryChange("global-clot-a.md", "a2");
    store.applyMemoryChange("global-clot-b.md", null);
    expect([...store.approvedMemories()]).toEqual([["global-clot-a.md", "a2"]]);

    const deletion = store.lastMemoryChange()!;
    expect(deletion).toMatchObject({ file: "global-clot-b.md", oldText: "b1", newText: null });
    store.undoMemoryChange(deletion);
    const change = store.lastMemoryChange()!;
    expect(change).toMatchObject({ file: "global-clot-a.md", oldText: "a1", newText: "a2" });
    store.undoMemoryChange(change);
    expect([...store.approvedMemories()]).toEqual([
      ["global-clot-a.md", "a1"],
      ["global-clot-b.md", "b1"],
    ]);
    store.undoMemoryChange(store.lastMemoryChange()!);
    expect(store.lastMemoryChange()).toMatchObject({ file: "global-clot-b.md", oldText: null, newText: "b1" });
    store.undoMemoryChange(store.lastMemoryChange()!);
    expect(store.approvedMemories().size).toBe(0);
    expect(store.lastMemoryChange()).toBeUndefined();
  });

  it("keeps questions until they are closed, and closes each exactly once", () => {
    const store = new Store(":memory:");
    store.createMemoryQuestion({ file: "global-clot-b.md", text: "b", channelId: "ch-2", channelName: "home-memory-2" });
    store.createMemoryQuestion({ file: "global-clot-a.md", text: "a", channelId: "ch-1", channelName: "home-memory" });
    expect(store.memoryQuestions().map((q) => q.file)).toEqual(["global-clot-a.md", "global-clot-b.md"]);
    store.setMemoryQuestionText("global-clot-a.md", "a2");
    expect(store.memoryQuestionByChannel("ch-1")).toEqual({ file: "global-clot-a.md", text: "a2", channelId: "ch-1", channelName: "home-memory" });
    expect(store.deleteMemoryQuestion("global-clot-a.md")).toBe(true);
    expect(store.deleteMemoryQuestion("global-clot-a.md")).toBe(false);
    expect(store.memoryQuestionByChannel("ch-1")).toBeUndefined();
  });

  it("remembers which of the home Clot's copies are still to be put back", () => {
    const store = new Store(":memory:");
    store.addMemoryRestore("global-clot-b.md");
    store.addMemoryRestore("global-clot-a.md");
    store.addMemoryRestore("global-clot-a.md");
    expect(store.memoryRestores()).toEqual(["global-clot-a.md", "global-clot-b.md"]);
    store.clearMemoryRestores(["global-clot-a.md"]);
    expect(store.memoryRestores()).toEqual(["global-clot-b.md"]);
  });
});
