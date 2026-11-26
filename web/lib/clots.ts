import type { ClotSummary } from "@clots/ui-api-schemas";

/** What a Clot is called on screen: its name exactly as typed, and "Home" for the home Clot. */
export const clotLabel = (clot: Pick<ClotSummary, "name" | "home">): string => (clot.home ? "Home" : clot.name);

/** The name a Clot is called on screen, given only its name. */
export const labelOfName = (name: string): string => (name === "home" ? "Home" : name);

const time = (seconds: number): string => new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(seconds * 1000)).replace(":00", "");

/** A paused Clot's state in words: "Paused until 6 PM, usage limit". */
export function pausedLine(clot: Pick<ClotSummary, "resumesAt" | "reason">): string {
  const until = clot.resumesAt === null ? "" : ` until ${time(clot.resumesAt)}`;
  return `Paused${until}${clot.reason ? `, ${clot.reason}` : ""}`;
}

/** The state's one word for the Manage Clots list. */
export const STATE_WORD: Record<ClotSummary["state"], string> = { working: "Working", idle: "Idle", paused: "Paused", failed: "Failed" };

/** Which dot colour goes with a state. */
export const STATE_TONE: Record<ClotSummary["state"], "highlight" | "muted" | "calling" | "primary"> = { working: "highlight", idle: "muted", paused: "calling", failed: "primary" };

/**
 * A reply's start as plain words for a list row: links and images become their text, emphasis, code marks, headings, quotes and list
 * bullets go. The daemon cuts the text at a fixed length, so a link may be cut in half ("[#71](https://github.com/ow"); that
 * becomes its text too.
 */
export function plainPreview(markdown: string): string {
  return markdown
    .replace(/```[^\n]*\n?/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)?/g, "$1")
    .replace(/!?\[([^\]]*)\]\[[^\]]*\]/g, "$1")
    .replace(/<((?:https?:\/\/|mailto:)[^>\s]+)>/g, "$1")
    .replace(/`+([^`]*)`+/g, "$1")
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, "$2")
    .replace(/(^|[\s(])([*_])(?=\S)([^*_]*?\S)\2(?=$|[\s).,;:!?])/g, "$1$3")
    .replace(/~~([^~]*)~~/g, "$1")
    .replace(/(^|\n)\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}
