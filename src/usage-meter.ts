import type { Reading, UsageSnapshot } from "./gates.js";
import type { RateLimitState } from "./agent/usage.js";

/** The minutes to wait after a failed usage call before the next one: 5, 10, 20, then 60. */
const BACKOFF_MINUTES = [5, 10, 20, 60];

interface MeterStore {
  getState(key: string): string | undefined;
  setState(key: string, value: string): void;
}

export interface UsageMeterDeps {
  store: MeterStore;
  now: () => number;
  /** Makes the usage call. Undefined when it failed or the account has no plan limits. */
  read: () => Promise<UsageSnapshot | undefined>;
}

const KEYS = { fiveHour: "usage-five-hour", sevenDay: "usage-seven-day" } as const;

function parseReading(text: string | undefined): Reading | undefined {
  if (text === undefined) return undefined;
  try {
    const r = JSON.parse(text) as Partial<Reading>;
    return typeof r.percent === "number" && typeof r.resetsAt === "number" && typeof r.readAt === "number" ? { percent: r.percent, resetsAt: r.resetsAt, readAt: r.readAt } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The account's five-hour and seven-day utilization, as the latest rate-limit event or usage call
 * gave them. Readings are kept across restarts: a restart during a held lead-in must not release
 * what waits.
 */
export class UsageMeter {
  private five: Reading | undefined;
  private seven: Reading | undefined;
  private listeners: (() => void)[] = [];
  private inFlight?: Promise<void>;
  private lastAttemptAt = 0;
  private failures = 0;

  constructor(private d: UsageMeterDeps) {
    this.five = parseReading(d.store.getState(KEYS.fiveHour));
    this.seven = parseReading(d.store.getState(KEYS.sevenDay));
  }

  /** The latest five-hour reading, or undefined when there is none or its window has reset. */
  fiveHour(): Reading | undefined {
    return this.five !== undefined && this.d.now() < this.five.resetsAt ? this.five : undefined;
  }

  sevenDay(): Reading | undefined {
    return this.seven !== undefined && this.d.now() < this.seven.resetsAt ? this.seven : undefined;
  }

  snapshot(): UsageSnapshot {
    const fiveHour = this.fiveHour();
    const sevenDay = this.sevenDay();
    return { ...(fiveHour ? { fiveHour } : {}), ...(sevenDay ? { sevenDay } : {}) };
  }

  /** Called when a reading changes, so the gate can be asked again. */
  onChange(fn: () => void): void {
    this.listeners.push(fn);
  }

  private set(window: "fiveHour" | "sevenDay", percent: number, resetsAtMs: number): boolean {
    const next: Reading = { percent, resetsAt: resetsAtMs, readAt: this.d.now() };
    const previous = window === "fiveHour" ? this.five : this.seven;
    if (window === "fiveHour") this.five = next;
    else this.seven = next;
    this.d.store.setState(KEYS[window], JSON.stringify(next));
    return previous === undefined || previous.percent !== percent || previous.resetsAt !== resetsAtMs;
  }

  /**
   * Takes what a rate-limit event says. An event gives its reset in Unix seconds and its
   * utilization in percent (the parser has converted it); one without either leaves the reading as it was.
   */
  observe(s: RateLimitState): void {
    let changed = false;
    for (const [type, window] of [["five_hour", "fiveHour"], ["seven_day", "sevenDay"]] as const) {
      const w = s.windows?.[type] ?? (s.type === type && s.utilization !== undefined && s.resetsAt !== undefined ? { utilization: s.utilization, resetsAt: s.resetsAt } : undefined);
      if (w && this.set(window, w.utilization, w.resetsAt * 1000)) changed = true;
    }
    if (changed) this.notify();
  }

  private notify(): void {
    for (const fn of this.listeners) {
      try {
        fn();
      } catch (error) {
        console.error("usage meter listener failed:", error);
      }
    }
  }

  /**
   * Makes the usage call when the five-hour reading is older than `maxAgeMs` (or there is none).
   * One call at a time. After a failure the next call waits 5, 10, 20, then 60 minutes, whatever the age.
   */
  refresh(maxAgeMs: number): Promise<void> {
    if (this.inFlight) return this.inFlight;
    const now = this.d.now();
    if (this.failures > 0 && now - this.lastAttemptAt < BACKOFF_MINUTES[Math.min(this.failures, BACKOFF_MINUTES.length) - 1]! * 60_000) return Promise.resolve();
    if (this.five !== undefined && now < this.five.resetsAt && now - this.five.readAt < maxAgeMs) return Promise.resolve();
    this.lastAttemptAt = now;
    this.inFlight = (async () => {
      try {
        const snapshot = await this.d.read();
        if (snapshot === undefined || (snapshot.fiveHour === undefined && snapshot.sevenDay === undefined)) {
          this.failures += 1;
          return;
        }
        this.failures = 0;
        let changed = false;
        if (snapshot.fiveHour && this.set("fiveHour", snapshot.fiveHour.percent, snapshot.fiveHour.resetsAt)) changed = true;
        if (snapshot.sevenDay && this.set("sevenDay", snapshot.sevenDay.percent, snapshot.sevenDay.resetsAt)) changed = true;
        if (changed) this.notify();
      } catch (error) {
        console.error("reading the usage failed:", error);
        this.failures += 1;
      } finally {
        this.inFlight = undefined;
      }
    })();
    return this.inFlight;
  }

  /** Whether the on-demand call is currently failing, so that `&spend` can say the reading is unavailable. */
  get failing(): boolean {
    return this.failures > 0;
  }
}
