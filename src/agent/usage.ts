export interface RateLimitState {
  status: "allowed" | "allowed_warning" | "rejected";
  resetsAt?: number;
  utilization?: number;
}

const STATUSES = ["allowed", "allowed_warning", "rejected"];

export function parseRateLimit(message: unknown): RateLimitState | undefined {
  if (typeof message !== "object" || message === null) return undefined;
  const m = message as Record<string, any>;
  if (m.type !== "rate_limit_event" || typeof m.rate_limit_info !== "object" || m.rate_limit_info === null) return undefined;
  const info = m.rate_limit_info;
  if (!STATUSES.includes(info.status)) return undefined;
  const state: RateLimitState = { status: info.status };
  const resetsAt = info.resetsAt ?? info.resets_at;
  if (typeof resetsAt === "number") state.resetsAt = resetsAt;
  if (typeof info.utilization === "number") state.utilization = info.utilization;
  return state;
}
