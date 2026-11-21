import type { ToolInfo } from "./api.js";

/** Who sees what happens in an account: only the user and the Clots, the user and people they know well, or anyone. */
export type Audience = "private" | "team" | "public";

export type Rating = { rating: "run" | "review" | "ask"; reason: string };
type Rated = Pick<ToolInfo, "slug" | "toolkit" | "tags">;

const hasTag = (tool: Rated, tag: string) => tool.tags.includes(tag);
const FOUR_TAGS = ["readOnlyHint", "createHint", "updateHint", "destructiveHint"];

/** The words of a slug, uppercase: "LINEAR_ARCHIVE_ISSUE" is LINEAR, ARCHIVE, ISSUE. */
const words = (slug: string) => slug.toUpperCase().split("_");

/** Whether the slug has the word, or its plural: PAYMENT matches PAYMENT and PAYMENTS, never PAYMENTSYSTEM. */
const hasWord = (slugWords: string[], word: string) => slugWords.some((w) => w === word || w === `${word}S`);

/** A verb that writes, as the slug's first word after the toolkit: a read tag on such a tool is not believed. */
const WRITE_VERBS = ["CREATE", "ADD", "UPDATE", "EDIT", "SET", "DELETE", "REMOVE", "ARCHIVE", "SEND", "POST", "INVITE", "SHARE", "PUBLISH", "MOVE", "MERGE", "CANCEL"];
/** A tool whose effect depends on its arguments: always rated destructive. */
const PASSTHROUGH_WORDS = ["GRAPHQL", "PROXY", "REQUEST", "RAW", "EXECUTE"];
const DESTRUCTIVE_WORDS = ["DELETE", "ARCHIVE", "REMOVE", "REVOKE", "CANCEL", "REASSIGN", "TRANSFER"];
const MONEY_WORDS = ["PAYMENT", "CHARGE", "REFUND", "PAYOUT", "TRANSFER", "INVOICE", "SUBSCRIPTION"];
const PEOPLE_WORDS = ["SEND", "EMAIL", "MESSAGE", "SMS", "INVITE", "SHARE", "PUBLISH"];
const CONTROL_WORDS = ["WEBHOOK", "TOKEN", "OAUTH", "INTEGRATION", "ROLE", "PERMISSION", "MEMBER", "ADMIN", "ACL"];

const isPassthrough = (tool: Rated) => {
  const w = words(tool.slug);
  return w[0] === "COMPOSIO" || PASSTHROUGH_WORDS.some((word) => hasWord(w, word)) || tool.slug.toUpperCase().includes("QUERY_OR_MUTATION");
};

/**
 * A tool that only reads: tagged `readOnlyHint` and no destructive tag, whose slug does not begin with
 * a write and is not a passthrough. A read tag is not trusted alone.
 */
export function isRead(tool: Rated): boolean {
  if (!hasTag(tool, "readOnlyHint") || hasTag(tool, "destructiveHint") || isPassthrough(tool)) return false;
  return !WRITE_VERBS.includes(words(tool.slug)[1] ?? "");
}

/**
 * Destructive: tagged `destructiveHint`, tagged with none of the four tags (the worst is assumed of a tool
 * Composio did not describe), named for deleting, archiving, removing, revoking, cancelling, reassigning or
 * transferring, or a passthrough.
 */
export function isDestructive(tool: Rated): boolean {
  const w = words(tool.slug);
  return hasTag(tool, "destructiveHint") || !FOUR_TAGS.some((tag) => hasTag(tool, tag)) || DESTRUCTIVE_WORDS.some((word) => hasWord(w, word)) || isPassthrough(tool);
}

/**
 * What always asks, whatever the audience: money (every Stripe write, and any write named for a payment,
 * charge, refund, payout, transfer, invoice or subscription), reaching a person outside the workspace, and
 * changing who or what can reach it. Only a write is on the list: a read never is.
 */
export function onFixedList(tool: Rated): "money" | "people" | "control" | undefined {
  if (isRead(tool)) return undefined;
  const w = words(tool.slug);
  if (tool.toolkit === "stripe" || MONEY_WORDS.some((word) => hasWord(w, word))) return "money";
  if (PEOPLE_WORDS.some((word) => hasWord(w, word))) return "people";
  if (CONTROL_WORDS.some((word) => hasWord(w, word)) || tool.slug.toUpperCase().includes("_API_KEY")) return "control";
  return undefined;
}

const FIXED_REASON = { money: "it moves money", people: "it reaches people outside the workspace", control: "it changes who or what can reach the workspace" };

/**
 * Rates one `composio_run` call, in the order of the spec: a read runs; the fixed list asks; a public
 * account asks; in a turn an outsider's text started, a destructive write on something no Clot made asks and
 * every other write is reviewed; a private account runs; a team account runs what is not destructive and
 * reviews what is. `targetCreatedByClot` is what the daemon checked against its own log, never what the
 * model said; "unknown" counts as not created by a Clot. Pure.
 */
export function rateComposioCall(tool: Rated, audience: Audience, outsiderTurn: boolean, targetCreatedByClot: boolean | "unknown"): Rating {
  if (isRead(tool)) return { rating: "run", reason: "it only reads" };
  const fixed = onFixedList(tool);
  if (fixed !== undefined) return { rating: "ask", reason: FIXED_REASON[fixed] };
  if (audience === "public") return { rating: "ask", reason: "this account is public" };
  if (outsiderTurn) {
    if (isDestructive(tool) && targetCreatedByClot !== true) return { rating: "ask", reason: "an outsider's text started this turn, and this would delete or change something no Clot made" };
    return { rating: "review", reason: "an outsider's text started this turn" };
  }
  if (audience === "private") return { rating: "run", reason: "this account is private" };
  return isDestructive(tool) ? { rating: "review", reason: "it is destructive, in a team account" } : { rating: "run", reason: "it is not destructive, in a team account" };
}
