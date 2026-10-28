import { INTERRUPTED_NOTE } from "./agent/prompts.js";

const MAX_SLUG = 40;

/** A worker's branch: `clot/<slug>-<4 hex>`, the slug made from its title. */
export function workerBranch(title: string, random: () => string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG)
    .replace(/-+$/, "");
  return `clot/${slug === "" ? "work" : slug}-${random()}`;
}

/**
 * Keeps what a worker wrote after its last tool call: that is its report. Each step clears it, and
 * the last text written is kept in case the turn ends on a tool call.
 */
export class ReportBuffer {
  private parts: string[] = [];
  private last = "";

  onStep(): void {
    this.parts = [];
  }

  onText(text: string): void {
    this.parts.push(text);
    this.last = text;
  }

  /** The first line of the last text written, for the progress line. */
  lastLine(): string {
    return this.last.split("\n").find((line) => line.trim() !== "")?.trim() ?? "";
  }

  report(): string {
    return this.parts.length > 0 ? this.parts.join("\n\n") : this.last;
  }
}

/** The first link to a GitHub pull request in a text. */
export function prLink(text: string): string | undefined {
  return /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/.exec(text)?.[0];
}

export const FROM_MAIN = "[From the main session]";

/**
 * The prompt of a worker's next turn: the cut-off note when its last turn was cut off, then the
 * brief on its first turn, then whatever the main session sent since.
 */
export function workerPrompt(o: { interrupted: boolean; brief?: string; messages: string[]; continueText?: string }): string {
  const parts: string[] = [];
  if (o.interrupted) parts.push(INTERRUPTED_NOTE);
  if (o.brief !== undefined) parts.push(o.brief);
  for (const message of o.messages) parts.push(`${FROM_MAIN}\n${message}`);
  if (parts.length === (o.interrupted ? 1 : 0) && o.continueText !== undefined) parts.push(o.continueText);
  return parts.join("\n\n");
}
