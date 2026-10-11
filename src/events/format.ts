import type { ClotEvent } from "./types.js";

/** Keeps text from an event from closing the block it is wrapped in. */
function safe(text: string): string {
  return text.replaceAll("</event>", "<\\/event>");
}

/** The event as the Clot and the triage model see it: fields, then the body, inside one marked block. */
export function formatEvent(event: ClotEvent, timeZone: string): string {
  const time = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit" }).format(new Date(event.receivedAt));
  return [
    `<event source="${event.source}" received="${time}">`,
    `kind: ${event.kind}`,
    `repo: ${safe(event.repo)}`,
    `actor: ${safe(event.actor)}`,
    `title: ${safe(event.title)}`,
    `url: ${safe(event.url)}`,
    `ref: ${safe(event.ref)}`,
    "",
    safe(event.body),
    "</event>",
  ].join("\n");
}
