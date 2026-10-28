import type { ClotEvent } from "./types.js";

/** " <url>" to end a line in chat with, or nothing for an event whose source gives no link (a reminder, mail from a server other than Gmail). */
export function linkTo(url: string): string {
  return url === "" ? "" : ` <${url}>`;
}

/** Keeps text from an event from closing the block it is wrapped in. */
function safe(text: string): string {
  return text.replaceAll("</event>", "<\\/event>");
}

/**
 * The event as the Clot and the models see it: fields, then the body, inside one marked block.
 * The ID is how the Clot names the event to a daemon tool.
 */
export function formatEvent(event: ClotEvent, timeZone: string): string {
  const time = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit" }).format(new Date(event.receivedAt));
  return [
    `<event source="${safe(event.source)}" received="${time}">`,
    `id: ${safe(event.id)}`,
    `account: ${safe(event.account)}`,
    `kind: ${safe(event.kind)}`,
    `place: ${safe(event.place)}`,
    `actor: ${safe(event.actor)}`,
    ...(event.outsider ? ["from: an outsider"] : []),
    `title: ${safe(event.title)}`,
    `url: ${safe(event.url)}`,
    `ref: ${safe(event.ref)}`,
    "",
    safe(event.body),
    "</event>",
  ].join("\n");
}
