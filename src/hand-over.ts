import type { ClotPort } from "./steering.js";
import type { Store } from "./store.js";

export interface HandOverDeps {
  store: Store;
  clots: Map<string, ClotPort>;
  /** Posts in a Clot's live channel. Never throws. */
  say: (clot: string, text: string) => Promise<void>;
}

/**
 * Moves an event the user says belongs elsewhere to the right Clot, where it joins the queue
 * as an event of its own with the message triage wrote. Triage does not run again.
 */
export async function handOver(d: HandOverDeps, from: string, eventId: string, to: string): Promise<string> {
  const event = d.store.getEvent(eventId);
  if (!event) return `Refused: there is no event with the ID ${eventId}. Use the id line of the event's block.`;
  if (event.clot !== from) return "Refused: that event was not routed to you.";
  if (to === from) return "Refused: the event is already yours.";
  const port = d.clots.get(to);
  if (!port) return `Refused: there is no Clot named ${to}. The Clots are: ${[...d.clots.keys()].join(", ")}.`;
  d.store.setEventClot(event.id, to);
  // Still waiting in this Clot's queue, it would be looked into here as well. One already running is left to its turn.
  d.store.withdrawPendingEvent(from, event.id);
  await d.say(from, `Moved to ${to} at your request: ${event.title}`);
  await port.queueEvent(event, `Moved here from ${from} at the user's request: ${event.triageMessage ?? event.title}`);
  return `Handed to ${to}. If this shows a pattern (every mail to one address, a word in every title), propose a routing rule with rulebook_routing.`;
}
