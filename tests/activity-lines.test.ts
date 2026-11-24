import { describe, expect, it } from "vitest";
import { activityLine } from "../src/conversation/activity-lines.js";

describe("activityLine", () => {
  it("names what a tool call did, from its name and input", () => {
    expect(activityLine({ name: "Grep", input: { pattern: "delete" } })).toEqual({ icon: "MagnifyingGlass", text: 'Searched the code for "delete"' });
    expect(activityLine({ name: "Read", input: { file_path: "/workspace/repo/src/app/page.tsx" } })).toEqual({ icon: "FileText", text: "Read app/page.tsx" });
    expect(activityLine({ name: "Bash", input: { command: "gh issue view 31 --json title" } })).toEqual({ icon: "GithubLogo", text: "Read issue #31" });
    expect(activityLine({ name: "Bash", input: { command: "npm test\nmore" } })).toEqual({ icon: "Terminal", text: "Ran npm test" });
    expect(activityLine({ name: "WebSearch", input: { query: "sqlite drop column" } }).text).toBe('Searched the web for "sqlite drop column"');
  });

  it("puts the daemon's own tools in plain words", () => {
    expect(activityLine({ name: "mcp__clots__email_send", input: {} })).toEqual({ icon: "EnvelopeSimple", text: "Asking to send an email" });
    expect(activityLine({ name: "mcp__clots__ask_choice", input: { question: "Which runner?" } }).text).toBe("Putting a choice to you: Which runner?");
    expect(activityLine({ name: "mcp__clots__rulebook_prefilter", input: {} }).text).toBe("Working on the rulebook");
    expect(activityLine({ name: "mcp__notion__search", input: {} }).text).toBe("Used search");
  });

  it("keeps a line short and never echoes a long input whole", () => {
    const line = activityLine({ name: "Grep", input: { pattern: "x".repeat(500) } });
    expect(line.text.length).toBeLessThan(140);
  });

  it("falls back to the tool's name", () => {
    expect(activityLine({ name: "Strange", input: null })).toEqual({ icon: "Wrench", text: "Used Strange" });
  });
});
