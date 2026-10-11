import type { ClotEvent } from "./events/types.js";

export interface HoldOptions {
  /** A group is released this long after its last event arrived. */
  quietMs: number;
  /** A group is released at the latest this long after its first event arrived. */
  capMs: number;
  now: () => number;
  /** Runs fn after ms; the returned function cancels it. */
  schedule: (ms: number, fn: () => void) => () => void;
  onRelease: (clot: string, events: ClotEvent[]) => void;
}

interface Group {
  events: ClotEvent[];
  firstAt: number;
  cancel: () => void;
}

/**
 * Holds automated events for a short while, so that the several reports one
 * push sets off (a failed CI run, a failed deploy preview) reach the Clot
 * together. Events are grouped by Clot and subject.
 */
export class Hold {
  private groups = new Map<string, Group>();

  constructor(private o: HoldOptions) {}

  add(clot: string, event: ClotEvent): void {
    const key = `${clot}\n${event.subject}`;
    const now = this.o.now();
    const group = this.groups.get(key) ?? { events: [], firstAt: now, cancel: () => undefined };
    group.cancel();
    group.events.push(event);
    const wait = Math.max(0, Math.min(this.o.quietMs, group.firstAt + this.o.capMs - now));
    group.cancel = this.o.schedule(wait, () => {
      this.groups.delete(key);
      this.o.onRelease(clot, group.events);
    });
    this.groups.set(key, group);
  }
}
