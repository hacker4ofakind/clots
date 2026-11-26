import { describe, expect, it } from "vitest";
import { announceSkipped, skippedEntryNote } from "../src/skipped-notice.js";

const memory = () => {
  const m = new Map<string, string>();
  return { getState: (k: string) => m.get(k), setState: (k: string, v: string) => void m.set(k, v) };
};
const bad = { entry: "posthog:encryptify", problem: "sources.composio[2].apiKey: POSTHOG_ENCRYPTIFY_KEY is not set in .env" };

describe("the notice about an entry the loader left out", () => {
  it("is told once per problem, not again after a restart, and again when the problem changes or comes back", async () => {
    const state = memory();
    const told: string[] = [];
    const tell = async (t: string) => void told.push(t);
    await announceSkipped(state, [bad], tell);
    await announceSkipped(state, [bad], tell); // the next daemon start
    expect(told).toHaveLength(1);
    await announceSkipped(state, [{ ...bad, problem: "sources.composio[2].audience: Invalid option" }], tell);
    expect(told).toHaveLength(2);
    await announceSkipped(state, [], tell); // fixed or removed
    await announceSkipped(state, [bad], tell); // broken again
    expect(told).toHaveLength(3);
  });

  it("is told again at the next start when it could not be posted", async () => {
    const state = memory();
    const told: string[] = [];
    await announceSkipped(state, [bad], async () => {
      throw new Error("no chat yet");
    });
    await announceSkipped(state, [bad], async (t) => void told.push(t));
    expect(told).toHaveLength(1);
  });

  it("says in plain words what is wrong and what to do", () => {
    const note = skippedEntryNote(bad);
    expect(note).toContain("posthog:encryptify");
    expect(note).toContain("POSTHOG_ENCRYPTIFY_KEY is missing from .env");
    expect(note).not.toContain("sources.composio[");
    expect(note).not.toContain("—");
  });
});
