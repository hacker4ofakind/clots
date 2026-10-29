import { describe, expect, it } from "vitest";
import { isHigh, TOOL_AXES, type Axes } from "../src/axes.js";

const low: Axes = { reversible: true, visibleToOthers: false, priceAtStake: 0, commitsUser: false };

describe("the four axes", () => {
  it("rate an action high when any one axis is high, and low only when all four are", () => {
    expect(isHigh(low)).toBe(false);
    expect(isHigh({ ...low, reversible: false })).toBe(true);
    expect(isHigh({ ...low, visibleToOthers: true })).toBe(true);
    expect(isHigh({ ...low, priceAtStake: 5 })).toBe(true);
    expect(isHigh({ ...low, priceAtStake: 4.99 })).toBe(false);
    expect(isHigh({ ...low, commitsUser: true })).toBe(true);
  });

  it("rate only standing rules, sending email and merging high", () => {
    const high = Object.entries(TOOL_AXES)
      .filter(([, axes]) => isHigh(axes))
      .map(([tool]) => tool)
      .sort();
    expect(high).toEqual(["emailSend", "mergePullRequest", "standing"]);
  });
});
