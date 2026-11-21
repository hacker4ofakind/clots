import crypto from "node:crypto";
import fs from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { ComposioActions } from "../src/composio/actions.js";
import { Composio } from "../src/composio/component.js";
import { composioHandler } from "../src/composio/intake.js";
import { Meter } from "../src/composio/meter.js";
import { recipeEnricher, recipeMapper, renderRecipe, RecipeReads } from "../src/composio/recipe.js";
import type { ComposioAccount } from "../src/config.js";
import type { ClotEvent } from "../src/events/types.js";
import type { Incoming } from "../src/intake.js";
import { Supervisor } from "../src/listeners.js";
import { parseComposioRecipe, parseRuleFile, type ComposioRecipe } from "../src/rulebook.js";
import { genericMapper } from "../src/sources/generic.js";
import { Store } from "../src/store.js";
import { FakeComposioApi, tool } from "./fake-composio.js";

const SECRET = "whsec_test_secret";
const NOW = Date.UTC(2026, 10, 21, 12, 30, 0);
const fixture = JSON.parse(fs.readFileSync("tests/fixtures/composio/slack/01-channel-message.json", "utf8"));
const RAW: string = fixture.raw;
const payload = fixture.body.data;
const answers = JSON.parse(fs.readFileSync("tests/fixtures/composio/slack/tool-answers.json", "utf8")).answers;

const SLACK_RECIPE = `
composio:
  - toolkit: slack
    identity: { tool: SLACK_TEST_AUTH, path: user_id }
    ownWrites:
      - { tool: SLACK_CHAT_POST_MESSAGE, ids: ["{result.channel}:{result.ts}"] }
    triggers:
      SLACK_CHANNEL_MESSAGE_RECEIVED:
        kind: message
        id: "{payload.channel}:{payload.ts}"
        actorId: "{payload.user}"
        actor: "{enrich.user.user.profile.real_name|enrich.user.user.name}"
        title: "Message in #{enrich.channel.channel.name}"
        body: "{payload.text}"
        ref: "{payload.ts}"
        place: "{payload.channel}"
        subject: "slack:{payload.channel}:{payload.thread_ts|payload.ts}"
        objects: ["{payload.channel}:{payload.ts}"]
        automatedWhen: { payload.subtype: bot_message }
        enrich:
          - { as: channel, tool: SLACK_RETRIEVE_CONVERSATION_INFORMATION, args: { channel: "{payload.channel}" } }
          - { as: user, tool: SLACK_RETRIEVE_DETAILED_USER_INFORMATION, args: { user: "{payload.user}" } }
`;
const recipeFrom = (yaml: string): ComposioRecipe => parseRuleFile(yaml).composio[0];
const recipe = recipeFrom(SLACK_RECIPE);
const edit = (change: (r: any) => void): unknown => {
  const copy = JSON.parse(JSON.stringify(recipe));
  change(copy);
  return copy;
};
const trig = "SLACK_CHANNEL_MESSAGE_RECEIVED";

