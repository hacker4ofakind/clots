import type { Store } from "../store.js";

/** Composio's free Hobby plan, per calendar month: all tool calls and trigger events, and the share that may run on Composio-managed apps. */
export const ALLOWANCE = {
  calls: { own: 100_000, managed: 20_000 },
  events: { own: 50_000, managed: 10_000 },
};

type Kind = "call" | "delivery";
interface Month {
  calls: { own: number; managed: number };
  events: { own: number; managed: number };
  /** Calls and deliveries per account, to name who uses the allowance. */
  by: Record<string, number>;
  /** The warnings already given: `<kind>.<managed|own>.<70|90>`. */
  warned: string[];
}

const empty = (): Month => ({ calls: { own: 0, managed: 0 }, events: { own: 0, managed: 0 }, by: {}, warned: [] });

/**
 * Counts the daemon's Composio tool calls and deliveries each calendar month, and warns once at 70% and
 * once at 90% of each allowance. The counts are the daemon's own, so they miss what Composio counts
 * elsewhere (the dashboard); they are for warning early, not for billing.
 */
export class Meter {
  constructor(private d: { store: Store; now(): number; tellHome(text: string): Promise<void> }) {}

  private monthKey(): string {
    const now = new Date(this.d.now());
    return `composio.meter.${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  }

  usage(): Month {
    const text = this.d.store.getState(this.monthKey());
    return text === undefined ? empty() : { ...empty(), ...(JSON.parse(text) as Month) };
  }

  /** Counts `n` tool calls or deliveries for an account (`<toolkit>:<account>`); `managed` for a Composio-managed app. */
  async count(kind: Kind, account: string, managed: boolean, n = 1): Promise<void> {
    const month = this.usage();
    const bucket = kind === "call" ? month.calls : month.events;
    bucket[managed ? "managed" : "own"] += n;
    month.by[account] = (month.by[account] ?? 0) + n;
    const warnings: string[] = [];
    for (const threshold of [70, 90]) {
      const key = `${kind}.${managed ? "managed" : "own"}.${threshold}`;
      const allowance = (kind === "call" ? ALLOWANCE.calls : ALLOWANCE.events)[managed ? "managed" : "own"];
      if (bucket[managed ? "managed" : "own"] >= (allowance * threshold) / 100 && !month.warned.includes(key)) {
        month.warned.push(key);
        warnings.push(
          `Composio: ${Math.round(bucket[managed ? "managed" : "own"]).toLocaleString("en-US")} of this month's ${allowance.toLocaleString("en-US")} ${managed ? "Composio-managed " : ""}${kind === "call" ? "tool calls" : "trigger events"} are used (over ${threshold}%). Biggest users: ${this.biggest(month)}.`,
        );
      }
    }
    this.d.store.setState(this.monthKey(), JSON.stringify(month));
    for (const text of warnings) await this.d.tellHome(text);
  }

  private biggest(month: Month): string {
    return Object.entries(month.by)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([account, n]) => `${account} (${Math.round(n).toLocaleString("en-US")})`)
      .join(", ");
  }
}
