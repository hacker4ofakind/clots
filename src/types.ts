export type Effort = "low" | "medium" | "high";
export type Mode = "action" | "brainstorm";
export type ModeChange = "enter_brainstorm" | "exit_brainstorm" | "none";

/** Why a session was started: the previous one filled its context, or the user asked for a fresh one. */
export type SeedReason = "context" | "user";

export interface RouterDecision {
  effort: Effort;
  modeChange: ModeChange;
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
