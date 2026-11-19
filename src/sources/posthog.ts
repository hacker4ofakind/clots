import type { Mapper } from "../composio/intake.js";
import { POSTHOG } from "../composio/toolkits/posthog.js";
import { clip } from "../events/body.js";

const text = (value: unknown): string => (typeof value === "string" ? value : "");

/** A property map as a few readable lines: scalars only, and none of PostHog's own `$`-prefixed enrichment. */
function propertyLines(properties: unknown): string[] {
  if (typeof properties !== "object" || properties === null) return [];
  return Object.entries(properties as Record<string, unknown>)
    .filter(([key, value]) => !key.startsWith("$") && (typeof value === "string" || typeof value === "number" || typeof value === "boolean"))
    .slice(0, 20)
    .map(([key, value]) => `${key}: ${String(value)}`);
}

/**
 * Turns Composio's PostHog `Event Captured` trigger into the `analytics_event` of 2c: `place` is the
 * project, `subject` is `posthog:<event name>`, `actor` is the person's distinct ID. Automated, and from
 * an outsider: whoever uses the product writes its properties. PostHog's payload carries no event ID, so
 * the ID is the event's name, person and time.
 */
export const posthogMapper: Mapper = (account, slug, payload, _webhookId, receivedAt) => {
  if (slug !== POSTHOG.eventCaptured || typeof payload !== "object" || payload === null) return undefined;
  const p = payload as Record<string, any>;
  const e: Record<string, any> = p.event ?? {};
  const name = text(e.event);
  if (name === "") return undefined;
  const distinct = text(e.distinct_id) || text(p.person?.distinct_id);
  const project = text(p.project?.name) || String(p.project?.id ?? "") || account.account;
  const lines = [
    `PostHog event: ${name}`,
    `Project: ${project}`,
    `Person: ${text(p.person?.name) || distinct || "unknown"}`,
    ...(text(e.timestamp) ? [`At: ${text(e.timestamp)}`] : []),
    ...propertyLines(e.properties),
  ];
  return {
    actorId: "",
    event: {
      id: `posthog:${account.account}:${name}:${distinct}:${text(e.timestamp)}`,
      source: "posthog",
      account: account.account,
      kind: "analytics_event",
      place: project,
      actor: distinct || "unknown",
      title: `${name} in PostHog${distinct ? ` (${distinct})` : ""}`,
      body: clip(lines.join("\n")),
      url: text(e.url) || text(p.person?.url) || text(p.project?.url),
      ref: name,
      subject: `posthog:${name}`,
      automated: true,
      outsider: true,
      receivedAt,
    },
  };
};
