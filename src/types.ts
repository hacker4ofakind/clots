export type Effort = "low" | "medium" | "high";
export type Mode = "action" | "brainstorm";
export type ModeChange = "enter_brainstorm" | "exit_brainstorm" | "none";

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