describe("the Composio recipe schema", () => {
  it("accepts the Slack recipe, and keeps each part", () => {
    expect(recipe.toolkit).toBe("slack");
    expect(recipe.triggers[trig].enrich).toHaveLength(2);
    expect(recipe.identity).toEqual({ tool: "SLACK_TEST_AUTH", path: "user_id" });
  });

  it("refuses a toolkit that has built-in support, and one named like a built-in source", () => {
    expect(() => parseComposioRecipe(edit((r) => (r.toolkit = "linear")))).toThrow("built-in support");
    expect(() => parseComposioRecipe(edit((r) => (r.toolkit = "github")))).toThrow("built-in source");
  });

  it("refuses a fourth read, a repeated name, and a tool of another toolkit", () => {
    const read = (as: string, tool = "SLACK_RETRIEVE_CONVERSATION_INFORMATION") => ({ as, tool, args: {} });
    expect(() => parseComposioRecipe(edit((r) => (r.triggers[trig].enrich = [read("a"), read("b"), read("c"), read("d")])))).toThrow("at most 3 reads");
    expect(() => parseComposioRecipe(edit((r) => (r.triggers[trig].enrich = [read("a"), read("a")])))).toThrow("two reads of SLACK_CHANNEL_MESSAGE_RECEIVED are both named a");
    expect(() => parseComposioRecipe(edit((r) => (r.triggers[trig].enrich = [read("a", "GITHUB_GET_REPO")])))).toThrow("GITHUB_GET_REPO is not a tool of slack");
    expect(() => parseComposioRecipe(edit((r) => (r.identity.tool = "GITHUB_GET_ME")))).toThrow("is not a tool of slack");
    expect(() => parseComposioRecipe(edit((r) => (r.ownWrites[0].tool = "GITHUB_X")))).toThrow("is not a tool of slack");
  });

  it("refuses a recipe with no trigger, and a trigger of another toolkit", () => {
    expect(() => parseComposioRecipe(edit((r) => (r.triggers = {})))).toThrow("at least one trigger");
    expect(() => parseComposioRecipe(edit((r) => (r.triggers = { GITHUB_PUSH: r.triggers[trig] })))).toThrow("not slack's");
  });

  it("refuses enrich in a field the enrichment step does not keep, naming the field", () => {
    expect(() => parseComposioRecipe(edit((r) => (r.triggers[trig].url = "{enrich.channel.channel.name}")))).toThrow("url cannot use enrich: only title, actor and body");
    expect(() => parseComposioRecipe(edit((r) => (r.triggers[trig].id = "{enrich.channel.channel.id}")))).toThrow("id cannot use enrich");
    expect(() => parseComposioRecipe(edit((r) => (r.triggers[trig].objects = ["{enrich.channel.channel.id}"])))).toThrow("cannot use enrich");
  });

  it("refuses a template that reads anything but payload and the reads before it", () => {
    expect(() => parseComposioRecipe(edit((r) => (r.triggers[trig].title = "{secrets.token}")))).toThrow("out of reach");
    expect(() => parseComposioRecipe(edit((r) => (r.triggers[trig].title = "{enrich.nobody.x}")))).toThrow("names no read");
    // The first read cannot use the second's data; the second may use the first's.
    expect(() => parseComposioRecipe(edit((r) => (r.triggers[trig].enrich[0].args = { x: "{enrich.user.user.id}" })))).toThrow("no read comes before it");
    expect(parseComposioRecipe(edit((r) => (r.triggers[trig].enrich[1].args = { x: "{enrich.channel.channel.id}" }))).toolkit).toBe("slack");
    expect(() => parseComposioRecipe(edit((r) => (r.triggers[trig].automatedWhen = { "enrich.channel": "x" })))).toThrow("out of reach");
  });

  it("reads a recipe from a rule file's composio list, and reports a second recipe for one toolkit", () => {
    expect(parseRuleFile(SLACK_RECIPE).composio).toHaveLength(1);
    expect(() => parseRuleFile("composio:\n  - toolkit: slack\n    triggers: {}")).toThrow();
  });
});

