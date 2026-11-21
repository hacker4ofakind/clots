import { beforeEach, describe, expect, it } from "vitest";
import { DELIVERY_KEEP } from "../src/composio/store.js";
import { Store } from "../src/store.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 10, 21, 12, 0, 0);
let store: Store;

const keep = (n: number, at: number, over: Partial<Parameters<Store["composio"]["keepDelivery"]>[0]> = {}) =>
  store.composio.keepDelivery({ webhookId: `msg_${n}`, user: "slack:work", slug: "SLACK_RECEIVE_MESSAGE", eventId: `slack:work:${n}`, payload: { n }, receivedAt: at, ...over });
const ids = (user = "slack:work", slug?: string) => store.composio.samples(user, slug).map((r) => r.webhookId);

beforeEach(() => {
  store = new Store(":memory:");
});

describe("kept deliveries", () => {
  it("keeps the newest five of a trigger of an account, newest first, the sixth pruning the oldest", () => {
    for (let n = 1; n <= 6; n++) keep(n, NOW - (7 - n) * 2 * HOUR);
    expect(ids()).toEqual(["msg_6", "msg_5", "msg_4", "msg_3", "msg_2"]);
    expect(store.composio.delivery("msg_1")).toBeUndefined();
  });

  it("never prunes a delivery younger than an hour, whatever the count, so its enrichment can still read it", () => {
    for (let n = 1; n <= 8; n++) keep(n, NOW - (9 - n) * 60_000);
    // The samples shown are the newest five, but all eight are kept.
    expect(ids()).toHaveLength(5);
    for (let n = 1; n <= 8; n++) expect(store.composio.delivery(`msg_${n}`)).toBeDefined();
    // An hour on, the count applies.
    store.composio.pruneDeliveries(NOW + 2 * HOUR);
    expect(store.composio.delivery("msg_3")).toBeUndefined();
    expect(ids()).toEqual(["msg_8", "msg_7", "msg_6", "msg_5", "msg_4"]);
  });

  it("deletes a row older than 7 days, even one of the newest five", () => {
    keep(1, NOW - 7 * DAY - 1);
    keep(2, NOW - 6 * DAY);
    store.composio.pruneDeliveries(NOW);
    expect(ids()).toEqual(["msg_2"]);
    store.composio.pruneDeliveries(NOW + 2 * DAY);
    expect(ids()).toEqual([]);
  });

  it("counts each account and each trigger apart", () => {
    for (let n = 1; n <= 6; n++) {
      keep(n, NOW - n * 2 * HOUR);
      keep(100 + n, NOW - n * 2 * HOUR, { slug: "SLACK_CHANNEL_CREATED" });
      keep(200 + n, NOW - n * 2 * HOUR, { user: "slack:other" });
    }
    expect(store.composio.samples("slack:work", "SLACK_RECEIVE_MESSAGE")).toHaveLength(5);
    expect(store.composio.samples("slack:work", "SLACK_CHANNEL_CREATED")).toHaveLength(5);
    expect(store.composio.samples("slack:work")).toHaveLength(10);
    expect(store.composio.samples("slack:other")).toHaveLength(5);
  });

  it("keeps one row per webhook ID, the first", () => {
    keep(1, NOW, { payload: { first: true } });
    keep(1, NOW + 1000, { payload: { second: true } });
    expect(store.composio.samples("slack:work")).toHaveLength(1);
    expect(JSON.parse(store.composio.delivery("msg_1")!.payload)).toEqual({ first: true });
  });

  it("clips a 70 KB payload to 64,000 characters and marks it partial", () => {
    keep(1, NOW, { payload: { text: "x".repeat(70_000) } });
    const row = store.composio.delivery("msg_1")!;
    expect(row.clipped).toBe(true);
    expect(row.payload).toHaveLength(DELIVERY_KEEP.payloadChars);
    keep(2, NOW, { payload: { text: "small" } });
    expect(store.composio.delivery("msg_2")!.clipped).toBe(false);
  });

  it("finds a delivery by the event it became, and not by an empty ID", () => {
    keep(1, NOW);
    keep(2, NOW, { eventId: "" });
    expect(store.composio.deliveryByEvent("slack:work:1")?.webhookId).toBe("msg_1");
    expect(store.composio.deliveryByEvent("")).toBeUndefined();
    expect(store.composio.deliveryByEvent("nothing")).toBeUndefined();
  });
});

describe("kept reads", () => {
  it("serves a read for 24 hours, then not, and prunes what is older", () => {
    store.composio.keepRead("slack:work", "SLACK_X", "h1", { a: 1 }, NOW);
    expect(store.composio.cachedRead("slack:work", "SLACK_X", "h1", NOW + DAY - 1)).toEqual({ a: 1 });
    expect(store.composio.cachedRead("slack:work", "SLACK_X", "h1", NOW + DAY)).toBeUndefined();
    store.composio.pruneReads(NOW + DAY + 1);
    expect(store.composio.cachedRead("slack:work", "SLACK_X", "h1", NOW)).toBeUndefined();
  });

  it("keeps account, tool and arguments apart, and replaces a read read again", () => {
    store.composio.keepRead("slack:work", "SLACK_X", "h1", { a: 1 }, NOW);
    expect(store.composio.cachedRead("slack:other", "SLACK_X", "h1", NOW)).toBeUndefined();
    expect(store.composio.cachedRead("slack:work", "SLACK_X", "h2", NOW)).toBeUndefined();
    store.composio.keepRead("slack:work", "SLACK_X", "h1", { a: 2 }, NOW + 5);
    expect(store.composio.cachedRead("slack:work", "SLACK_X", "h1", NOW + 6)).toEqual({ a: 2 });
  });
});
