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

  it("clears the tail", () => {
    store.appendTail("graphite", "user", "old");
    store.clearTail("graphite");
    expect(store.tail("graphite", 4)).toEqual([]);
  });

  it("returns the last n tail messages, oldest first", () => {
    for (const n of [1, 2, 3, 4, 5]) store.appendTail("graphite", n % 2 ? "user" : "clot", `t${n}`);
    expect(store.tail("graphite", 4).map((m) => m.text)).toEqual(["t2", "t3", "t4", "t5"]);
  });
});
