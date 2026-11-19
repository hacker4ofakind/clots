import crypto from "node:crypto";
import fs from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { Composio } from "../src/composio/component.js";
import { composioHandler, type Mapper } from "../src/composio/intake.js";
import { Meter } from "../src/composio/meter.js";
import type { ComposioAccount } from "../src/config.js";
import type { ClotEvent } from "../src/events/types.js";
import type { Incoming } from "../src/intake.js";
import { Supervisor } from "../src/listeners.js";
import { Store } from "../src/store.js";
import { FakeComposioApi } from "./fake-composio.js";

const SECRET = "whsec_test_secret";
const NOW = Date.UTC(2026, 10, 19, 17, 40, 0);
const fixture = JSON.parse(fs.readFileSync("tests/fixtures/composio/linear/01-composio.trigger.message.LINEAR_PRIVATE_TEAM_ISSUE_CREATED.json", "utf8"));
const RAW: string = fixture.raw;

const base = { shared: false, audience: "team" as const, triggers: [] };
const linear: ComposioAccount = { ...base, toolkit: "linear", account: "proton", shared: true, apiKey: "k", apiKeyName: "K" };
const slack: ComposioAccount = { ...base, toolkit: "slack", account: "work", shared: true, apiKey: "k", apiKeyName: "K", triggers: [{ slug: "SLACK_MSG", config: {} }] };
const notion: ComposioAccount = { ...base, toolkit: "notion", account: "main", shared: true, apiKey: "k", apiKeyName: "K" };

let store: Store;
let stored: ClotEvent[];
let lifecycle: string[];
let composio: Composio;

/** A stand-in for Task 5's Linear mapper: the same shape, keyed on the issue's own ID. */
const linearMapper: Mapper = (account, _slug, data: any, _webhookId, receivedAt) => ({
  event: { id: `linear:${account.account}:${data.id}`, source: "linear", account: account.account, kind: "issue_opened", place: data.team.key, actor: data.creator.name, title: `Issue ${data.identifier} opened: ${data.title}`, body: "", url: data.url, ref: data.identifier, subject: `issue:${data.identifier}`, automated: false, outsider: false, receivedAt },
  actorId: data.creator.id,
  objectIds: [data.id],
});
const genericMapper: Mapper = (account, slug, _data, webhookId, receivedAt) => ({
  event: { id: `composio:${webhookId}`, source: account.toolkit, account: account.account, kind: "trigger", place: "x", actor: "unknown", title: slug, body: "", url: "", ref: slug, subject: `${account.toolkit}:${slug}`, automated: false, outsider: true, receivedAt },
  actorId: "",
});

function sign(raw: string, o: { id?: string; timestamp?: number; secret?: string } = {}): Record<string, string> {
  const id = o.id ?? fixture.headers["webhook-id"];
  const timestamp = String(o.timestamp ?? Math.floor(NOW / 1000));
  const signature = "v1," + crypto.createHmac("sha256", o.secret ?? SECRET).update(`${id}.${timestamp}.${raw}`).digest("base64");
  return { "webhook-id": id, "webhook-timestamp": timestamp, "webhook-signature": signature, "content-type": "application/json" };
}

function request(raw: string, headers: Record<string, string>): Incoming {
  return { method: "POST", headers, query: new URLSearchParams(), rawBody: Buffer.from(raw) };
}

const handlerFor = (secret: string | null = SECRET, extra: { meter?: Meter } = {}) =>
  composioHandler({
    composio,
    secret: () => secret ?? undefined,
    mappers: { linear: linearMapper, generic: genericMapper },
    insertEvent: (e) => (stored.some((s) => s.id === e.id) ? false : (stored.push(e), true)),
    now: () => NOW,
    log: () => {},
    ...extra,
  });

async function setUp(accounts: ComposioAccount[]) {
  composio = new Composio({
    api: new FakeComposioApi(),
    store,
    accounts,
    publicUrl: "https://box.example.ts.net",
    tell: async () => {},
    tellHome: async () => {},
    now: () => NOW,
    schedule: () => () => {},
    supervisor: new Supervisor({ schedule: () => () => {} }),
    log: () => {},
  });
  await composio.reconcile();
  // The fixture's connection ID is the real one; point the fake store at it.
  store.composio.setAccount("linear:proton", { connectionId: fixture.body.metadata.connected_account_id });
  composio.triggerDisabled = async (id, reason) => void lifecycle.push(`disabled ${id} ${reason ?? ""}`);
  composio.connectionExpired = async (id) => void lifecycle.push(`expired ${id}`);
}