describe("renderRecipe", () => {
  const account = { toolkit: "slack", account: "work" };
  const read = { channel: answers.SLACK_RETRIEVE_CONVERSATION_INFORMATION, user: answers.SLACK_RETRIEVE_DETAILED_USER_INFORMATION };

  it("makes the event from the payload and the reads' data", () => {
    const { event, actorId, objectIds } = renderRecipe(recipe, trig, account, payload, read, "msg_1", NOW);
    expect(event).toMatchObject({
      id: "slack:work:C0TESTCHAN1:1795263981.000100",
      source: "slack",
      account: "work",
      kind: "message",
      title: "Message in #general-test",
      actor: "Ada Tester",
      body: "Hello team",
      ref: "1795263981.000100",
      place: "C0TESTCHAN1",
      subject: "slack:C0TESTCHAN1:1795263981.000100",
      automated: false,
      outsider: true,
      receivedAt: NOW,
    });
    expect(actorId).toBe("U0TESTUSER1");
    expect(objectIds).toEqual(["C0TESTCHAN1:1795263981.000100"]);
  });

  it("takes the thread's start for the subject when there is one, and the first present of {a|b}", () => {
    const { event } = renderRecipe(recipe, trig, account, { ...payload, thread_ts: "1.0" }, read, "m", NOW);
    expect(event.subject).toBe("slack:C0TESTCHAN1:1.0");
  });

  it("falls back as the generic mapping does: the delivery for an ID, unknown, the payload, the toolkit and trigger, the account", () => {
    const bare = parseComposioRecipe({ toolkit: "slack", triggers: { [trig]: { kind: "message", title: "{payload.nothing}" } } });
    const { event, actorId, objectIds } = renderRecipe(bare, trig, account, payload, {}, "msg_9", NOW);
    expect(event).toMatchObject({ id: "composio:msg_9", actor: "unknown", subject: `slack:${trig}`, title: "Channel message received", url: "", ref: "", place: "work" });
    expect(event.body).toContain('"text": "Hello team"');
    expect(actorId).toBe("");
    expect(objectIds).toEqual([]);
  });

  it("fills a key empty when any path in it is missing, so no partial key is made", () => {
    const { event, objectIds } = renderRecipe(recipe, trig, account, { channel: "C1", user: "U1" }, read, "msg_2", NOW);
    expect(event.id).toBe("composio:msg_2");
    expect(objectIds).toEqual([]);
  });

  it("makes an event automated when the payload says so", () => {
    expect(renderRecipe(recipe, trig, account, { ...payload, subtype: "bot_message" }, read, "m", NOW).event.automated).toBe(true);
  });

  it("leaves the text that needs a read provisional when none has run", () => {
    const { event } = renderRecipe(recipe, trig, account, payload, {}, "m", NOW);
    expect(event).toMatchObject({ title: "Message in #", actor: "unknown" });
  });

  it("recipeMapper maps a trigger the recipe lists, and leaves another to the generic mapping", () => {
    const mapper = recipeMapper(recipe);
    expect(mapper({ toolkit: "slack", account: "work" } as ComposioAccount, trig, payload, "w", NOW)?.event.kind).toBe("message");
    expect(mapper({ toolkit: "slack", account: "work" } as ComposioAccount, "SLACK_CHANNEL_CREATED", {}, "w", NOW)).toBeUndefined();
  });
});

// ---- intake and the enrichment step, over a fake Composio ----

const base = { shared: true, audience: "team" as const, triggers: [{ slug: trig, config: {} }], selfIsUser: false };
const slack: ComposioAccount = { ...base, toolkit: "slack", account: "work" };

let api: FakeComposioApi;
let store: Store;
let composio: Composio;
let stored: ClotEvent[];
let meter: Meter;
let inForce: ComposioRecipe | undefined;
let clock: number;
let dropped: (string | undefined)[];

const timers: (() => void)[] = [];
const schedule = (_ms: number, fn: () => void) => {
  timers.push(fn);
  return () => {};
};

function sign(raw: string, id = fixture.headers["webhook-id"]): Record<string, string> {
  const timestamp = String(Math.floor(clock / 1000));
  return { "webhook-id": id, "webhook-timestamp": timestamp, "webhook-signature": "v1," + crypto.createHmac("sha256", SECRET).update(`${id}.${timestamp}.${raw}`).digest("base64"), "content-type": "application/json" };
}
const request = (raw: string, headers: Record<string, string>): Incoming => ({ method: "POST", headers, query: new URLSearchParams(), rawBody: Buffer.from(raw) });
const deliver = (body: unknown, id = "msg_1") => {
  const raw = JSON.stringify(body);
  return handler(request(raw, sign(raw, id)));
};
const slackBody = (data: unknown = payload, slug = trig) => ({ ...fixture.body, metadata: { ...fixture.body.metadata, trigger_slug: slug, connected_account_id: "ca_slack" }, data });
let handler: ReturnType<typeof composioHandler>;

function wire() {
  composio = new Composio({ api, store, accounts: [slack], publicUrl: "https://x.example", tell: async () => {}, tellHome: async () => {}, now: () => clock, schedule, supervisor: new Supervisor({ schedule }), log: () => {}, meter, recipe: () => inForce });
  store.composio.setAccount("slack:work", { connectionId: "ca_slack", status: "active" });
  handler = composioHandler({
    composio,
    secret: () => SECRET,
    mappers: { generic: genericMapper },
    insertEvent: (e) => (stored.some((s) => s.id === e.id) ? false : (stored.push(e), true)),
    now: () => clock,
    log: () => {},
    meter,
    recipe: () => inForce,
    keep: (d) => store.composio.keepDelivery(d),
    transaction: (fn) => store.inTransaction(fn),
  });
}

