import { gateAt, inLeadIn, type GateConfig, type GateState } from "./gates.js";
import type { UsageMeter } from "./usage-meter.js";

const FIVE_MINUTES = 5 * 60_000;

export interface GateTickerDeps {
  meter: Pick<UsageMeter, "refresh" | "snapshot">;
  gates: GateConfig;
  timeZone: string;
  now: () => number;
  /** Asks every Clot to look at its queue again. */
  kickAll: () => void;
  /** Asks the worker queue to look again. */
  wakeWorkers: () => void;
  /** Runs the sweep when it is due. Not waited for. */
  sweep: () => Promise<void>;
  /** Pings the Clots whose prompt cache is about to expire. Not waited for. Absent: none. */
  keepWarm?: () => Promise<void>;
}

/**
 * The daemon's one-minute clock. It keeps the usage reading fresh during a lead-in window, notices when
 * the gate starts or stops holding and wakes the Clots and the worker queue when it does, starts
 * the sweep when it is due, and pings the Clots whose prompt cache is about to expire. Every step catches its own errors: one that escaped would end the process.
 */
export class GateTicker {
  private last: GateState["holds"] | undefined;

  constructor(private d: GateTickerDeps) {}

  /** What the scarce and lead-in gates say now. */
  gate(): GateState {
    return gateAt(this.d.now(), this.d.gates, this.d.timeZone, this.d.meter.snapshot());
  }

  /** Compares the gate with the last answer, and wakes everything that waits when it has changed. Also called when a new reading arrives. */
  recheck(): void {
    try {
      const holds = this.gate().holds;
      if (holds === this.last) return;
      this.last = holds;
      this.d.kickAll();
      this.d.wakeWorkers();
    } catch (error) {
      console.error("checking the gate failed:", error);
    }
  }

  async tick(): Promise<void> {
    try {
      if (inLeadIn(this.d.now(), this.d.gates, this.d.timeZone)) await this.d.meter.refresh(FIVE_MINUTES);
    } catch (error) {
      console.error("refreshing the usage failed:", error);
    }
    this.recheck();
    try {
      void this.d.sweep().catch((error) => console.error("the sweep failed:", error));
    } catch (error) {
      console.error("starting the sweep failed:", error);
    }
    try {
      void this.d.keepWarm?.().catch((error) => console.error("keeping the caches warm failed:", error));
    } catch (error) {
      console.error("starting the keep-warm pings failed:", error);
    }
  }
}
