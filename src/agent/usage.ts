export type RateLimitType = "five_hour" | "seven_day";

/** One usage window as a rate-limit event reports it: a percentage and the reset in Unix seconds. */
export interface WindowState {
  /** Percent of the window used, 0-100. */
  utilization: number;
  /** Unix seconds. */
  resetsAt: number;
}

export interface RateLimitState {
  status: "allowed" | "allowed_warning" | "rejected";
  /** Unix seconds. */
  resetsAt?: number;
  /** Percent, 0-100. The event gives a fraction; it is converted here. */
  utilization?: number;
  /** The window the event is about. */
  type?: string;
  /** Both windows, when the event carries them (every event of a subscription session does). */
  windows?: Partial<Record<RateLimitType, WindowState>>;
}

const STATUSES = ["allowed", "allowed_warning", "rejected"];

/** An event gives utilization as a fraction of the window (0.02 is 2%); the usage call gives a percentage. */
export function toPercent(fraction: number): number {
  return Math.round(fraction * 10_000) / 100;
}

function windowOf(value: unknown): WindowState | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const w = value as Record<string, unknown>;
  const resetsAt = w.resetsAt ?? w.resets_at;
  if (typeof w.utilization !== "number" || typeof resetsAt !== "number") return undefined;
  return { utilization: toPercent(w.utilization), resetsAt };
}

export function parseRateLimit(message: unknown): RateLimitState | undefined {
  if (typeof message !== "object" || message === null) return undefined;
  const m = message as Record<string, any>;
  if (m.type !== "rate_limit_event" || typeof m.rate_limit_info !== "object" || m.rate_limit_info === null) return undefined;
  const info = m.rate_limit_info;
  if (!STATUSES.includes(info.status)) return undefined;
  const state: RateLimitState = { status: info.status };
  const resetsAt = info.resetsAt ?? info.resets_at;
  if (typeof resetsAt === "number") state.resetsAt = resetsAt;
  if (typeof info.utilization === "number") state.utilization = toPercent(info.utilization);
  if (typeof info.rateLimitType === "string") state.type = info.rateLimitType;
  if (typeof info.unifiedWindows === "object" && info.unifiedWindows !== null) {
    const windows: RateLimitState["windows"] = {};
    for (const type of ["five_hour", "seven_day"] as const) {
      const w = windowOf(info.unifiedWindows[type]);
      if (w) windows[type] = w;
    }
    if (Object.keys(windows).length > 0) state.windows = windows;
  }
  return state;
}