beforeEach(async () => {
  store = new Store(":memory:");
  stored = [];
  lifecycle = [];
  await setUp([linear, slack, notion]);
});

describe("composioHandler", () => {
  it("stores a correctly signed delivery once and calls a repeat a duplicate", async () => {
    const handler = handlerFor();
    const first = await handler(request(RAW, sign(RAW)));
    expect(first).toMatchObject({ status: 202, text: "accepted" });
    expect(first.event).toMatchObject({ id: "linear:proton:efe2859b-4676-43d8-8910-fa6758ad9c37", source: "linear", kind: "issue_opened", place: "CLO" });
    expect(first.dropped).toBeUndefined();
    expect(await handler(request(RAW, sign(RAW)))).toEqual({ status: 200, text: "duplicate" });
    expect(stored).toHaveLength(1);
  });

  it("refuses a wrong signature, a timestamp 301 seconds old, and a missing webhook-id, and stores nothing", async () => {
    const handler = handlerFor();
    expect(await handler(request(RAW, sign(RAW, { secret: "whsec_other" })))).toMatchObject({ status: 401 });
    expect(await handler(request(RAW, sign(RAW, { timestamp: Math.floor(NOW / 1000) - 301 })))).toMatchObject({ status: 401, text: expect.stringContaining("stale") });
    expect(await handler(request(RAW, sign(RAW, { timestamp: Math.floor(NOW / 1000) + 301 })))).toMatchObject({ status: 401 });
    const { "webhook-id": _drop, ...noId } = sign(RAW);
    expect(await handler(request(RAW, noId))).toMatchObject({ status: 400 });
    expect(await handler(request(RAW, { ...sign(RAW), "webhook-signature": "" }))).toMatchObject({ status: 400 });
    expect(stored).toEqual([]);
  });

  it("accepts a timestamp 299 seconds old", async () => {
    expect(await handlerFor()(request(RAW, sign(RAW, { timestamp: Math.floor(NOW / 1000) - 299 })))).toMatchObject({ status: 202 });
  });

  it("accepts any of several signatures in the header, as Composio may send during a secret rotation", async () => {
    const good = sign(RAW);
    const headers = { ...good, "webhook-signature": `v1,AAAA ${good["webhook-signature"]}` };
    expect(await handlerFor()(request(RAW, headers))).toMatchObject({ status: 202 });
  });

  it("answers 503 while no secret is stored, and 400 for a body that is not JSON", async () => {
    expect(await handlerFor(null)(request(RAW, sign(RAW)))).toMatchObject({ status: 503 });
    const junk = "not json";
    expect(await handlerFor()(request(junk, sign(junk)))).toMatchObject({ status: 400 });
  });

  it("acknowledges and discards a delivery from a connection it does not know", async () => {
    const other = RAW.replace(fixture.body.metadata.connected_account_id, "ca_unknown");
    expect(await handlerFor()(request(other, sign(other)))).toEqual({ status: 200, text: "unknown account" });
    expect(stored).toEqual([]);
  });

  it("stores an event by the Clots' own Linear member with dropped set, so it goes no further", async () => {
    store.composio.setAccount("linear:proton", { identity: fixture.body.data.creator.id });
    const answer = await handlerFor()(request(RAW, sign(RAW)));
    expect(answer).toMatchObject({ status: 202, dropped: "caused by the Clot itself" });
    expect(stored).toHaveLength(1);
  });

  it("does not drop an event while no identity is known, nor when the actor is someone else", async () => {
    expect((await handlerFor()(request(RAW, sign(RAW)))).dropped).toBeUndefined();
    stored = [];
    store.composio.setAccount("linear:proton", { identity: "someone-else" });
    expect((await handlerFor()(request(RAW, sign(RAW)))).dropped).toBeUndefined();
  });

  it("stores one event for one issue however many deliveries name it, such as a repeated poll", async () => {
    const handler = handlerFor();
    await handler(request(RAW, sign(RAW)));
    const again = RAW.replace(fixture.body.id, "msg_other");
    expect(await handler(request(again, sign(again, { id: "msg_other" })))).toEqual({ status: 200, text: "duplicate" });
    expect(stored).toHaveLength(1);
  });

  it("drops as self-caused an event about an object a Clot's write touched 2 minutes ago, and not one 11 minutes ago", async () => {
    const id = store.composio.addWrite({ clot: "graphite", account: "linear:proton", slug: "LINEAR_CREATE_LINEAR_ISSUE", args: {}, at: NOW - 2 * 60_000 });
    store.composio.finishWrite(id, { outcome: "ran", result: {}, touched: [fixture.body.data.id], created: [fixture.body.data.id] });
    expect(await handlerFor()(request(RAW, sign(RAW)))).toMatchObject({ status: 202, dropped: "caused by the Clot itself" });

    stored = [];
    store.composio.addWrite({ clot: "graphite", account: "linear:proton", slug: "x", args: {}, at: NOW - 11 * 60_000 });
    const old = new Store(":memory:");
    const oldId = old.composio.addWrite({ clot: "graphite", account: "linear:proton", slug: "x", args: {}, at: NOW - 11 * 60_000 });
    old.composio.finishWrite(oldId, { outcome: "ran", result: {}, touched: [fixture.body.data.id], created: [] });
    store = old;
    await setUp([linear]);
    expect((await handlerFor()(request(RAW, sign(RAW)))).dropped).toBeUndefined();
  });

  it("maps a toolkit with no built-in mapper through the generic one when the account names triggers, and ignores it otherwise", async () => {
    const body = JSON.stringify({ ...fixture.body, metadata: { ...fixture.body.metadata, trigger_slug: "SLACK_MSG", toolkit_slug: "slack", connected_account_id: "ca_slack" }, data: { text: "hi" } });
    store.composio.setAccount("slack:work", { connectionId: "ca_slack" });
    const answer = await handlerFor()(request(body, sign(body)));
    expect(answer.event).toMatchObject({ source: "slack", kind: "trigger", outsider: true });
    expect(answer.event?.id).toBe(`composio:${fixture.headers["webhook-id"]}`);

    const ignored = JSON.stringify({ ...fixture.body, metadata: { ...fixture.body.metadata, connected_account_id: "ca_notion" } });
    store.composio.setAccount("notion:main", { connectionId: "ca_notion" });
    expect(await handlerFor()(request(ignored, sign(ignored)))).toEqual({ status: 200, text: "ignored" });
  });

  it("ignores a trigger the mapper does not map", async () => {
    const handler = composioHandler({ composio, secret: () => SECRET, mappers: { linear: () => undefined }, insertEvent: () => true, now: () => NOW, log: () => {} });
    expect(await handler(request(RAW, sign(RAW)))).toEqual({ status: 200, text: "ignored" });
  });

  it("acknowledges and ignores a delivery of a type it does not use", async () => {
    const body = JSON.stringify({ ...fixture.body, type: "composio.connected_account.activated" });
    expect(await handlerFor()(request(body, sign(body)))).toEqual({ status: 200, text: "ignored" });
  });

  it("hands trigger.disabled and connected_account.expired deliveries to the component and stores no event", async () => {
    const disabled = JSON.stringify({ ...fixture.body, type: "composio.trigger.disabled", metadata: { ...fixture.body.metadata, trigger_id: "ti_9" }, data: { reason: "other" } });
    expect(await handlerFor()(request(disabled, sign(disabled)))).toMatchObject({ status: 200 });
    const expired = JSON.stringify({ ...fixture.body, type: "composio.connected_account.expired", data: {} });
    expect(await handlerFor()(request(expired, sign(expired)))).toMatchObject({ status: 200 });
    expect(lifecycle).toEqual(["disabled ti_9 other", `expired ${fixture.body.metadata.connected_account_id}`]);
    expect(stored).toEqual([]);
  });

  it("answers 200 even when handling a lifecycle delivery fails, so Composio does not keep retrying", async () => {
    composio.connectionExpired = async () => {
      throw new Error("boom");
    };
    const expired = JSON.stringify({ ...fixture.body, type: "composio.connected_account.expired", data: {} });
    expect(await handlerFor()(request(expired, sign(expired)))).toMatchObject({ status: 200 });
  });

  it("counts each delivery against the month's allowance", async () => {
    const meter = new Meter({ store, now: () => NOW, tellHome: async () => {} });
    await handlerFor(SECRET, { meter })(request(RAW, sign(RAW)));
    expect(meter.usage().events.own).toBe(1);
  });
});
