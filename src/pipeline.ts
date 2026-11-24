import type { Conversation } from "./conversation/conversation.js";
import type { Enricher } from "./enrich.js";
import { combine } from "./events/batch.js";
import { linkTo } from "./events/format.js";
import type { ClotEvent } from "./events/types.js";
import { Hold } from "./hold.js";
import type { Route } from "./routing.js";
import type { Store } from "./store.js";
import type { Triage } from "./triage.js";

/** The part of a Clot that the pipeline and hand-overs need. */
export interface ClotPort {
  isBusy(): boolean;
  queueEvent(event: ClotEvent, notice: string, kick?: boolean): Promise<void>;
}

export interface PipelineDeps {
  store: Store;
  conv: Conversation;
  /** One file's pre-filters ("global", or a Clot's name), and the triage guidance for a Clot. */
  rulebook: { dropsIn(name: string, event: ClotEvent): boolean; guidance(clot: string): string };
  triage: Triage;
  clots: Map<string, ClotPort>;
  /** Picks the Clot for an event. */
  route: (event: ClotEvent) => Promise<Route>;
  /** Whether the Clots caused the event themselves. Sources that know it on arrival drop the event there instead. */
  selfCaused: (event: ClotEvent) => boolean;
  /** Adds what the source left out of the delivery: a review's inline comments, a payment's customer. */
  enrich: Enricher;
  /** How long automated events are held to be gathered: after the last one, and at most after the first. */
  hold: { quietMs: number; capMs: number };
  now: () => number;
  /** Runs fn after ms; the returned function cancels it. */
  schedule: (ms: number, fn: () => void) => () => void;
}

/** Takes a stored event from arrival to its outcome: dropped, held, or queued for the Clot. */
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
      const key = `${event.clot}\n${event.place}\n${event.subject}`;
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

  private async run(received: ClotEvent): Promise<void> {
    const { store } = this.d;
    const drop = (why: string) => store.setEventStatus(received.id, "dropped", why);

    if (this.d.selfCaused(received)) return drop("caused by the Clot itself");
    // Before the rules and routing, which match on the title: a Notion delivery has none until its page is read.
    const event = await this.withEnrichment(received);
    // Before routing, so an event the global file drops costs no routing call.
    if (this.d.rulebook.dropsIn("global", event)) return drop("matched a pre-filter");

    const route = await this.d.route(event);
    const clotName = route.clot;
    const port = clotName === undefined ? undefined : this.d.clots.get(clotName);
    if (clotName === undefined || port === undefined) {
      console.warn(`[pipeline] event ${event.id} from ${event.source} (${event.place}) goes to no Clot: ${route.how}`);
      return drop(route.how);
    }
    store.setEventClot(event.id, clotName);

    if (this.d.rulebook.dropsIn(clotName, event)) return drop("matched a pre-filter");

    // One push often sets off several automated reports. They wait a little, to be judged and looked into as one.
    // A batch is the result of that wait, so it is not held again.
    if (event.automated && event.kind !== "batch") {
      store.setEventStatus(event.id, "held");
      this.held.add(clotName, event);
      return;
    }

    await this.proceed(clotName, port, event);
  }

  /**
   * Adds what the source left out of the delivery, once, and keeps it: a review's inline
   * comments, a payment's customer, a Notion page's title, content and author. A batch is made
   * of events that were each enriched before they were combined.
   */
  private async withEnrichment(event: ClotEvent): Promise<ClotEvent> {
    if (event.kind === "batch" || this.d.store.isEnriched(event.id)) return event;
    const read = await this.d.enrich(event).catch(() => event);
    this.d.store.setEventBody(event.id, read.body);
    if (read.title !== event.title) this.d.store.setEventTitle(event.id, read.title);
    if (read.actor !== event.actor) this.d.store.setEventActor(event.id, read.actor);
    return read;
  }

  /** Takes the events held for one subject onward as a single event. Never throws. */
  private async release(clotName: string, events: ClotEvent[]): Promise<void> {
    const { store } = this.d;
    try {
      const port = this.d.clots.get(clotName);
      if (port === undefined) return;
      // Each report is enriched before the events are combined, or a batch would leave out what was read for it.
      const read: ClotEvent[] = [];
      for (const held of events) read.push(await this.withEnrichment(held));
      const { event, absorbed } = combine(read);
      // No longer held: if what follows fails, the event that goes on runs again at the next start.
      store.recordRelease({ event, clot: clotName, isNew: event.kind === "batch", absorbed: absorbed.map((other) => other.id) });
      await this.proceed(clotName, port, event);
    } catch (error) {
      console.error(`[pipeline] releasing ${events.map((e) => e.id).join(", ")} failed:`, error);
    }
  }

  private async proceed(clotName: string, port: ClotPort, event: ClotEvent): Promise<void> {
    const { store, conv } = this.d;
    const drop = (why: string) => store.setEventStatus(event.id, "dropped", why);

    const verdict = await this.d.triage.judge({ clot: clotName, event, guidance: this.d.rulebook.guidance(clotName) });
    store.recordTriage(event.id, verdict.message, verdict.urgent);

    // Checked before "no action": triage usually says both of an injection attempt, and the user must still hear of it.
    if (verdict.suspicious) {
      await conv.post(clotName, `Suspicious event, not acted on: ${verdict.message}${linkTo(event.url)}`, { kind: "note" }).catch(() => undefined);
      return drop("triage: suspicious");
    }

    if (!verdict.needsAction) return drop("triage: no action needed");

    await port.queueEvent(event, verdict.message);
  }
}