const enricher = () => {
  const reads = new RecipeReads({ composio, used: (m) => meter.used(m), cached: (a, t, h, n) => store.composio.cachedRead(a, t, h, n), keep: (a, t, h, d, n) => store.composio.keepRead(a, t, h, d, n), now: () => clock });
  return recipeEnricher({ reads, composio, recipe: () => inForce, delivery: (id) => store.composio.deliveryByEvent(id) });
};
const executions = () => api.of("execute").map((c) => c.replace(/^execute:\S+ /, ""));

beforeEach(() => {
  api = new FakeComposioApi();
  store = new Store(":memory:");
  stored = [];
  dropped = [];
  clock = NOW;
  inForce = recipe;
  meter = new Meter({ store, now: () => clock, tellHome: async () => {} });
  api.tools.set("SLACK_RETRIEVE_CONVERSATION_INFORMATION", tool("SLACK_RETRIEVE_CONVERSATION_INFORMATION", ["readOnlyHint"]));
  api.tools.set("SLACK_RETRIEVE_DETAILED_USER_INFORMATION", tool("SLACK_RETRIEVE_DETAILED_USER_INFORMATION", ["readOnlyHint"]));
  api.tools.set("SLACK_TEST_AUTH", tool("SLACK_TEST_AUTH", ["readOnlyHint"]));
  api.tools.set("SLACK_CHAT_POST_MESSAGE", tool("SLACK_CHAT_POST_MESSAGE", ["createHint"]));
  api.answers.set("SLACK_RETRIEVE_CONVERSATION_INFORMATION", { ok: true, data: answers.SLACK_RETRIEVE_CONVERSATION_INFORMATION });
  api.answers.set("SLACK_RETRIEVE_DETAILED_USER_INFORMATION", { ok: true, data: answers.SLACK_RETRIEVE_DETAILED_USER_INFORMATION });
  api.answers.set("SLACK_TEST_AUTH", { ok: true, data: answers.SLACK_TEST_AUTH });
  wire();
});

