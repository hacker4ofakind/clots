import type { ChatAdapter } from "./chat/adapter.js";
import { combine } from "./events/batch.js";
import { isSelfCaused } from "./events/github.js";
import type { ClotEvent } from "./events/types.js";
import { Hold } from "./hold.js";
import type { ClotPort } from "./steering.js";
import type { Store } from "./store.js";
import type { Triage } from "./triage.js";

export interface PipelineDeps {
  store: Store;
  chat: ChatAdapter;
  rulebook: { isDropped(clot: string, event: ClotEvent): boolean; guidance(clot: string): string };
  triage: Triage;
  steering: { ask(clot: string, event: ClotEvent, message: string): Promise<boolean> };
  clots: Map<string, ClotPort>;
  /** Which Clot is bound to a repository ("owner/name", lowercased), if any. */
  clotForRepo: (repo: string) => string | undefined;
  /** The login of the Clots' GitHub account, or "" when it is not known. */
  clotLogin: string;
  /** Adds a review's inline comments to its event. */
  readInline: (event: ClotEvent) => Promise<ClotEvent>;
  /** How long automated events are held to be gathered: after the last one, and at most after the first. */
  hold: { quietMs: number; capMs: number };
  now: () => number;
  /** Runs fn after ms; the returned function cancels it. */
  schedule: (ms: number, fn: () => void) => () => void;
}

/** Takes a stored event from arrival to its outcome: dropped, held, asked about, or queued for the Clot. */
export class Pipeline {
  private held: Hold;
  /** Events being handled at this moment, so that one is never handled twice at once. */
  private inFlight = new Set<string>();

  constructor(private d: PipelineDeps) {
    this.held = new Hold({ ...d.hold, now: d.now, schedule: d.schedule, onRelease: (clot, events) => void this.release(clot, events) });
  }

  /** Never throws: an event that cannot be processed is logged and left as received, to be picked up at the next start. */
  async handle(event: ClotEvent): Promise<void> {
    if (this.inFlight.has(event.id)) return;
    this.inFlight.add(event.id);
    try {
      await this.run(event);
    } catch (error) {
      console.error(`[pipeline] event ${event.id} failed:`, error);
    } finally {
      this.inFlight.delete(event.id);
    }
  }

  /**
   * Finishes what a restart interrupted, oldest first. Events that were being
   * held have waited long enough and are released at once; events that were
   * stored but not finished run from the start. Called once at startup.
   */
  async resume(): Promise<void> {
    // Read before anything is released: a release stores a batch as received, and takes it onward itself.
    const unfinished = this.d.store.eventsWithStatus("received");
    const groups = new Map<string, { clot: string; events: ClotEvent[] }>();
    for (const event of this.d.store.eventsWithStatus("held")) {
      if (event.clot === null) continue;
      const key = `${event.clot}\n${event.subject}`;
      const group = groups.get(key) ?? { clot: event.clot, events: [] };
      group.events.push(event);
      groups.set(key, group);
    }
    for (const group of groups.values()) await this.release(group.clot, group.events);
    for (const event of unfinished) {
      // It may have been handled in the meantime: events keep arriving while this runs.
      if (this.d.store.getEvent(event.id)?.status === "received") await this.handle(event);
    }
  }

  private async run(event: ClotEvent): Promise<void> {
    const { store } = this.d;
    const drop = (why: string) => store.setEventStatus(event.id, "dropped", why);

    if (isSelfCaused(event, this.d.clotLogin)) return drop("caused by the Clot itself");

    const clotName = this.d.clotForRepo(event.repo);
    const port = clotName === undefined ? undefined : this.d.clots.get(clotName);
    if (clotName === undefined || port === undefined) {
      console.warn(`[pipeline] no Clot is bound to ${event.repo}; event ${event.id} discarded`);
      return drop("no Clot is bound to this repository");
    }
    store.setEventClot(event.id, clotName);

    if (this.d.rulebook.isDropped(clotName, event)) return drop("matched a pre-filter");

    // One push often sets off several automated reports. They wait a little, to be judged and looked into as one.
    // A batch is the result of that wait, so it is not held again.
    if (event.automated && event.kind !== "batch") {
      store.setEventStatus(event.id, "held");
      this.held.add(clotName, event);
      return;
    }

    await this.proceed(clotName, port, event);
  }

  /** Takes the events held for one subject onward as a single event. Never throws. */
  private async release(clotName: string, events: ClotEvent[]): Promise<void> {
    const { store } = this.d;
    try {
      const port = this.d.clots.get(clotName);
      if (port === undefined) return;
      const { event, absorbed } = combine(events);
      if (event.kind === "batch") {
        store.insertEvent(event);
        store.setEventClot(event.id, clotName);
      } else {
        // No longer held: if what follows fails, it runs again at the next start.
        store.setEventStatus(event.id, "received");
      }
      for (const other of absorbed) store.setEventStatus(other.id, "merged", `into ${event.id}`);
      await this.proceed(clotName, port, event);
    } catch (error) {
      console.error(`[pipeline] releasing ${events.map((e) => e.id).join(", ")} failed:`, error);
    }
  }

  private async proceed(clotName: string, port: ClotPort, arrived: ClotEvent): Promise<void> {
    const { store, chat } = this.d;
    let event = arrived;
    const drop = (why: string) => store.setEventStatus(event.id, "dropped", why);

    // GitHub sends a review without its inline comments, which are often all it says.
    if (event.kind === "review") {
      event = await this.d.readInline(event).catch(() => event);
      if (event.body !== arrived.body) store.setEventBody(event.id, event.body);
    }

    const busy = port.isBusy();
    const verdict = await this.d.triage.judge({ event, guidance: this.d.rulebook.guidance(clotName), tail: busy ? store.tail(clotName, 4) : null });
    store.recordTriage(event.id, verdict.message, verdict.urgent);

    // Checked before "no action": triage usually says both of an injection attempt, and the user must still hear of it.
    if (verdict.suspicious) {
      const session = store.activeSession(clotName);
      if (session) {
        await chat.post(session.channelId, `Suspicious event, not acted on: ${verdict.message} <${event.url}>`).catch(() => undefined);
      }
      return drop("triage: suspicious");
    }

    if (!verdict.needsAction) return drop("triage: no action needed");

    // Still busy: the turn may have ended while triage was thinking.
    if (verdict.relevantNow && port.isBusy() && (await this.d.steering.ask(clotName, event, verdict.message))) return;

    await port.queueEvent(event, verdict.message);
  }
}
