import { describe, expect, it } from "vitest";
import { isBackSwipe, type Point } from "@/lib/edge-swipe";

const at = (x: number, y: number, t: number): Point => ({ x, y, t });

describe("isBackSwipe", () => {
  it("is a swipe right from the left edge", () => expect(isBackSwipe(at(4, 400, 0), at(140, 410, 200))).toBe(true));
  it("needs the touch to start at the edge", () => expect(isBackSwipe(at(60, 400, 0), at(220, 400, 200))).toBe(false));
  it("needs enough travel", () => expect(isBackSwipe(at(4, 400, 0), at(40, 400, 100))).toBe(false));
  it("is not a swipe left", () => expect(isBackSwipe(at(4, 400, 0), at(0, 400, 100))).toBe(false));
  it("is not a scroll that drifts sideways", () => expect(isBackSwipe(at(4, 300, 0), at(100, 500, 300))).toBe(false));
  it("is not a slow drag", () => expect(isBackSwipe(at(4, 400, 0), at(140, 400, 1500))).toBe(false));
});
