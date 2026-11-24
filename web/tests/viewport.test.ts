import { describe, expect, it } from "vitest";
import { viewportState } from "@/lib/viewport";

describe("viewportState", () => {
  it("is closed when the visible area is the window", () => expect(viewportState(844, { height: 844, offsetTop: 0 }, true).keyboard).toBe(false));
  it("is closed for the small change of a collapsing address bar", () => expect(viewportState(844, { height: 780, offsetTop: 0 }, true).keyboard).toBe(false));
  it("is open when the visible area is much shorter, and says how tall", () => {
    expect(viewportState(844, { height: 510.4, offsetTop: 0 }, true)).toEqual({ keyboard: true, height: 510, top: 0 });
  });
  it("follows the scroll iOS does to show the input", () => expect(viewportState(844, { height: 500, offsetTop: 42 }, true).top).toBe(42));
  it("is never open on a device without touch", () => expect(viewportState(800, { height: 300, offsetTop: 0 }, false).keyboard).toBe(false));
});
