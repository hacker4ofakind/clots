/**
 * What happened: a kind a built-in source produces (see kinds.ts), one a recipe declares, or
 * "batch": several automated events about one subject, gathered by the daemon.
 */
export type EventKind = string;

/** What every source is turned into before anything else looks at it. */
export interface ClotEvent {
  /** Unique; used to drop repeats. GitHub's delivery ID; for every other source, the source, the account and the source's own ID. */
  id: string;
  /** A built-in source ("github", "stripe", "email", ...) or a recipe's name. */
  source: string;
  /** Which configured account of the source it came from: "github" for GitHub, the recipe's name for a recipe. */
  account: string;
  kind: EventKind;
  /** Where at the source it happened: owner/name for GitHub (lowercased), a Linear team, the address mail was sent to. */
  place: string;
  /** Who caused it. */
  actor: string;
  /** One line: what happened. */
  title: string;
  /** The relevant text, trimmed to a fixed length. */
  body: string;
  /** A link to the thing at the source, or "" when the source has none. */
  url: string;
  /** The source's name for the thing: an issue or pull request number, a branch, a Message-ID, a Stripe object ID. */
  ref: string;
  /** What the event is about, such as "pr:14", "issue:ENC-12" or "customer:cus_1". Automated events about the same subject are gathered. */
  subject: string;
  /** Produced by a machine, not written by a person. */
  automated: boolean;
  /** Written by someone outside the project: not the repository's owner, members or collaborators, or mail from an address not the user's. */
  outsider: boolean;
  /** Unix milliseconds. */
  receivedAt: number;
}

export interface TriageResult {
  needsAction: boolean;
  /** One line for the user. */
  message: string;
  urgent: boolean;
  suspicious: boolean;
}
