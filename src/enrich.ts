import type { ClotEvent } from "./events/types.js";

/** Adds to an event what its source left out of the delivery. Never throws: what cannot be read is said in the body. */
export type Enricher = (event: ClotEvent) => Promise<ClotEvent>;

/** Hands an event to the enricher of its source. An event from a source with none is returned as it is. */
export function enricherBySource(map: Record<string, Enricher>): Enricher {
  return async (event) => {
    const enrich = map[event.source];
    return enrich === undefined ? event : enrich(event);
  };
}
