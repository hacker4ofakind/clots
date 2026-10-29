import { describe, expect, it } from "vitest";
import { compareHome } from "../src/memory-compare.js";

const map = (entries: Record<string, string>) => new Map(Object.entries(entries));

describe("compareHome", () => {
  it("does nothing when the home Clot's files match the set in force", () => {
    expect(compareHome(map({ "global-clot-a.md": "A" }), map({ "global-clot-a.md": "A" }))).toEqual([]);
  });

  it("applies a new file, and a changed one with the text in force beside it", () => {
    expect(compareHome(map({ "global-clot-a.md": "A2", "global-clot-b.md": "B" }), map({ "global-clot-a.md": "A" }))).toEqual([
      { kind: "apply", file: "global-clot-a.md", text: "A2", approved: "A" },
      { kind: "apply", file: "global-clot-b.md", text: "B", approved: undefined },
    ]);
  });

  it("deletes a file in force the home Clot removed, before anything else", () => {
    expect(compareHome(map({ "global-clot-b.md": "B" }), map({ "global-clot-a.md": "A" }))).toEqual([
      { kind: "delete", file: "global-clot-a.md" },
      { kind: "apply", file: "global-clot-b.md", text: "B", approved: undefined },
    ]);
  });
});
