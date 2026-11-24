import { describeGate, type GateState, type Reading } from "./gates.js";
import { modelLabel } from "./models.js";
import type { Store } from "./store.js";
import { clockLabel, hhmm, shortDay, weekStart } from "./time.js";

/** What a booked call was: the main session, re-grounding, triage and the router, one worker, the routing call, or the sweep. */
export type SpendWho = "main" | "regrounding" | "triage" | "routing" | "sweep" | `worker:${string}`;

export interface BookArgs {
  /** The Clot's name, "daemon" for the routing call, "sweep" for the sweep. */
  clot: string;
  who: SpendWho;
  /** The session whose running total this is. Without one the total is the call's own cost. */
  sessionId?: string;
  /** The SDK's `total_cost_usd`. Undefined (a turn that failed before its result) books nothing. */
  total: number | undefined;
}

export interface SpendDeps {
  store: Store;
  now: () => number;
  timeZone: string;
  /** A Clot that passes this in a week is reported once. Absent: no warning. */
  weeklyWarnUsd?: number;
  /** Posts in a Clot's live channel. */
  post: (clot: string, text: string) => Promise<void>;
  /** What the scarce and lead-in gates say now. */
  gate: () => GateState;
  meter: { refresh(maxAgeMs: number): Promise<void>; fiveHour(): Reading | undefined; sevenDay(): Reading | undefined };
}

const usd = (amount: number) => `$${amount.toFixed(2)}`;
const FIVE_MINUTES = 5 * 60_000;
const REFRESH_CEILING_MS = 15_000;
const STALE_CLAIM_MS = 5 * 60_000;

/**
 * The spend log: every model call's estimated cost in USD, booked per Clot and per kind of call, with
 * the weekly warning and the text of `/spend`. On a subscription these are estimates of what the calls
 * would cost on the API, not a bill, and the log is a floor: a turn that was stopped may go uncounted.
 */
export class SpendLog {
  constructor(private d: SpendDeps) {}

  /** The zone the week starts in, and the weekly warning's figure (undefined: no warning), changed in the configuration. */
  configure(o: { timeZone?: string; weeklyWarnUsd?: number | undefined }): void {
    if (o.timeZone !== undefined) this.d.timeZone = o.timeZone;
    if ("weeklyWarnUsd" in o) this.d.weeklyWarnUsd = o.weeklyWarnUsd;
  }

  weekStart(now: number): number {
    return weekStart(now, this.d.timeZone);
  }

  async book(a: BookArgs): Promise<void> {
    if (a.total === undefined || !Number.isFinite(a.total)) return;
    const now = this.d.now();
    const booked = this.d.store.bookSpend({ at: now, clot: a.clot, who: a.who, ...(a.sessionId === undefined ? {} : { sessionId: a.sessionId }), total: a.total });
    if (booked > 0) await this.warn(a.clot, now);
  }

  /**
   * The first time in a week that a Clot's total passes the figure, one line goes to its live channel. It is
   * claimed before it is posted, so two bookings at once post it once, and kept, so a restart never repeats it.
   * A post that fails is claimed again after the Clot's next turn.
   */
  private async warn(clot: string, now: number): Promise<void> {
    const limit = this.d.weeklyWarnUsd;
    if (limit === undefined || clot === "daemon" || clot === "sweep") return;
    const start = this.weekStart(now);
    const spent = this.d.store.spendSince(start).filter((row) => row.clot === clot).reduce((sum, row) => sum + row.usd, 0);
    if (spent <= limit) return;
    const key = `spend-warned:${clot}:${start}`;
    const claim = `posting:${now}`;
    if (!this.d.store.claimState(key, claim) && !this.takeOver(key, claim, now)) return;
    try {
      await this.d.post(clot, `${clot} has spent an estimated ${usd(spent)} this week, past the ${usd(limit).replace(/\.00$/, "")} warning. \`/spend\` shows where.`);
      // Only while the claim is still ours: one taken over meanwhile belongs to the taker.
      this.d.store.swapState(key, claim, "posted");
    } catch (error) {
      this.d.store.deleteStateIf(key, claim);
      console.error(`[${clot}] posting the spend warning failed; it is tried again after the next turn:`, error);
    }
  }

