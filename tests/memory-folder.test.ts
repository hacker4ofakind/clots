import { describe, expect, it } from "vitest";
import { encodeChange, memoryDir, parseRead } from "../src/agent/memory-folder.js";

const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64");

describe("memoryDir", () => {
  it("names the folder the way Claude Code does, from the directory a turn starts in", () => {
    expect(memoryDir("/workspace/repo")).toBe("/home/clot/.claude/projects/-workspace-repo/memory");
    expect(memoryDir("/workspace")).toBe("/home/clot/.claude/projects/-workspace/memory");
  });
});

describe("parseRead", () => {
  it("reads the global memories and the index", () => {
    const out = `F global-clot-a.md ${b64("Teal — the user's colour.\n")}\nF global-clot-b.md \nI - ${b64("- [A](global-clot-a.md)\n")}\n`;
    const state = parseRead(out)!;
    expect([...state.files]).toEqual([
      ["global-clot-a.md", "Teal — the user's colour.\n"],
      ["global-clot-b.md", ""],
    ]);
    expect(state.index).toBe("- [A](global-clot-a.md)\n");
  });

  it("gives no index when there is none, and nothing for a folder that does not exist", () => {
    expect(parseRead("")).toEqual({ files: new Map(), index: null });
    expect(parseRead("MISSING\n")).toBeUndefined();
  });

  it("leaves out a file whose name is not a global memory's", () => {
    expect(parseRead(`F global-clot-Odd.md ${b64("x")}\n`)!.files.size).toBe(0);
  });
});

describe("encodeChange", () => {
  it("writes, removes and re-indexes, one line each", () => {
    expect(encodeChange({ put: { "global-clot-a.md": "é\n" }, remove: ["global-clot-b.md"], index: "" })).toBe(`P global-clot-a.md ${b64("é\n")}\nR global-clot-b.md -\nI - \n`);
    expect(encodeChange({ put: {}, remove: [] })).toBe("");
  });

  it("refuses to touch a file that is not a global memory", () => {
    expect(() => encodeChange({ put: { "MEMORY.md": "x" }, remove: [] })).toThrow("not a global memory");
    expect(() => encodeChange({ put: {}, remove: ["../x.md"] })).toThrow("not a global memory");
  });
});
