import { describe, expect, it } from "vitest";
import { buildRouterPrompt, nextMode, parseDecision } from "../src/router.js";

describe("parseDecision", () => {
  it("accepts a valid decision", () => {
    expect(parseDecision({ effort: "high", modeChange: "enter_brainstorm" })).toEqual({ effort: "high", modeChange: "enter_brainstorm" });
  });

  it("falls back to medium and none for anything invalid", () => {
    expect(parseDecision(undefined)).toEqual({ effort: "medium", modeChange: "none" });
    expect(parseDecision({ effort: "max", modeChange: "sideways" })).toEqual({ effort: "medium", modeChange: "none" });
  });
});

describe("nextMode", () => {
  it("enters and leaves brainstorm mode", () => {
    expect(nextMode("action", "enter_brainstorm")).toBe("brainstorm");
    expect(nextMode("brainstorm", "exit_brainstorm")).toBe("action");
  });

  it("stays put otherwise", () => {
    expect(nextMode("brainstorm", "none")).toBe("brainstorm");
    expect(nextMode("brainstorm", "enter_brainstorm")).toBe("brainstorm");
    expect(nextMode("action", "exit_brainstorm")).toBe("action");
  });
});

describe("buildRouterPrompt", () => {
  it("includes the mode, the recent messages and the new message", () => {
    const prompt = buildRouterPrompt({
      text: "yeah sure",
      mode: "action",
      tail: [{ role: "clot", text: "Should I build the page?" }],
    });
    expect(prompt).toContain("Current mode: action");
    expect(prompt).toContain("clot: Should I build the page?");
    expect(prompt).toContain("<new_message>\nyeah sure\n</new_message>");
  });
});
