import type { ClotEvent } from "./events/types.js";

/** Adds to an event what its source left out of the delivery. Never throws: what cannot be read is said in the body. */
export type Enricher = (event: ClotEvent) => Promise<ClotEvent>;

/** Hands an event to the enricher of its source, or to `fallback` when it has none (a Composio toolkit with a recipe). An event no enricher takes is returned as it is. */
export function enricherBySource(map: Record<string, Enricher>, fallback?: Enricher): Enricher {
  return async (event) => {
    const enrich = Object.hasOwn(map, event.source) ? map[event.source] : fallback;
    return enrich === undefined ? event : enrich(event);
  };
}
