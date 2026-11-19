import { beforeEach, describe, expect, it, vi } from "vitest";

const answer = vi.hoisted(() => ({ messages: [] as unknown[], fail: false }));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: () =>
    (async function* () {
      if (answer.fail) throw new Error("boom");
      for (const message of answer.messages) yield message;
    })(),
}));

import { SdkRouter } from "../src/router.js";
import { SdkRoutingCall } from "../src/routing-call.js";
import { SdkTriage } from "../src/triage.js";
import type { ClotEvent } from "../src/events/types.js";

const event: ClotEvent = { id: "e1", source: "github", kind: "issue_opened", account: "github", place: "o/r", actor: "a", title: "T", body: "b", url: "", ref: "1", subject: "", automated: false, outsider: false, receivedAt: 0 };
const result = (output: unknown, cost?: number, subtype = "success") => [{ type: "result", subtype, structured_output: output, ...(cost === undefined ? {} : { total_cost_usd: cost }) }];

beforeEach(() => {
  answer.fail = false;
  answer.messages = [];
});

describe("the cost of the small calls", () => {
  it("is reported by triage with the Clot it is for", async () => {
    answer.messages = result({ needsAction: true, message: "m", urgent: false, suspicious: false }, 0.004);
    const costs: [number, string | null][] = [];
    const verdict = await new SdkTriage({ onCost: (usd, clot) => void costs.push([usd, clot]) }).judge({ clot: "graphite", event, guidance: "" });
    expect(verdict.message).toBe("m");
    expect(costs).toEqual([[0.004, "graphite"]]);
  });

  it("is reported by the router with the Clot it is for", async () => {
    answer.messages = result({ effort: "medium" }, 0.002);
    const costs: [number, string | null][] = [];
    expect(await new SdkRouter({ onCost: (usd, clot) => void costs.push([usd, clot]) }).decide({ clot: "graphite", text: "x", tail: [] })).toEqual({ effort: "medium" });
    expect(costs).toEqual([[0.002, "graphite"]]);
  });

  it("is reported by the routing call as the daemon's", async () => {
    answer.messages = result({ clot: "graphite", confident: true }, 0.003);
    const costs: [number, string | null][] = [];
    const got = await new SdkRoutingCall({ onCost: (usd, clot) => void costs.push([usd, clot]) }).decide({ event, guidance: "", clots: [{ name: "graphite", about: "a" }] });
    expect(got).toEqual({ clot: "graphite", confident: true });
    expect(costs).toEqual([[0.003, null]]);
  });

  it("is reported even when the answer did not fit, and not at all when the call failed before a result", async () => {
    const costs: number[] = [];
    const router = new SdkRouter({ onCost: (usd) => void costs.push(usd) });
    answer.messages = result(undefined, 0.001, "error_max_structured_output_retries");
    expect(await router.decide({ text: "x", tail: [] })).toEqual({ effort: "medium" });
    expect(costs).toEqual([0.001]);
    answer.fail = true;
    expect(await router.decide({ text: "x", tail: [] })).toEqual({ effort: "medium" });
    expect(costs).toEqual([0.001]);
  });

  it("still gives the default when nobody listens", async () => {
    answer.messages = [];
    expect(await new SdkTriage().judge({ event, guidance: "" })).toMatchObject({ needsAction: true, message: "T" });
  });
});
