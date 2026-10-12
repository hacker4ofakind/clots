import type { Effort } from "./types.js";

/**
 * Commands start with "&" and are handled by the daemon. They never reach the
 * model: at most the text after `&effort <level>` is passed on.
 */
export type Command =
  | { kind: "none" }
  | { kind: "close"; summary: boolean }
  | { kind: "effort"; effort: Effort; rest: string }
  | { kind: "rules"; undo: boolean }
  | { kind: "invalid"; name: string };

export const COMMAND_USAGE = "Commands: `&close`, `&close nosummary`, `&effort low|medium|high [message]`, `&rules`, `&rules undo`.";

const EFFORTS: Effort[] = ["low", "medium", "high"];

export function parseCommand(text: string): Command {
  const match = /^&([a-z]+)(?:\s+([\s\S]*))?$/i.exec(text.trim());
  if (!match) return { kind: "none" };
  const name = match[1].toLowerCase();
  const args = (match[2] ?? "").trim();

  if (name === "close") {
    if (args === "") return { kind: "close", summary: true };
    if (args.toLowerCase() === "nosummary") return { kind: "close", summary: false };
    return { kind: "invalid", name };
  }

  if (name === "effort") {
    const [level, ...rest] = args.split(/\s+/);
    const effort = EFFORTS.find((e) => e === level?.toLowerCase());
    if (!effort) return { kind: "invalid", name };
    return { kind: "effort", effort, rest: args.slice(level.length).trim() };
  }

  if (name === "rules") {
    if (args === "") return { kind: "rules", undo: false };
    if (args.toLowerCase() === "undo") return { kind: "rules", undo: true };
    return { kind: "invalid", name };
  }

  return { kind: "invalid", name };
}
