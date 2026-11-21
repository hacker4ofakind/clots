/**
 * How long Claude Code's prompt cache for a main conversation lives: one hour on a Claude subscription within the
 * plan's included usage, which is how every Clot signs in. Each request that reads the cache starts the hour again.
 * On usage credits or an API key the main conversation gets five minutes instead, and a keep-warm ping would not reach.
 */
export const CACHE_TTL_MS = 60 * 60_000;
/** A Clot whose last model turn was this long ago is pinged: the TTL less a margin for the ping itself and the one-minute tick. */
export const KEEP_WARM_AFTER_MS = CACHE_TTL_MS - 5 * 60_000;
/** After a ping that failed, the next try comes this long after it (the cache is probably gone, so there is no hurry). */
export const KEEP_WARM_RETRY_MS = 5 * 60_000;

/** The text of a keep-warm turn. It is sent to the Clot's own session and never posted in chat. */
export const KEEP_WARM_PROMPT = `[Daemon: keeping your prompt cache warm. No action is needed and nobody is waiting for you. Do not use any tool and do not change anything. Reply with the single word "ok".]`;

export interface CacheKeeperDeps {
  /** The Clots to look after. */
  names: () => string[];
  now: () => number;
  /** When the Clot's last turn that reached the model ended, or undefined when it has none to count from. */
  lastTurnAt: (clot: string) => number | undefined;
  /** Runs the ping. The Clot decides whether it can (not while a turn runs, paused, or with no session to warm) and records the turn. */
  ping: (clot: string) => Promise<void>;
}

/**
 * Keeps each Clot's prompt cache from expiring between turns. Called every minute: a Clot is pinged once
 * `KEEP_WARM_AFTER_MS` have passed since ITS last turn, whatever that turn was (a message, an event, a worker's
 * report, a recap or an earlier ping), so a Clot that was busy 25 minutes ago waits another 30. The pings of different Clots run together; one
 * Clot is never pinged twice at once.
 */
export class CacheKeeper {
  private inFlight = new Set<string>();

  constructor(private d: CacheKeeperDeps) {}

  /** Whether the Clot is due now. */
  due(clot: string): boolean {
    const last = this.d.lastTurnAt(clot);
    return last !== undefined && this.d.now() - last >= KEEP_WARM_AFTER_MS;
  }

  async tick(): Promise<void> {
    const due = this.d.names().filter((name) => !this.inFlight.has(name) && this.due(name));
    await Promise.all(
      due.map(async (name) => {
        this.inFlight.add(name);
        try {
          await this.d.ping(name);
        } catch (error) {
          console.error(`[${name}] keeping the cache warm failed:`, error);
        } finally {
          this.inFlight.delete(name);
        }
      }),
    );
  }
}
