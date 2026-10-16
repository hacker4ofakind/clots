import { MAX_BODY } from "./github.js";
import type { ClotEvent } from "./types.js";

export { MAX_BODY };

/** Text cut to a length, saying that it was cut. */
export function clip(text: string, max = MAX_BODY): string {
  return text.length > max ? `${text.slice(0, max)}\n[truncated]` : text;
}

/** The event with a block of text added to its body, inside the usual length limit. */
export function appendBody(event: ClotEvent, block: string): ClotEvent {
  if (block === "") return event;
  return { ...event, body: clip(event.body.trim() === "" ? block : `${event.body}\n\n${block}`) };
}
