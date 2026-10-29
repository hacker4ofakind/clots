const YES = ["yes", "sure", "do that", "yeah"];
const NO = ["dont", "not at all", "no"];

/** Lowercase, punctuation removed, spaces collapsed: "Don't!" becomes "dont". */
export function normalizeReply(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** A reply to a proposed change: yes, no, or nothing when it is neither. Exact matches only. */
export function matchYesNo(text: string): "yes" | "no" | undefined {
  const reply = normalizeReply(text);
  if (YES.includes(reply)) return "yes";
  if (NO.includes(reply)) return "no";
  return undefined;
}

export const RULE_REPLIES = ["Reply with one of:", "- `yes`, `sure`, `do that` or `yeah` to put it in force", "- `no`, `dont` or `not at all` to decline it"].join("\n");

export const RULE_RETRY = `I couldn't match that reply.\n\n${RULE_REPLIES}`;

const FIRST = ["1", "one", "first"];
const SECOND = ["2", "two", "second"];
const PICK = ["your pick", "go ahead"];

/** A reply to a choice: option 1, option 2, the Clot's pick, or nothing when it is none of these. Exact matches only. */
export function matchChoice(text: string): 1 | 2 | "pick" | undefined {
  const reply = normalizeReply(text);
  if (FIRST.includes(reply)) return 1;
  if (SECOND.includes(reply)) return 2;
  if (PICK.includes(reply)) return "pick";
  return undefined;
}

/** A reply about an email a Clot asks to send: send it, drop it, save it as a draft, or nothing when it is none of these, which makes it feedback. */
export function matchSendReply(text: string): "yes" | "no" | "draft" | undefined {
  if (normalizeReply(text) === "draft") return "draft";
  return matchYesNo(text);
}

export const SEND_REPLIES = [
  "Reply with one of:",
  "- `yes`, `sure`, `do that` or `yeah` to send it as it is",
  "- `no`, `dont` or `not at all` to drop it",
  "- `draft` to save it in your Drafts instead, to change and send yourself",
  "- anything else is feedback: I'll pass it on, and the revised email comes back in a new channel",
].join("\n");
