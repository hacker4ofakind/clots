import { describe, expect, it } from "vitest";
import { ActivityCollector } from "../src/agent/activity.js";

const ROOT = "/workspace/repo";

let nextId = 0;
function bash(command: string, id = `t${(nextId += 1)}`) {
  return { type: "assistant", message: { content: [{ type: "tool_use", id, name: "Bash", input: { command } }] } };
}

function refused(id: string) {
  return { type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, is_error: true, content: "Refused: `touch` is not on the approved list." }] } };
}

function edited(filePath: string, lines: string[], extra: Record<string, unknown> = {}) {
  return { type: "user", tool_use_result: { filePath, structuredPatch: lines.length > 0 ? [{ lines }] : [], ...extra } };
}

describe("ActivityCollector", () => {
  it("is empty when nothing happened", () => {
    expect(new ActivityCollector(ROOT).activity()).toEqual({ files: [], commands: [] });
  });

  it("records Bash commands in order", () => {
    const c = new ActivityCollector(ROOT);
    c.observe(bash("git status"));
    c.observe(bash("npm test"));
    expect(c.activity().commands).toEqual(["git status", "npm test"]);
  });

  it("leaves out a command the lock refused, and keeps one that merely failed", () => {
    const c = new ActivityCollector(ROOT);
    c.observe(bash("touch a.txt", "call-1"));
    c.observe(refused("call-1"));
    c.observe(bash("cat missing.txt", "call-2"));
    c.observe({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "call-2", is_error: true, content: "cat: missing.txt: No such file or directory" }] } });
    expect(c.activity().commands).toEqual(["cat missing.txt"]);
  });

  it("counts added and removed lines from an edit, with the path relative to the repo", () => {
    const c = new ActivityCollector(ROOT);
    c.observe(edited("/workspace/repo/src/a.ts", [" same", "-old", "+new", "+more"]));
    expect(c.activity().files).toEqual([{ path: "src/a.ts", added: 2, removed: 1 }]);
  });

  it("adds up several edits to one file", () => {
    const c = new ActivityCollector(ROOT);
    c.observe(edited("/workspace/repo/a.ts", ["+one"]));
    c.observe(edited("/workspace/repo/a.ts", ["-one", "+two"]));
    expect(c.activity().files).toEqual([{ path: "a.ts", added: 2, removed: 1 }]);
  });

  it("counts every line of a newly created file as added", () => {
    const c = new ActivityCollector(ROOT);
    c.observe(edited("/workspace/repo/NOTES.md", [], { type: "create", content: "one\ntwo\nthree\n" }));
    expect(c.activity().files).toEqual([{ path: "NOTES.md", added: 3, removed: 0 }]);
  });

  it("keeps paths outside the repo as they are", () => {
    const c = new ActivityCollector(ROOT);
    c.observe(edited("/tmp/x.txt", ["+a"]));
    expect(c.activity().files[0].path).toBe("/tmp/x.txt");
  });

  it("ignores failed tools, other tools and other messages", () => {
    const c = new ActivityCollector(ROOT);
    c.observe({ type: "user", tool_use_result: "Error: file not found" });
    c.observe({ type: "assistant", message: { content: [{ type: "tool_use", id: "t", name: "Read", input: { file_path: "/x" } }, { type: "text", text: "hi" }] } });
    c.observe({ type: "system", subtype: "init" });
    c.observe(null);
    expect(c.activity()).toEqual({ files: [], commands: [] });
  });
});
