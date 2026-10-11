/** The five kinds a source produces, and "batch": several automated events about one subject, gathered by the daemon. */
export type EventKind = "issue_opened" | "comment" | "review" | "pr_opened" | "ci_failed" | "batch";

/** What every source is turned into before anything else looks at it. */
export interface ClotEvent {
  /** The source's delivery ID. Unique; used to drop repeats. */
  id: string;
  source: "github";
  kind: EventKind;
  /** owner/name, lowercased. */
  repo: string;
  /** The login of whoever caused it. */
  actor: string;
  /** One line: what happened. */
  title: string;
  /** The relevant text, trimmed to a fixed length. */
  body: string;
  url: string;
  /** The issue or pull request number, or the branch for a CI run. */
  ref: string;
  /** What the event is about: "pr:14", "issue:7" or "branch:main". Automated events about the same subject are gathered. */
  subject: string;
  /** Produced by a machine, not written by a person: a CI run, or anything from a bot account. */
  automated: boolean;
  /** Unix milliseconds. */
  receivedAt: number;
}

export interface TriageResult {
  needsAction: boolean;
  /** One line for the user. */
  message: string;
  urgent: boolean;
  suspicious: boolean;
  /** Bears on what the Clot is doing at this moment. Always false when no turn is running. */
  relevantNow: boolean;
}

/** What the user chose for an event that arrived during a turn. */
export type ReplyOutcome = "steer" | "queue" | "drop";