describe("the Slack delivery through intake and the enricher", () => {
  it("is stored as slack:work:<channel>:<ts>, kind message, from an outsider, with its names still to come", async () => {
    const answer = await deliver(slackBody());
    expect(answer.status).toBe(202);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ id: "slack:work:C0TESTCHAN1:1795263981.000100", source: "slack", kind: "message", outsider: true, body: "Hello team" });
    // Intake never waits on a read.
    expect(executions()).toEqual([]);
  });

  it("is enriched before routing: the title and actor come from the reads, and the other fields stay", async () => {
    await deliver(slackBody());
    const enriched = await enricher()(stored[0]);
    expect(enriched).toMatchObject({ title: "Message in #general-test", actor: "Ada Tester", body: "Hello team", id: stored[0].id, kind: "message", place: "C0TESTCHAN1" });
    expect(executions()).toEqual(['SLACK_RETRIEVE_CONVERSATION_INFORMATION {"channel":"C0TESTCHAN1"}', 'SLACK_RETRIEVE_DETAILED_USER_INFORMATION {"user":"U0TESTUSER1"}']);
  });

  it("leaves a line for a failed read, goes on, and leaves that read's data empty", async () => {
    api.answers.set("SLACK_RETRIEVE_DETAILED_USER_INFORMATION", { ok: false, error: "user_not_found", reason: "refused" });
    await deliver(slackBody());
    const enriched = await enricher()(stored[0]);
    expect(enriched.title).toBe("Message in #general-test");
    expect(enriched.actor).toBe("unknown");
    expect(enriched.body).toContain("Could not read user: user_not_found.");
  });

  it("never calls a write tool named in a recipe set by hand, and says so", async () => {
    inForce = edit((r) => (r.triggers[trig].enrich[1].tool = "SLACK_CHAT_POST_MESSAGE")) as ComposioRecipe;
    await deliver(slackBody());
    const enriched = await enricher()(stored[0]);
    expect(executions().join()).not.toContain("SLACK_CHAT_POST_MESSAGE");
    expect(enriched.body).toContain("Could not read user: SLACK_CHAT_POST_MESSAGE is not a read tool.");
  });

  it("does not read a tool that is not the toolkit's, nor one Composio does not know", async () => {
    inForce = edit((r) => (r.triggers[trig].enrich = [{ as: "x", tool: "SLACK_NO_SUCH_TOOL", args: {} }])) as ComposioRecipe;
    await deliver(slackBody());
    expect((await enricher()(stored[0])).body).toContain("Could not read x: SLACK_NO_SUCH_TOOL is not a read tool.");
  });

  it("returns an event with no recipe, or no kept delivery, unchanged", async () => {
    await deliver(slackBody());
    inForce = undefined;
    expect(await enricher()(stored[0])).toBe(stored[0]);
    inForce = recipe;
    const other: ClotEvent = { ...stored[0], id: "slack:work:never-kept" };
    expect(await enricher()(other)).toBe(other);
  });

  it("does not enrich a payload that was clipped, and says so", async () => {
    await deliver(slackBody({ ...payload, text: "x".repeat(70_000) }));
    const enriched = await enricher()(stored[0]);
    expect(executions()).toEqual([]);
    expect(enriched.body).toContain("too large to read in full");
  });

  it("maps a trigger the recipe does not list generically, and a recipe with no id by the delivery's", async () => {
    await deliver(slackBody({ channel: "C9" }, "SLACK_CHANNEL_CREATED"), "msg_gen");
    expect(stored[0]).toMatchObject({ id: "composio:msg_gen", kind: "trigger", source: "slack" });
    inForce = parseComposioRecipe({ toolkit: "slack", triggers: { [trig]: { kind: "message", title: "x" } } });
    await deliver(slackBody(), "msg_noid");
    expect(stored[1].id).toBe("composio:msg_noid");
  });

  it("makes the generic event when no recipe is in force at all", async () => {
    inForce = undefined;
    await deliver(slackBody());
    expect(stored[0].kind).toBe("trigger");
  });
});

describe("the self-caused drop through identity and actorId", () => {
  it("drops an event whose actor is the connection's identity, learned through the recipe's tool", async () => {
    api.answers.set("SLACK_TEST_AUTH", { ok: true, data: { user_id: "U0TESTUSER1" } });
    await composio.recipeChanged("slack");
    store.composio.setAccount("slack:work", { identity: "U0TESTUSER1" });
    const answer = await deliver(slackBody());
    expect(answer).toMatchObject({ status: 202, dropped: "caused by the Clot itself" });
  });

  it("does not drop the user's own message for a selfIsUser account", async () => {
    const own: ComposioAccount = { ...slack, selfIsUser: true };
    composio = new Composio({ api, store, accounts: [own], publicUrl: "https://x.example", tell: async () => {}, tellHome: async () => {}, now: () => clock, schedule, supervisor: new Supervisor({ schedule }), log: () => {}, meter, recipe: () => inForce });
    handler = composioHandler({ composio, secret: () => SECRET, mappers: { generic: genericMapper }, insertEvent: (e) => (stored.push(e), true), now: () => clock, log: () => {}, recipe: () => inForce });
    store.composio.setAccount("slack:work", { identity: "U0TESTUSER1" });
    const answer = await deliver(slackBody());
    expect(answer.status).toBe(202);
    expect((answer as { dropped?: string }).dropped).toBeUndefined();
  });

  it("learns the identity through the recipe: the tool's data at the path, only for a read tool, and not at all without one", async () => {
    store.composio.setAccount("slack:work", { identity: undefined });
    const { genericDef } = await import("../src/composio/toolkits/generic.js");
    expect(await genericDef.identity!(slack, composio)).toBe("U0TESTUSER1");
    inForce = parseComposioRecipe({ toolkit: "slack", triggers: { [trig]: { kind: "message", title: "x" } } });
    expect(await genericDef.identity!(slack, composio)).toBeUndefined();
    inForce = edit((r) => (r.identity.tool = "SLACK_CHAT_POST_MESSAGE")) as ComposioRecipe;
    await expect(genericDef.identity!(slack, composio)).rejects.toThrow("is not a read tool");
    inForce = edit((r) => (r.identity.path = "nothing")) as ComposioRecipe;
    await expect(genericDef.identity!(slack, composio)).rejects.toThrow("answered no nothing");
  });

  it("clears and learns again when a recipe's identity changes, and not when it does not", async () => {
    store.composio.setAccount("slack:work", { connectionId: "ca_slack", status: "active", identity: "U-old" });
    composio.recipeChanged("slack");
    expect(store.composio.account("slack:work")!.identity).toBe("U-old");
    composio.recipeChanged("slack");
    expect(store.composio.account("slack:work")!.identity).toBe("U-old");
    inForce = edit((r) => (r.identity.path = "team_id")) as ComposioRecipe;
    composio.recipeChanged("slack");
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(store.composio.account("slack:work")!.identity).toBe("T0TESTTEAM1");
  });
});

