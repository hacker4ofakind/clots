import { parseComposioRecipe, type ComposioRecipe } from "../rulebook.js";

/**
 * The Composio recipes the daemon ships, for a toolkit whose mapping is only plumbing: data, in the recipe language
 * (spec `2026-11-22-clots-posthog-generic-design.md`, section 4). A recipe saved in the rulebook for the same
 * toolkit is used instead (`Rulebook.composioRecipe`); removing it brings the shipped one back.
 */
const DEFAULT_RECIPE_DATA: Record<string, unknown> = {
  // PostHog's `Event Captured`: its payload carries no event ID, so the ID is the event's name, person and time.
  posthog: {
    toolkit: "posthog",
    triggers: {
      POSTHOG_EVENT_CAPTURED: {
        kind: "analytics_event",
        id: "{payload.event.event}:{payload.event.distinct_id|payload.person.distinct_id}:{payload.event.timestamp}",
        actor: "{payload.event.distinct_id|payload.person.distinct_id}",
        title: "{payload.event.event} in PostHog ({payload.event.distinct_id|payload.person.distinct_id})",
        body: [
          "PostHog event: {payload.event.event}",
          "Project: {payload.project.name|payload.project.id}",
          "Person: {payload.person.name|payload.event.distinct_id|payload.person.distinct_id}",
          "At: {payload.event.timestamp}",
          "{lines:payload.event.properties}",
        ].join("\n"),
        url: "{payload.event.url|payload.person.url|payload.project.url}",
        ref: "{payload.event.event}",
        place: "{payload.project.name|payload.project.id}",
        subject: "posthog:{payload.event.event}",
        // Whoever uses the product writes the event, so it is automated.
        automatedWhen: {},
      },
    },
  },
};

const parsed = new Map<string, ComposioRecipe>();

/** The names of the toolkits that have a shipped recipe. */
export const defaultRecipeToolkits = (): string[] => Object.keys(DEFAULT_RECIPE_DATA);

/**
 * The shipped recipe for a toolkit, if there is one. Parsed on first use (not when this module loads, which the
 * rulebook's own loading would run into), so a recipe that does not fit is for the tests to catch.
 */
export function defaultRecipe(toolkit: string): ComposioRecipe | undefined {
  if (!Object.hasOwn(DEFAULT_RECIPE_DATA, toolkit)) return undefined;
  let recipe = parsed.get(toolkit);
  if (recipe === undefined) {
    recipe = parseComposioRecipe(DEFAULT_RECIPE_DATA[toolkit]);
    parsed.set(toolkit, recipe);
  }
  return recipe;
}
