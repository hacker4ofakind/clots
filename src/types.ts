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

/** resetsAt is a Unix timestamp in seconds. */
export interface LimitInfo {
  resetsAt: number;
}