describe("the read cache, in-flight sharing and the budget", () => {
  const second = { ...payload, ts: "1795263999.000200" };

  it("makes one user read for two messages from one user in one channel within a day", async () => {
    await deliver(slackBody(), "m1");
    await deliver(slackBody(second), "m2");
    const e = enricher();
    await e(stored[0]);
    await e(stored[1]);
    expect(executions().filter((x) => x.startsWith("SLACK_RETRIEVE_DETAILED_USER_INFORMATION"))).toHaveLength(1);
    expect(executions().filter((x) => x.startsWith("SLACK_RETRIEVE_CONVERSATION_INFORMATION"))).toHaveLength(1);
  });

  it("reads again after a day", async () => {
    await deliver(slackBody(), "m1");
    await deliver(slackBody(second), "m2");
    const e = enricher();
    await e(stored[0]);
    clock += 24 * 3_600_000 + 1;
    await e(stored[1]);
    expect(executions().filter((x) => x.startsWith("SLACK_RETRIEVE_DETAILED_USER_INFORMATION"))).toHaveLength(2);
  });

  it("shares one call between two that arrive together", async () => {
    await deliver(slackBody(), "m1");
    await deliver(slackBody(second), "m2");
    const e = enricher();
    await Promise.all([e(stored[0]), e(stored[1])]);
    expect(executions().filter((x) => x.startsWith("SLACK_RETRIEVE_DETAILED_USER_INFORMATION"))).toHaveLength(1);
  });

  it("makes no read and says so when the account's pool is 80% used", async () => {
    // The account is managed (no key, no OAuth app of its own): 20,000 managed calls a month, 80% is 16,000.
    await meter.count("call", "slack:work", true, 16_000);
    await deliver(slackBody());
    const enriched = await enricher()(stored[0]);
    expect(executions()).toEqual([]);
    expect(enriched.body).toContain("Skipped reading channel: Composio's monthly allowance is 80% used.");
    expect(enriched.body).toContain("Skipped reading user: Composio's monthly allowance is 80% used.");
  });

  it("counts the events allowance too, and keeps the event going either way", async () => {
    await meter.count("delivery", "slack:work", true, 8_000);
    await deliver(slackBody());
    expect((await enricher()(stored[0])).body).toContain("Skipped reading channel");
  });

  it("scopes a cached read to the connection: after a reconnect the old user's data is not reused", async () => {
    await deliver(slackBody(), "m1");
    await deliver(slackBody(second), "m2");
    const e = enricher();
    await e(stored[0]);
    const before = executions().length;
    store.composio.setAccount("slack:work", { connectionId: "ca_slack_new" });
    await e(stored[1]);
    expect(executions().length - before).toBe(2);
  });

  it("does not let a read still in flight for the old connection fill the new connection's cache", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    api.answers.set("SLACK_RETRIEVE_CONVERSATION_INFORMATION", () => ({ ok: true, data: answers.SLACK_RETRIEVE_CONVERSATION_INFORMATION }));
    const run = composio.run.bind(composio);
    composio.run = async (a, slug, args) => {
      if (slug === "SLACK_RETRIEVE_CONVERSATION_INFORMATION") await gate;
      return run(a, slug, args);
    };
    await deliver(slackBody(), "m1");
    await deliver(slackBody(second), "m2");
    const pending = enricher()(stored[0]);
    for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
    store.composio.setAccount("slack:work", { connectionId: "ca_slack_new" });
    release();
    await pending;
    expect(store.composio.cachedRead("slack:work#ca_slack_new", "SLACK_RETRIEVE_CONVERSATION_INFORMATION", "x", NOW)).toBeUndefined();
    const calls = executions().filter((c) => c.startsWith("SLACK_RETRIEVE_CONVERSATION_INFORMATION")).length;
    composio.run = run;
    await enricher()(stored[1]);
    expect(executions().filter((c) => c.startsWith("SLACK_RETRIEVE_CONVERSATION_INFORMATION")).length).toBe(calls + 1);
  });

  it("serves a cached read even when the allowance is nearly used", async () => {
    await deliver(slackBody(), "m1");
    await deliver(slackBody(second), "m2");
    const e = enricher();
    await e(stored[0]);
    await meter.count("call", "slack:work", true, 16_000);
    const calls = executions().length;
    const enriched = await e(stored[1]);
    expect(executions().length).toBe(calls);
    expect(enriched.actor).toBe("Ada Tester");
  });
});

