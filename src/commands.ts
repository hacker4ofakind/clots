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

/** The commands as the slash menu lists them: plain English, one entry for each form. */
export const COMMAND_LIST: { name: string; options: string; description: string }[] = [
  { name: "close", options: "optionally without summary", description: "Starts a new session, after writing a recap of this one" },
  { name: "effort", options: "low or medium", description: "Sets the effort for your next message" },
  { name: "rules", options: "", description: "Shows the rules in force for this Clot" },
  { name: "rules undo", options: "", description: "Takes back the last rule change" },
  { name: "memory", options: "", description: "Shows the global memories every Clot has" },
  { name: "memory undo", options: "", description: "Takes back the last global memory change" },
  { name: "spend", options: "", description: "Shows what this Clot has spent this week" },
  { name: "calendar undo", options: "", description: "Takes back the last calendar change" },
  { name: "composio undo", options: "", description: "Takes back the last write in a connected tool" },
  { name: "composio reconnect", options: "an account such as slack:work", description: "Signs a connected tool in again" },
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
    if (args.toLowerCase() === "nosummary") return { kind: "close", summary: false };
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
