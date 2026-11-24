import type { AskRow } from "../asks.js";

/** How long an ask waited for its answer, in minutes, from its own deadline. */
export function waitedMinutes(ask: Pick<AskRow, "openedAt" | "deadline">): number {
  return Math.max(1, Math.round(((ask.deadline ?? ask.openedAt) - ask.openedAt) / 60_000));
}

/** "2 minutes", "1 minute". */
export const minutes = (n: number): string => `${n} minute${n === 1 ? "" : "s"}`;

/** The line a card and the chat show for an ask that went unanswered: silence never approves. */
export const blockedLine = (ask: Pick<AskRow, "openedAt" | "deadline">): string => `Blocked: no answer within ${minutes(waitedMinutes(ask))}.`;

/** Pretty JSON for a card's body. */
export const json = (value: unknown): string => JSON.stringify(value, null, 2) ?? "not set";
