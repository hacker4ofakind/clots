import type { Mapper } from "../composio/intake.js";
import { clip } from "../events/body.js";

/** "SLACK_RECEIVE_MESSAGE" as "Receive message": the trigger's name, without its toolkit. */
function triggerName(slug: string, toolkit: string): string {
  const words = slug.toLowerCase().split("_");
  if (words[0] === toolkit.toLowerCase()) words.shift();
  const name = words.join(" ");
  return name === "" ? slug : name.charAt(0).toUpperCase() + name.slice(1);
}

/**
 * Turns a delivery of any toolkit with no mapper of its own into an event of kind `trigger`: its source is
 * the toolkit, its title the trigger's name and its body the payload. Nothing here can tell who wrote the
 * payload, so the event counts as an outsider's: a write in a turn it starts goes to the reviewer. The ID
 * is the delivery's, since a payload names nothing of the service's to key on.
 */
export const genericMapper: Mapper = (account, slug, payload, webhookId, receivedAt) => {
  if (slug === "") return undefined;
  const body = typeof payload === "string" ? payload : JSON.stringify(payload ?? null, null, 2);
  return {
    actorId: "",
    event: {
      id: `composio:${webhookId}`,
      source: account.toolkit,
      account: account.account,
      kind: "trigger",
      place: account.account,
      actor: "unknown",
      title: triggerName(slug, account.toolkit),
      body: clip(body),
      url: "",
      ref: slug,
      subject: `${account.toolkit}:${slug}`,
      automated: false,
      outsider: true,
      receivedAt,
    },
  };
};
