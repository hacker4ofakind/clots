import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { Composio } from "../src/composio/component.js";
import { composioHandler } from "../src/composio/intake.js";
import type { ComposioAccount } from "../src/config.js";
import type { ClotEvent } from "../src/events/types.js";
import type { Incoming } from "../src/intake.js";
import { Supervisor } from "../src/listeners.js";
import { matchesPrefilter, parseRuleFile, Rulebook } from "../src/rulebook.js";
import { genericMapper } from "../src/sources/generic.js";
import { Store } from "../src/store.js";
import { FakeComposioApi } from "./fake-composio.js";

const SECRET = "whsec_test_secret";
const NOW = Date.UTC(2026, 10, 22, 17, 25, 0);
const SLUG = "POSTHOG_EVENT_CAPTURED";
const fixture = JSON.parse(fs.readFileSync("tests/fixtures/composio/slack/01-channel-message.json", "utf8"));

// A generic entry, as the Pi's will be after the change: no saved recipe anywhere.
const posthog: ComposioAccount = { toolkit: "posthog", account: "prod", clot: "truecast", shared: false, audience: "team", apiKey: "phx_x", apiKeyName: "PH_KEY", connect: { subdomain: "eu" }, triggers: [{ slug: SLUG, config: { project_id: 7, event_names: ["user_signed_up"] } }], selfIsUser: false };

const captured = {
  event: { event: "user_signed_up", distinct_id: "user-42", timestamp: "2026-11-22T17:25:00Z", url: "https://eu.posthog.com/project/7/events/abc", properties: { method: "email", $ip: "1.2.3.4", plan: "free" } },
  person: { id: "p-1", name: "Ann", distinct_id: "user-42", url: "https://eu.posthog.com/person/user-42" },
  project: { id: 7, name: "Truecast", url: "https://eu.posthog.com/project/7" },
};

let dir: string;
let rulebook: Rulebook;
let store: Store;
let stored: ClotEvent[];
let handler: ReturnType<typeof composioHandler>;

function sign(raw: string, id: string): Record<string, string> {
  const timestamp = String(Math.floor(NOW / 1000));
  return { "webhook-id": id, "webhook-timestamp": timestamp, "webhook-signature": "v1," + crypto.createHmac("sha256", SECRET).update(`${id}.${timestamp}.${raw}`).digest("base64"), "content-type": "application/json" };
}
const request = (raw: string, headers: Record<string, string>): Incoming => ({ method: "POST", headers, query: new URLSearchParams(), rawBody: Buffer.from(raw) });
const body = (data: unknown, slug = SLUG) => ({ ...fixture.body, metadata: { ...fixture.body.metadata, trigger_slug: slug, toolkit_slug: "posthog", connected_account_id: "ca_ph" }, data });
const deliver = (data: unknown, id = "msg_1", slug = SLUG) => {
  const raw = JSON.stringify(body(data, slug));
  return handler(request(raw, sign(raw, id)));
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "clots-posthog-"));
  rulebook = new Rulebook(dir, ["truecast"], () => undefined);
  rulebook.ensure();
  rulebook.load();
  store = new Store(":memory:");
  stored = [];
  const schedule = () => () => {};
  const composio = new Composio({ api: new FakeComposioApi(), store, accounts: [posthog], publicUrl: "https://x.example", tell: async () => {}, tellHome: async () => {}, now: () => NOW, schedule, supervisor: new Supervisor({ schedule }), log: () => {}, recipe: (t) => rulebook.composioRecipe(t) });
  store.composio.setAccount("posthog:prod", { connectionId: "ca_ph", status: "active" });
  handler = composioHandler({
    composio,
    secret: () => SECRET,
    // No PostHog mapper: it is a generic toolkit, mapped by the recipe the daemon ships.
    mappers: { generic: genericMapper },
    insertEvent: (e) => (stored.some((s) => s.id === e.id) ? false : (stored.push(e), true)),
    now: () => NOW,
    log: () => {},
    recipe: (t) => rulebook.composioRecipe(t),
    keep: (d) => store.composio.keepDelivery(d),
    transaction: (fn) => store.inTransaction(fn),
  });
});

describe("PostHog through the generic path, with no saved recipe", () => {
  it("makes the event the built-in mapper made, with an ID of the same form", async () => {
    expect((await deliver(captured)).status).toBe(202);
    expect(stored).toEqual([
      {
        id: "posthog:prod:user_signed_up:user-42:2026-11-22T17:25:00Z",
        source: "posthog",
        account: "prod",
        kind: "analytics_event",
        place: "Truecast",
        actor: "user-42",
        title: "user_signed_up in PostHog (user-42)",
        body: "PostHog event: user_signed_up\nProject: Truecast\nPerson: Ann\nAt: 2026-11-22T17:25:00Z\nmethod: email\nplan: free",
        url: "https://eu.posthog.com/project/7/events/abc",
        ref: "user_signed_up",
        subject: "posthog:user_signed_up",
        automated: true,
        outsider: true,
        receivedAt: NOW,
      },
    ]);
  });

  it("keeps a delivery repeated with another webhook ID one event, and keeps the payload as a sample", async () => {
    await deliver(captured, "msg_1");
    await deliver(captured, "msg_2");
    expect(stored).toHaveLength(1);
    expect(store.composio.samples("posthog:prod", SLUG).length).toBeGreaterThan(0);
  });

  it("maps only the triggers the recipe lists: another PostHog trigger is a generic event when the entry names it", async () => {
    await deliver({ person: { id: "p-1" } }, "msg_3", "POSTHOG_PERSON_UPDATED");
    expect(stored.map((e) => e.kind)).not.toContain("analytics_event");
  });

  it("is matched by a rule that names the source and kind, and a rule for any kind of source posthog is accepted", async () => {
    await deliver(captured);
    const file = parseRuleFile(["prefilters:", "  - source: posthog", "    kind: analytics_event", "routing:", "  - source: posthog", "    kind: something_new", "    clot: truecast"].join("\n"));
    expect(matchesPrefilter(file.prefilters[0], stored[0])).toBe(true);
    expect(file.routing).toHaveLength(1);
    expect(matchesPrefilter(file.routing[0], stored[0])).toBe(false);
  });

  it("follows a recipe saved in the rulebook for posthog, and the shipped one again when it is gone", async () => {
    const saved = JSON.parse(JSON.stringify(rulebook.composioRecipe("posthog")));
    saved.triggers[SLUG].title = "{payload.event.event} on {payload.event.properties.plan}";
    fs.writeFileSync(rulebook.pathOf("truecast"), stringify({ composio: [saved] }));
    rulebook.load();
    await deliver(captured, "msg_4");
    expect(stored[0].title).toBe("user_signed_up on free");
    fs.writeFileSync(rulebook.pathOf("truecast"), "composio: []\n");
    rulebook.load();
    await deliver({ ...captured, event: { ...captured.event, timestamp: "2026-11-22T18:00:00Z" } }, "msg_5");
    expect(stored[1].title).toBe("user_signed_up in PostHog (user-42)");
  });
});
