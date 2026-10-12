import type { ReplyOutcome } from "./types.js";

const REPLIES: Record<ReplyOutcome, string[]> = {
  steer: ["yes", "sure", "do that", "yeah"],
  queue: ["after", "not rn", "once youre done"],
  drop: ["dont", "not at all", "no"],
};

/** Lowercase, punctuation removed, spaces collapsed: "Don't!" becomes "dont". */
export function normalizeReply(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** The outcome a reply stands for, or nothing when it is not one of the accepted replies. Exact matches only. */
export function matchReply(text: string): ReplyOutcome | undefined {
  const reply = normalizeReply(text);
  for (const outcome of ["steer", "queue", "drop"] as const) {
    if (REPLIES[outcome].includes(reply)) return outcome;
  }
  return undefined;
}

export const ASK_REPLIES = [
  "Reply with one of:",
  "- `yes`, `sure`, `do that` or `yeah` to hand it to me now",
  "- `after`, `not rn` or `once youre done` to have me look at it when this turn is over",
  "- `dont`, `not at all` or `no` to ignore it",
].join("\n");

export const ASK_RETRY = `I couldn't match that reply.\n\n${ASK_REPLIES}`;

/**
 * A reply to a proposed rule change: yes, no, or nothing when it is neither. The words are
 * those a steering question accepts; "after" means nothing here, so it is not an answer.
 */
export function matchYesNo(text: string): "yes" | "no" | undefined {
  const outcome = matchReply(text);
  if (outcome === "steer") return "yes";
  if (outcome === "drop") return "no";
  return undefined;
}

export const RULE_REPLIES = ["Reply with one of:", "- `yes`, `sure`, `do that` or `yeah` to put it in force", "- `no`, `dont` or `not at all` to decline it"].join("\n");

export const RULE_RETRY = `I couldn't match that reply.\n\n${RULE_REPLIES}`;