describe("ownWrites", () => {
  it("records the post's channel and ts as touched, and drops the delivery of that post as self-caused even with selfIsUser", async () => {
    const own: ComposioAccount = { ...slack, selfIsUser: true };
    composio = new Composio({ api, store, accounts: [own], publicUrl: "https://x.example", tell: async () => {}, tellHome: async () => {}, now: () => clock, schedule, supervisor: new Supervisor({ schedule }), log: () => {}, meter, recipe: () => inForce });
    store.composio.setAccount("slack:work", { connectionId: "ca_slack", status: "active" });
    const actions = new ComposioActions({ composio, store, reviewer: { review: async () => ({ verdict: "run", reason: "" }) }, ask: async () => "", say: async () => {}, now: () => clock });
    api.answers.set("SLACK_CHAT_POST_MESSAGE", { ok: true, data: { ok: true, channel: "C0TESTCHAN1", ts: "1795263981.000100" } });
    const done = await actions.executeWrite({ clot: "home", account: own, tool: (await composio.tool("SLACK_CHAT_POST_MESSAGE"))!, args: { channel: "C0TESTCHAN1", text: "composio check" }, reviewed: false });
    expect(done.ok).toBe(true);
    const row = store.composio.latestUndoable("home");
    expect(row).toBeUndefined();
    expect(store.composio.touchedSince("slack:work", "C0TESTCHAN1:1795263981.000100", clock - 1000)).toBe(true);
    handler = composioHandler({ composio, secret: () => SECRET, mappers: { generic: genericMapper }, insertEvent: (e) => (stored.push(e), true), now: () => clock, log: () => {}, recipe: () => inForce });
    const answer = await deliver(slackBody());
    expect(answer).toMatchObject({ status: 202, dropped: "caused by the Clot itself" });
  });

  it("records nothing extra for an ids template that fills empty", async () => {
    const own: ComposioAccount = { ...slack, selfIsUser: true };
    composio = new Composio({ api, store, accounts: [own], publicUrl: "https://x.example", tell: async () => {}, tellHome: async () => {}, now: () => clock, schedule, supervisor: new Supervisor({ schedule }), log: () => {}, meter, recipe: () => inForce });
    const actions = new ComposioActions({ composio, store, reviewer: { review: async () => ({ verdict: "run", reason: "" }) }, ask: async () => "", say: async () => {}, now: () => clock });
    api.answers.set("SLACK_CHAT_POST_MESSAGE", { ok: true, data: { ok: true, channel: "C1" } });
    await actions.executeWrite({ clot: "home", account: own, tool: (await composio.tool("SLACK_CHAT_POST_MESSAGE"))!, args: {}, reviewed: false });
    expect(store.composio.touchedSince("slack:work", "C1:", clock - 1000)).toBe(false);
    expect(store.composio.touchedSince("slack:work", "C1", clock - 1000)).toBe(false);
  });
});
