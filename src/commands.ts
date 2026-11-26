import type { MainEffort } from "./types.js";

/**
 * Commands start with "/" and are handled by the daemon. They never reach the
 * model: at most the text after `/effort <level>` is passed on.
 */
export type Command =
  | { kind: "none" }
  | { kind: "close"; summary: boolean }
  | { kind: "effort"; effort: MainEffort; rest: string }
  | { kind: "rules"; undo: boolean }
  | { kind: "memory"; undo: boolean }
  | { kind: "calendar"; undo: true }
  | { kind: "composio"; undo: true }
  | { kind: "composio"; reconnect: string }
  | { kind: "spend" }
  | { kind: "invalid"; name: string };

/**
 * The commands as the slash menu lists them, in the order the design draws them, in plain English. `options` is the hint after the
 * name; `required` says that the command does nothing without one (the menu runs the others on one Enter). `rules` and `memory`
 * also take `undo`, which is the "optionally undo" of their hint.
 */
export const COMMAND_LIST: { name: string; options: string; required: boolean; description: string }[] = [
  { name: "effort", options: "low or medium", required: true, description: "Sets the effort for your next message" },
  { name: "close", options: "optionally without summary", required: false, description: "Sums up this session and starts a new one" },
  { name: "rules", options: "optionally undo", required: false, description: "Shows the rules in force, or reverts the last edit" },
  { name: "memory", options: "optionally undo", required: false, description: "Shows global memories, or reverts the last change" },
  { name: "spend", options: "", required: false, description: "This week’s spend and usage" },
  { name: "calendar undo", options: "", required: false, description: "Reverses the last calendar change" },
  { name: "composio undo", options: "", required: false, description: "Reverses the last Composio write" },
  { name: "composio reconnect", options: "tool:account", required: true, description: "Signs a tool in again" },
];

export const COMMAND_USAGE = "Commands: `/close`, `/close nosummary`, `/effort low|medium [message]`, `/rules`, `/rules undo`, `/memory`, `/memory undo`, `/calendar undo`, `/composio undo`, `/composio reconnect <toolkit>:<account>`, `/spend`.";

const EFFORTS: MainEffort[] = ["low", "medium"];

export function parseCommand(text: string): Command {
  const match = /^\/([a-z]+)(?:\s+([\s\S]*))?$/i.exec(text.trim());
  if (!match) return { kind: "none" };
  const name = match[1].toLowerCase();
  const args = (match[2] ?? "").trim();

  if (name === "close") {
    if (args === "") return { kind: "close", summary: true };
    if (["nosummary", "without summary"].includes(args.toLowerCase().replace(/[ \t]+/g, " "))) return { kind: "close", summary: false };
    return { kind: "invalid", name };
  }

  if (name === "effort") {
    const [level, ...rest] = args.split(/\s+/);
    const effort = EFFORTS.find((e) => e === level?.toLowerCase());
    if (!effort) return { kind: "invalid", name };
    return { kind: "effort", effort, rest: args.slice(level.length).trim() };
  }

  if (name === "spend") return args === "" ? { kind: "spend" } : { kind: "invalid", name };

  if (name === "calendar") return args.toLowerCase() === "undo" ? { kind: "calendar", undo: true } : { kind: "invalid", name };

  if (name === "composio") {
    if (args.toLowerCase() === "undo") return { kind: "composio", undo: true };
    const reconnect = /^reconnect\s+(\S+)$/i.exec(args);
    return reconnect ? { kind: "composio", reconnect: reconnect[1] } : { kind: "invalid", name };
  }

  if (name === "rules" || name === "memory") {
    if (args === "") return { kind: name, undo: false };
    if (args.toLowerCase() === "undo") return { kind: name, undo: true };
    return { kind: "invalid", name };
  }

  return { kind: "invalid", name };
}