  /** A claim whose post never finished (the daemon stopped in between) is taken over once it is five minutes old. A confirmed post stays. */
  private takeOver(key: string, claim: string, now: number): boolean {
    const held = this.d.store.getState(key);
    // A bare "posting" is a claim an earlier build left without a time: it is abandoned too.
    const abandoned = held === "posting" || (held?.startsWith("posting:") === true && now - Number(held.slice("posting:".length)) > STALE_CLAIM_MS);
    return abandoned && this.d.store.swapState(key, held!, claim);
  }

  /** The text of `/spend` for one Clot. */
  async report(clot: string): Promise<string> {
    const { store } = this.d;
    await Promise.race([this.d.meter.refresh(FIVE_MINUTES), new Promise<void>((resolve) => setTimeout(resolve, REFRESH_CEILING_MS).unref())]).catch(() => undefined);
    const now = this.d.now();
    const start = this.weekStart(now);
    const rows = store.spendSince(start);
    const mine = rows.filter((row) => row.clot === clot);
    const sum = (list: { usd: number }[]) => list.reduce((total, row) => total + row.usd, 0);

    const lines = [`Spend this week, since ${shortDay(new Date(start), this.d.timeZone)} ${hhmm(new Date(start), this.d.timeZone)}. Estimated at API prices; on a subscription this is not a bill.`, `${clot}: ${usd(sum(mine))}`];
    const part = (label: string, who: string) => {
      const amount = sum(mine.filter((row) => row.who === who));
      if (amount > 0) lines.push(`- ${label}: ${usd(amount)}`);
    };
    part("Main session", "main");
    part("Re-grounding", "regrounding");
    part("Triage and router", "triage");
    for (const row of mine.filter((r) => r.who.startsWith("worker:"))) {
      const worker = store.getWorker(row.who.slice("worker:".length));
      const name = worker ? `Worker ${worker.id.slice(0, 8)} "${worker.title}" (${modelLabel(worker.model, worker.effort)})` : `Worker ${row.who.slice("worker:".length, "worker:".length + 8)}`;
      lines.push(`- ${name}: ${usd(row.usd)}`);
    }
    const daemon = sum(rows.filter((row) => row.clot === "daemon"));
    const sweep = sum(rows.filter((row) => row.clot === "sweep"));
    const all = sum(rows.filter((row) => row.clot !== "daemon" && row.clot !== "sweep"));
    lines.push(`All Clots: ${usd(all)}.${daemon > 0 ? ` Daemon: ${usd(daemon)}.` : ""}${sweep > 0 ? ` Sweep: ${usd(sweep)}.` : ""}`);

    lines.push(`Gate: ${describeGate(this.d.gate(), this.d.timeZone, now)}.`);
    lines.push(this.usageLine(now));
    return lines.join("\n");
  }

  private usageLine(now: number): string {
    const ago = (readAt: number) => {
      const minutes = Math.round((now - readAt) / 60_000);
      return minutes < 1 ? "read just now" : `read ${minutes} minute${minutes === 1 ? "" : "s"} ago`;
    };
    const window = (label: string, reading: Reading | undefined, withAge: boolean) =>
      reading === undefined ? undefined : `${label}: ${Math.round(reading.percent)}%, resets ${clockLabel(reading.resetsAt, now, this.d.timeZone)}${withAge ? ` (${ago(reading.readAt)})` : ""}.`;
    const parts = [window("Five-hour window", this.d.meter.fiveHour(), true), window("Seven-day window", this.d.meter.sevenDay(), false)].filter((p) => p !== undefined);
    return parts.length === 0 ? "Usage reading unavailable." : parts.join(" ");
  }
}
