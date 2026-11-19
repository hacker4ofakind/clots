import type { ToolkitDef } from "./index.js";

/** Composio's PostHog slugs. Creating the trigger needs a key with the `hog_function:write` scope. */
export const POSTHOG = {
  eventCaptured: "POSTHOG_EVENT_CAPTURED",
} as const;

export const posthogDef: ToolkitDef = {
  toolkit: "posthog",
  source: "posthog",
  async triggers(a) {
    return [{ slug: POSTHOG.eventCaptured, config: { project_id: a.projectId, event_names: a.events } }];
  },
  connectExtra: (a) => ({ subdomain: a.region ?? "us" }),
};
