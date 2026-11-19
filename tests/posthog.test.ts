import { describe, expect, it } from "vitest";
import type { ComposioAccount } from "../src/config.js";
import { genericMapper } from "../src/sources/generic.js";
import { posthogMapper } from "../src/sources/posthog.js";

const NOW = 1_760_000_000_000;
const posthog: ComposioAccount = { toolkit: "posthog", account: "app", clot: "app", shared: false, audience: "public", apiKey: "k", apiKeyName: "K", triggers: [], region: "us", projectId: 7, events: ["signup"] };

// The shape of Composio's PostHog trigger, per its published payload schema.
const captured = {
  event: { event: "signup", distinct_id: "user-42", timestamp: "2026-11-19T10:00:00Z", captured_at: "2026-11-19T10:00:01Z", url: "https://us.posthog.com/project/7/events/abc", properties: { plan: "pro", $ip: "1.2.3.4", nested: { a: 1 }, seats: 3 } },
  person: { id: "p-1", name: "Ann", distinct_id: "user-42", url: "https://us.posthog.com/person/user-42", properties: {} },
  project: { id: 7, name: "Truecast (Dev)", url: "https://us.posthog.com/project/7" },
};

describe("posthogMapper", () => {
  it("turns an event into an automated analytics_event in its project, about the event's name", () => {
    expect(posthogMapper(posthog, "POSTHOG_EVENT_CAPTURED", captured, "msg_1", NOW)).toEqual({
      actorId: "",
      event: {
        id: "posthog:app:signup:user-42:2026-11-19T10:00:00Z",
        source: "posthog",
        account: "app",
        kind: "analytics_event",
        place: "Truecast (Dev)",
        actor: "user-42",
        title: "signup in PostHog (user-42)",
        body: "PostHog event: signup\nProject: Truecast (Dev)\nPerson: Ann\nAt: 2026-11-19T10:00:00Z\nplan: pro\nseats: 3",
        url: "https://us.posthog.com/project/7/events/abc",
        ref: "signup",
        subject: "posthog:signup",
        automated: true,
        outsider: true,
        receivedAt: NOW,
      },
    });
  });

  it("keeps a repeat of the same event one event, and never leaves the place empty", () => {
    const again = posthogMapper(posthog, "POSTHOG_EVENT_CAPTURED", captured, "msg_2", NOW + 1)!;
    expect(again.event.id).toBe(posthogMapper(posthog, "POSTHOG_EVENT_CAPTURED", captured, "msg_1", NOW)!.event.id);
    expect(posthogMapper(posthog, "POSTHOG_EVENT_CAPTURED", { ...captured, project: undefined }, "m", NOW)!.event.place).toBe("app");
  });

  it("ignores another trigger and a payload that names no event", () => {
    expect(posthogMapper(posthog, "POSTHOG_PERSON_UPDATED", captured, "m", NOW)).toBeUndefined();
    expect(posthogMapper(posthog, "POSTHOG_EVENT_CAPTURED", { event: {} }, "m", NOW)).toBeUndefined();
    expect(posthogMapper(posthog, "POSTHOG_EVENT_CAPTURED", "junk", "m", NOW)).toBeUndefined();
  });
});

describe("genericMapper", () => {
  const slack: ComposioAccount = { toolkit: "slack", account: "work", shared: true, audience: "team", apiKey: "k", apiKeyName: "K", triggers: [{ slug: "SLACK_RECEIVE_MESSAGE", config: {} }] };

  it("makes a trigger event of the toolkit's source, from an outsider, keyed on the delivery", () => {
    const mapped = genericMapper(slack, "SLACK_RECEIVE_MESSAGE", { text: "hello", user: "U1" }, "msg_9", NOW)!;
    expect(mapped.actorId).toBe("");
    expect(mapped.event).toMatchObject({ id: "composio:msg_9", source: "slack", account: "work", kind: "trigger", place: "work", title: "Receive message", subject: "slack:SLACK_RECEIVE_MESSAGE", ref: "SLACK_RECEIVE_MESSAGE", automated: false, outsider: true, receivedAt: NOW });
    expect(JSON.parse(mapped.event.body)).toEqual({ text: "hello", user: "U1" });
  });

  it("clips a long payload and ignores a delivery with no trigger", () => {
    expect(genericMapper(slack, "SLACK_X", { text: "x".repeat(50_000) }, "m", NOW)!.event.body.length).toBeLessThan(10_000);
    expect(genericMapper(slack, "", {}, "m", NOW)).toBeUndefined();
  });
});
