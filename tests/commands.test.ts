import { describe, expect, it } from "vitest";
import { COMMAND_USAGE, parseCommand } from "../src/commands.js";
import { InputQueue } from "../src/agent/input-queue.js";
import { isSuccessfulResult } from "../src/agent/turn-tracker.js";

describe("parseCommand", () => {
  it("treats ordinary messages as no command", () => {
    expect(parseCommand("fix the footer")).toEqual({ kind: "none" });
    expect(parseCommand("a && b in bash")).toEqual({ kind: "none" });
    expect(parseCommand("&& is the and operator")).toEqual({ kind: "none" });
    expect(parseCommand("& that's all")).toEqual({ kind: "none" });
  });

  it("reads &close with and without a summary", () => {
    expect(parseCommand("&close")).toEqual({ kind: "close", summary: true });
    expect(parseCommand("  &close nosummary ")).toEqual({ kind: "close", summary: false });
    expect(parseCommand("&CLOSE NoSummary")).toEqual({ kind: "close", summary: false });
  });

  it("rejects anything else after &close", () => {
    expect(parseCommand("&close now please")).toEqual({ kind: "invalid", name: "close" });
  });

  it("reads &effort alone and with a message", () => {
    expect(parseCommand("&effort medium")).toEqual({ kind: "effort", effort: "medium", rest: "" });
    expect(parseCommand("&effort low check the link\nand the footer")).toEqual({ kind: "effort", effort: "low", rest: "check the link\nand the footer" });
  });

  it("rejects an effort level that is not low or medium", () => {
    expect(parseCommand("&effort high fix it")).toEqual({ kind: "invalid", name: "effort" });
    expect(parseCommand("&effort max do it")).toEqual({ kind: "invalid", name: "effort" });
    expect(parseCommand("&effort")).toEqual({ kind: "invalid", name: "effort" });
  });

  it("reports an unknown command instead of passing it on", () => {
    expect(parseCommand("&clsoe")).toEqual({ kind: "invalid", name: "clsoe" });
  });
});

describe("InputQueue", () => {
  async function drain<T>(q: InputQueue<T>): Promise<T[]> {
    const seen: T[] = [];
    for await (const item of q) seen.push(item);
    return seen;
  }

  it("yields what was pushed, in order, and ends when closed", async () => {
    const q = new InputQueue<string>(["a"]);
    const all = drain(q);
    expect(q.push("b")).toBe(true);
    q.close();
    expect(await all).toEqual(["a", "b"]);
  });

  it("refuses a push after it has been closed", async () => {
    const q = new InputQueue<string>(["a"]);
    q.close();
    expect(q.push("late")).toBe(false);
    expect(await drain(q)).toEqual(["a"]);
  });
});

describe("isSuccessfulResult", () => {
  it("requires the success subtype without an error flag", () => {
    expect(isSuccessfulResult({ subtype: "success", is_error: false })).toBe(true);
    expect(isSuccessfulResult({ subtype: "success", is_error: true })).toBe(false);
    expect(isSuccessfulResult({ subtype: "error_during_execution", is_error: true })).toBe(false);
  });
});

it("reads &rules and &rules undo, and nothing else after &rules", () => {
  expect(parseCommand("&rules")).toEqual({ kind: "rules", undo: false });
  expect(parseCommand("&Rules  UNDO ")).toEqual({ kind: "rules", undo: true });
  expect(parseCommand("&rules redo")).toEqual({ kind: "invalid", name: "rules" });
  expect(COMMAND_USAGE).toContain("`&rules undo`");
});

it("reads &composio undo, and answers &composio alone with the usage", () => {
  expect(parseCommand("&composio undo")).toEqual({ kind: "composio", undo: true });
  expect(parseCommand("&Composio  UNDO")).toEqual({ kind: "composio", undo: true });
  expect(parseCommand("&composio")).toEqual({ kind: "invalid", name: "composio" });
  expect(parseCommand("&composio undo now")).toEqual({ kind: "invalid", name: "composio" });
  expect(COMMAND_USAGE).toContain("`&composio undo`");
});

it("reads &calendar undo, and answers &calendar alone with the usage", () => {
  expect(parseCommand("&calendar undo")).toEqual({ kind: "calendar", undo: true });
  expect(parseCommand("&calendar")).toEqual({ kind: "invalid", name: "calendar" });
  expect(COMMAND_USAGE).toContain("`&calendar undo`");
});

it("reads &spend, and answers &spend with anything after it with the usage", () => {
  expect(parseCommand("&spend")).toEqual({ kind: "spend" });
  expect(parseCommand(" &Spend ")).toEqual({ kind: "spend" });
  expect(parseCommand("&spend extra")).toEqual({ kind: "invalid", name: "spend" });
  expect(COMMAND_USAGE).toContain("`&spend`");
});

it("reads &memory and &memory undo, and nothing else after &memory", () => {
  expect(parseCommand("&memory")).toEqual({ kind: "memory", undo: false });
  expect(parseCommand(" &Memory Undo")).toEqual({ kind: "memory", undo: true });
  expect(parseCommand("&memory forget it")).toEqual({ kind: "invalid", name: "memory" });
  expect(COMMAND_USAGE).toContain("`&memory`, `&memory undo`");
});
