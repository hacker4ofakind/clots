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
