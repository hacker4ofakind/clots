import { beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({ active: 0, peak: 0, started: 0, release: [] as (() => void)[], fail: false }));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: () =>
    (async function* () {
      sdk.started++;
      sdk.active++;
      sdk.peak = Math.max(sdk.peak, sdk.active);
      try {
        await new Promise<void>((resolve) => sdk.release.push(resolve));
        if (sdk.fail) throw new Error("boom");
        yield { type: "result", subtype: "success", structured_output: { ok: true } };
      } finally {
        sdk.active--;
      }
    })(),
}));

import { MAX_CONCURRENT_CALLS, structuredQuery } from "../src/structured-query.js";

const call = { prompt: "p", model: "m", effort: "low" as const, systemPrompt: "s", schema: {} };
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  Object.assign(sdk, { active: 0, peak: 0, started: 0, release: [], fail: false });
});

describe("structuredQuery concurrency", () => {
  it("runs at most the limit at once and queues the rest", async () => {
    const calls = Array.from({ length: MAX_CONCURRENT_CALLS + 3 }, () => structuredQuery(call));
    await tick();
    expect(sdk.started).toBe(MAX_CONCURRENT_CALLS);

    sdk.release.shift()!();
    await tick();
    expect(sdk.started).toBe(MAX_CONCURRENT_CALLS + 1);

    while (sdk.release.length > 0 || sdk.started < MAX_CONCURRENT_CALLS + 3) {
      sdk.release.shift()?.();
      await tick();
    }
    const answers = await Promise.all(calls);
    expect(answers.every((a) => (a.output as { ok: boolean }).ok)).toBe(true);
    expect(sdk.peak).toBe(MAX_CONCURRENT_CALLS);
  });

  it("frees the slot when a call fails", async () => {
    sdk.fail = true;
    const calls = Array.from({ length: MAX_CONCURRENT_CALLS + 1 }, () => structuredQuery(call));
    await tick();
    while (sdk.release.length > 0 || sdk.started < MAX_CONCURRENT_CALLS + 1) {
      sdk.release.shift()?.();
      await tick();
    }
    expect(await Promise.all(calls)).toEqual(calls.map(() => ({})));
    expect(sdk.started).toBe(MAX_CONCURRENT_CALLS + 1);
  });
});
