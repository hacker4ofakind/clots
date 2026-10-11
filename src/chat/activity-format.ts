import type { TurnActivity } from "../types.js";

// Discord's ANSI palette is fixed and has no bright variants; bold is the only way to make a colour stand out more.
const GREEN = "\u001b[1;32m";
const RED = "\u001b[1;31m";
const RESET = "\u001b[0m";

const MAX_FILES = 20;
const MAX_COMMANDS = 15;
const MAX_COMMAND_LENGTH = 150;

function oneLine(command: string): string {
  const [first, ...rest] = command.trim().split("\n");
  // A zero-width space keeps a command from closing the code block it sits in.
  const safe = first.replaceAll("```", "`​`​`");
  if (safe.length > MAX_COMMAND_LENGTH) return `${safe.slice(0, MAX_COMMAND_LENGTH)} …`;
  return rest.length > 0 ? `${safe} …` : safe;
}

/** Chat markdown for a turn's summary: files with coloured line counts, then commands. No diff contents. */
export function formatActivity(a: TurnActivity): string {
  const sections: string[] = [];

  if (a.files.length > 0) {
    const lines = a.files.slice(0, MAX_FILES).map((f) => `${GREEN}+${f.added}${RESET} ${RED}-${f.removed}${RESET}  ${f.path}`);
    if (a.files.length > MAX_FILES) lines.push(`… and ${a.files.length - MAX_FILES} more files`);
    sections.push(`**Files changed**\n\`\`\`ansi\n${lines.join("\n")}\n\`\`\``);
  }

  if (a.commands.length > 0) {
    const lines = a.commands.slice(0, MAX_COMMANDS).map(oneLine);
    if (a.commands.length > MAX_COMMANDS) lines.push(`… and ${a.commands.length - MAX_COMMANDS} more commands`);
    sections.push(`**Commands**\n\`\`\`\n${lines.join("\n")}\n\`\`\``);
  }

  return sections.join("\n");
}
