import { describe, expect, it } from "vitest";
import type { ComposioAccount } from "../src/config.js";
import { genericMapper } from "../src/sources/generic.js";

const NOW = 1_760_000_000_000;

describe("genericMapper", () => {
  const slack: ComposioAccount = { toolkit: "slack", account: "work", shared: true, audience: "team", apiKey: "k", apiKeyName: "K", triggers: [{ slug: "SLACK_RECEIVE_MESSAGE", config: {} }], selfIsUser: false };

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
