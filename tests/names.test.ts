import { describe, expect, it } from "vitest";
import { sessionChannelName, splitMessage } from "../src/chat/names.js";

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
