import { describe, expect, it } from "vitest";
import { askChannelName, calChannelName, memoryChannelName, ruleChannelName, sessionChannelName, splitMessage } from "../src/chat/names.js";

it("names the channel of a calendar removal", () => {
  expect(calChannelName("graphite", [])).toBe("graphite-cal");
  expect(calChannelName("graphite", ["graphite-cal"])).toBe("graphite-cal-2");
});

describe("sessionChannelName", () => {
  const noon = new Date("2026-10-10T12:00:00Z");

  it("uses project-DDMM, lowercased", () => {
    expect(sessionChannelName("Graphite", noon, "UTC", [])).toBe("graphite-1010");
  });

  it("adds -2 for a second session on the same day, then -3", () => {
    expect(sessionChannelName("graphite", noon, "UTC", ["graphite-1010"])).toBe("graphite-1010-2");
    expect(sessionChannelName("graphite", noon, "UTC", ["graphite-1010", "graphite-1010-2"])).toBe("graphite-1010-3");
  });

  it("takes the date in the configured time zone", () => {
    const lateEvening = new Date("2026-10-10T23:30:00Z");
    expect(sessionChannelName("graphite", lateEvening, "Europe/Prague", [])).toBe("graphite-1110");
  });

  it("replaces characters Discord does not allow", () => {
    expect(sessionChannelName("My App!", noon, "UTC", [])).toBe("my-app-1010");
  });
});

describe("askChannelName", () => {
  it("uses project-ask, then numbers while others are open", () => {
    expect(askChannelName("Graphite", [])).toBe("graphite-ask");
    expect(askChannelName("graphite", ["graphite-1010", "graphite-ask"])).toBe("graphite-ask-2");
    expect(askChannelName("graphite", ["graphite-ask", "graphite-ask-2"])).toBe("graphite-ask-3");
  });
});

describe("splitMessage", () => {
  it("returns short text unchanged", () => {
    expect(splitMessage("hello")).toEqual(["hello"]);
  });

  it("splits long text into parts no longer than the limit", () => {
    const parts = splitMessage("a".repeat(4500));
    expect(parts).toHaveLength(3);
    expect(parts.every((p) => p.length <= 2000)).toBe(true);
    expect(parts.join("")).toBe("a".repeat(4500));
  });

  it("prefers to break at a newline", () => {
    const text = "x".repeat(1500) + "\n" + "y".repeat(1000);
    expect(splitMessage(text)).toEqual(["x".repeat(1500), "y".repeat(1000)]);
  });
});

it("names a proposal's channel after the Clot, with the lowest free number", () => {
  expect(ruleChannelName("Graphite", [])).toBe("graphite-rule");
  expect(ruleChannelName("graphite", ["graphite-rule", "graphite-ask"])).toBe("graphite-rule-2");
  expect(ruleChannelName("graphite", ["graphite-rule", "graphite-rule-3"])).toBe("graphite-rule-2");
});

it("names a global memory question's channel after the home Clot, with the lowest free number", () => {
  expect(memoryChannelName("home", [])).toBe("home-memory");
  expect(memoryChannelName("home", ["home-memory", "home-rule"])).toBe("home-memory-2");
});
