/** One line of a main-session turn's activity: an icon (a Phosphor component name the web app knows) and what happened. */
export interface ActivityLine {
  icon: string;
  text: string;
}

const MAX = 90;

const clip = (text: string): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > MAX ? `${flat.slice(0, MAX - 1)}…` : flat;
};

const str = (value: unknown): string => (typeof value === "string" ? value : "");

/** The last two parts of a path: enough to name a file without the container's directories. */
const shortPath = (path: string): string => path.split(/[\\/]/).filter(Boolean).slice(-2).join("/");

/** The daemon's own MCP tools, named in the Clot's words. */
const DAEMON_LINES: Record<string, (input: Record<string, unknown>) => ActivityLine> = {
  email_send: () => ({ icon: "EnvelopeSimple", text: "Asking to send an email" }),
  email_draft: () => ({ icon: "EnvelopeSimple", text: "Saving an email draft" }),
  ask_choice: (i) => ({ icon: "ListChecks", text: `Putting a choice to you: ${clip(str(i.question))}` }),
  merge_pull_request: (i) => ({ icon: "GitMerge", text: `Asking to merge #${str(i.number) || String(i.number ?? "")}` }),
  start_session: () => ({ icon: "UsersThree", text: "Starting a worker" }),
  message_worker: () => ({ icon: "ChatCircle", text: "Messaging a worker" }),
  ask_main: () => ({ icon: "ChatCircle", text: "Asking the main session" }),
  config_get: (i) => ({ icon: "GearSix", text: `Reading the setting ${clip(str(i.key) || "file")}` }),
  config_set: (i) => ({ icon: "GearSix", text: `Asking to change ${clip(str(i.key))}` }),
  daemon_restart: () => ({ icon: "ArrowsClockwise", text: "Asking to restart" }),
  hand_to_home: () => ({ icon: "House", text: "Passing a request to Home" }),
  calendar_list: () => ({ icon: "CalendarBlank", text: "Reading your calendar" }),
  calendar_write: () => ({ icon: "CalendarBlank", text: "Changing your calendar" }),
  calendar_remove: () => ({ icon: "CalendarBlank", text: "Removing a calendar event" }),
  composio_find: (i) => ({ icon: "PuzzlePiece", text: `Looking for a tool: ${clip(str(i.query) || str(i.toolkit))}` }),
  composio_run: (i) => ({ icon: "PuzzlePiece", text: `Running ${clip(str(i.slug) || "a tool")}` }),
  composio_toolkit: (i) => ({ icon: "PuzzlePiece", text: `Looking at ${clip(str(i.toolkit))}` }),
};

/**
 * One short line for a tool call, from its name and input: `Searched the code for "delete"`, `Read
 * issue #31`, `Asking to send an email`. Built only from what the call names, never from what it returned.
 */
export function activityLine(tool: { name: string; input: unknown }): ActivityLine {
  const input = typeof tool.input === "object" && tool.input !== null ? (tool.input as Record<string, unknown>) : {};
  const mcp = /^mcp__clots__(.+)$/.exec(tool.name)?.[1];
  if (mcp !== undefined) {
    const make = DAEMON_LINES[mcp];
    if (make) return make(input);
    if (mcp.startsWith("rulebook_")) return { icon: "BookOpenText", text: "Working on the rulebook" };
    return { icon: "Wrench", text: `Using ${mcp.replace(/_/g, " ")}` };
  }
  if (tool.name.startsWith("mcp__")) return { icon: "Wrench", text: `Used ${tool.name.split("__")[2]?.replace(/_/g, " ") ?? "a connected tool"}` };
  switch (tool.name) {
    case "Read":
      return { icon: "FileText", text: `Read ${shortPath(str(input.file_path)) || "a file"}` };
    case "Grep":
      return { icon: "MagnifyingGlass", text: `Searched the code for "${clip(str(input.pattern))}"` };
    case "Glob":
      return { icon: "MagnifyingGlass", text: `Looked for files matching ${clip(str(input.pattern))}` };
    case "Edit":
    case "MultiEdit":
    case "Write":
    case "NotebookEdit":
      return { icon: "PencilSimple", text: `Wrote ${shortPath(str(input.file_path)) || "a file"}` };
    case "WebFetch":
      return { icon: "Globe", text: `Read ${clip(str(input.url))}` };
    case "WebSearch":
      return { icon: "Globe", text: `Searched the web for "${clip(str(input.query))}"` };
    case "Bash": {
      const command = str(input.command).split("\n")[0]!.trim();
      const issue = /^gh\s+(issue|pr)\s+(?:view|diff|checks)\s+#?(\d+)/.exec(command);
      if (issue) return { icon: "GithubLogo", text: `Read ${issue[1] === "pr" ? "pull request" : "issue"} #${issue[2]}` };
      return { icon: "Terminal", text: `Ran ${clip(command)}` };
    }
    case "Task":
    case "Agent":
      return { icon: "UsersThree", text: "Asked a helper" };
    case "TodoWrite":
      return { icon: "ListChecks", text: "Updated its plan" };
    default:
      return { icon: "Wrench", text: `Used ${tool.name}` };
  }
}
