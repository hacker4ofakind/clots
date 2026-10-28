import { describe, expect, it } from "vitest";
import { buildRouterPrompt, parseDecision } from "../src/router.js";

describe("parseDecision", () => {
  it("accepts low and medium", () => {
    expect(parseDecision({ effort: "low" })).toEqual({ effort: "low" });
    expect(parseDecision({ effort: "medium" })).toEqual({ effort: "medium" });
  });

  it("falls back to low for anything else, high included", () => {
    expect(parseDecision(undefined)).toEqual({ effort: "low" });
    expect(parseDecision({ effort: "high" })).toEqual({ effort: "low" });
    expect(parseDecision({ effort: "max" })).toEqual({ effort: "low" });
  });
});

describe("buildRouterPrompt", () => {
  it("includes the recent messages and the new message", () => {
    const prompt = buildRouterPrompt({ text: "yeah sure", tail: [{ role: "clot", text: "Should I build the page?" }] });
    expect(prompt).toContain("clot: Should I build the page?");
    expect(prompt).toContain("<new_message>\nyeah sure\n</new_message>");
    expect(prompt).not.toContain("mode");
  });
});
