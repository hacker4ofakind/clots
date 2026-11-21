/** The first wait after a failure. Each failure in a row doubles it. */
export const FIRST_WAIT_MS = 30_000;
/** The longest wait. */
export const MAX_WAIT_MS = 3_600_000;
/** After this many failures in a row the user is told. */
export const TELL_AFTER = 3;

/** How long to wait before trying again after this many failures in a row. */
export function retryWait(failures: number): number {
  return Math.min(FIRST_WAIT_MS * 2 ** (failures - 1), MAX_WAIT_MS);
}

export interface ListenerOptions {
  /** How the user is told about it, for example "email gmail (Clots)". */
  name: string;
  /**
   * One run: a connection held until it closes, or one poll. It calls `ready` once it works (a
   * connection is open, a poll has read). It resolves when it ended normally and rejects when it
   * failed. A poll that resolves has worked, whether or not it called `ready`.
   */
  run: (ready: () => void) => Promise<void>;
  /** How long after a run that ended normally the next one starts. 0 for a connection, which is opened again at once. */
  everyMs: number;
  /** Posts to the user. Never throws. */
  tell: (text: string) => Promise<void>;
  /** After a failure the wait before the next try is at least this long: a poll that costs something is not retried faster than it runs. */
  minRetryMs?: number;
}

/**
 * Keeps listeners running. A listener that fails is tried again after a growing wait; after
 * three failures in a row the user is told once, and told again when it works.
 */
export class Supervisor {
  private stopped = false;
  private cancels = new Set<() => void>();

  constructor(private d: { schedule: (ms: number, fn: () => void) => () => void }) {}

  /** Starts a listener. Returns a function that stops it: its next run does not start. */
  start(o: ListenerOptions): () => void {
    const state = { failures: 0, told: false, stopped: false };
    void this.loop(o, state);
    return () => {
      state.stopped = true;
    };
  }

  stop(): void {
    this.stopped = true;
    for (const cancel of this.cancels) cancel();
    this.cancels.clear();
  }

  private async loop(o: ListenerOptions, state: { failures: number; told: boolean; stopped: boolean }): Promise<void> {
    if (this.stopped || state.stopped) return;
    const worked = async () => {
      state.failures = 0;
      if (state.told) {
        state.told = false;
        await o.tell(`${o.name} works again.`);
      }
    };
    let failure: unknown;
    let readyCalled = false;
    try {
      await o.run(() => {
        readyCalled = true;
        void worked();
      });
    } catch (error) {
      failure = error;
    }
    if (this.stopped || state.stopped) return;
    if (failure === undefined) {
      if (!readyCalled) await worked();
      this.after(o.everyMs, () => this.loop(o, state));
      return;
    }
    state.failures += 1;
    const why = failure instanceof Error ? failure.message : String(failure);
    console.error(`[listener] ${o.name} failed (${state.failures} in a row): ${why}`);
    if (state.failures === TELL_AFTER && !state.told) {
      state.told = true;
      await o.tell(`${o.name} has failed three times in a row (${why}). I keep trying, waiting longer each time, and will say when it works again.`);
    }
    this.after(Math.max(retryWait(state.failures), o.minRetryMs ?? 0), () => this.loop(o, state));
  }

  private after(ms: number, fn: () => Promise<void>): void {
    const cancel = this.d.schedule(ms, () => {
      this.cancels.delete(cancel);
      void fn();
    });
    this.cancels.add(cancel);
  }
}
