function slug(project: string): string {
  return project.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/** The base name, or the base name with the lowest free number from 2 up. */
function firstFree(base: string, existing: string[]): string {
  if (!existing.includes(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${n}`;
    if (!existing.includes(candidate)) return candidate;
  }
}

export function sessionChannelName(project: string, date: Date, timeZone: string, existing: string[]): string {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone, day: "2-digit", month: "2-digit" }).formatToParts(date);
  const day = parts.find((p) => p.type === "day")!.value;
  const month = parts.find((p) => p.type === "month")!.value;
  return firstFree(`${slug(project)}-${day}${month}`, existing);
}

/** The temporary channel in which the user is asked to merge a pull request: `project-ask`, then `-2`, `-3` while others are open. */
export function mergeChannelName(project: string, existing: string[]): string {
  return firstFree(`${slug(project)}-ask`, existing);
}

/** The temporary channel in which the user is put a choice between two ways: `project-choice`, then `-2`, `-3` while others are open. */
export function choiceChannelName(project: string, existing: string[]): string {
  return firstFree(`${slug(project)}-choice`, existing);
}

/** The temporary channel in which the user is asked about a rule change: `project-rule`, then `-2`, `-3` while others are open. */
export function ruleChannelName(project: string, existing: string[]): string {
  return firstFree(`${slug(project)}-rule`, existing);
}

/** The temporary channel in which the user reviews an email a Clot asks to send: `project-mail`, then `-2`, `-3` while others are open. */
export function mailChannelName(project: string, existing: string[]): string {
  return firstFree(`${slug(project)}-mail`, existing);
}

/** The temporary channel in which the user is asked about a change to the configuration: `home-config`, then `-2`, `-3` while others are open. */
export function configChannelName(project: string, existing: string[]): string {
  return firstFree(`${slug(project)}-config`, existing);
}

/** The temporary channel in which the user is asked to let the daemon restart. */
export function restartChannelName(project: string, existing: string[]): string {
  return firstFree(`${slug(project)}-restart`, existing);
}

/** The temporary channel in which the user is asked about a global memory from an outsider's turn: `home-memory`, then `-2`, `-3` while others are open. */
export function memoryChannelName(project: string, existing: string[]): string {
  return firstFree(`${slug(project)}-memory`, existing);
}

export function splitMessage(text: string, max = 2000): string[] {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > max) {
    const newline = rest.lastIndexOf("\n", max);
    if (newline > 0) {
      parts.push(rest.slice(0, newline));
      rest = rest.slice(newline + 1);
    } else {
      parts.push(rest.slice(0, max));
      rest = rest.slice(max);
    }
  }
  parts.push(rest);
  return parts;
}
