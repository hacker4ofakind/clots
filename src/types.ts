export type Effort = "low" | "medium" | "high" | "xhigh";
/** The main session only ever runs at these. */
export type MainEffort = "low" | "medium";
export type WorkerModel = "opus" | "sonnet" | "haiku";

/** Why a session was started: the previous one filled its context, or the user asked for a fresh one. */
export type SeedReason = "context" | "user";

export interface RouterDecision {
  effort: MainEffort;
}

export interface TailMessage {
  role: "user" | "clot";
  text: string;
}

export interface FileChange {
  path: string;
  added: number;
  removed: number;
}

/** What a turn changed and ran. Shown to the user; never sent back to the session. */
export interface TurnActivity {
  files: FileChange[];
  commands: string[];
}

/** resetsAt is a Unix timestamp in seconds. */
export interface LimitInfo {
  resetsAt: number;
}
