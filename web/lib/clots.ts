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
