import { describe, expect, it } from "vitest";
import { recapLines } from "@/components/clots/chat-parts";

describe("recapLines", () => {
  it("keeps a paragraph whole and gives each list item its own line", () => {
    expect(recapLines("We fixed the build.\n\n- one\n- two\n\nNext: the docs.")).toEqual(["We fixed the build.", "- one", "- two", "Next: the docs."]);
  });
  it("keeps a block that mixes text and list lines together", () => {
    expect(recapLines("Done:\n- one\n- two")).toEqual(["Done:\n- one\n- two"]);
  });
  it("has no lines for empty text", () => {
    expect(recapLines("  \n\n ")).toEqual([]);
  });
});
