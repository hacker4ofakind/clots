# Clots: PostHog through the generic Composio path

A follow-up to stage 2e (`2026-11-19-clots-stage-2e-composio-design.md`, `2026-11-21-clots-stage-2e-any-toolkit-design.md`). Own files, not part of 2e's.

## 1. Why

PostHog is the one built-in Composio toolkit that is only plumbing: a trigger list taken from the entry, one connection field (the region) and a 56-line mapper. It has no reads, no writes, no identity and no undo. Everything else about it is the generic path's job already. Keeping it built in means its entry has a strict shape of its own (`projectId`, `events`, `region`) that the Clots and the skill have to know apart from every other toolkit's, and that a Clot got wrong on 2026-11-22, which stopped the daemon.

Linear, Notion, Stripe and Google Calendar stay built in: they carry reads, writes with undo and review, identity, polling logic or enrichment that the generic path does not have.

## 2. What changes for the user

- PostHog's entry becomes a generic entry (section 3). The old keys `region`, `projectId` and `events` stop being accepted, with a message that says what to write instead.
- The events do not change: `source: posthog`, `kind: analytics_event`, `subject: posthog:<event>`, place = the project, `automated: true`, `outsider: true`, and the same event IDs, so rules written against them keep matching and a delivery repeated across the upgrade is still one event.
- New: the mapping is a recipe, so a Clot or the user can reshape PostHog's events (more properties in the body, a different title) with `rulebook_composio` like any toolkit's. A recipe saved for `posthog` overrides the shipped one.
- New: `composio_check_entry` validates a PostHog entry's trigger config against Composio's (it requires `project_id` and `event_names`), as it does for any generic toolkit.
- Deliveries of PostHog are kept as samples, like every generic toolkit's (newest 5 per trigger, 7 days, 64 KB). They carry distinct IDs and event properties.

## 3. The entry

```json
{ "toolkit": "posthog", "account": "prod", "clot": "truecast", "audience": "team",
  "apiKey": "CLOTS_POSTHOG_API_KEY",
  "connect": { "subdomain": "eu" },
  "triggers": [{ "slug": "POSTHOG_EVENT_CAPTURED", "config": { "project_id": 199582, "event_names": ["user_signed_up"] } }] }
```

`connect` is new, for any generic toolkit: connection fields whose values are not secrets, given in the entry itself (a region, an instance subdomain). They are merged into the fields of a key connection after the `.env` ones. A name the toolkit's key scheme does not have is refused, and a name in `connect` counts as given, so `apiKey` fills the one field left. `connect` is not part of the connection's hash: changing it does not replace the connection (as `region` does not today). The user replaces the connection with `&composio reconnect <toolkit>:<account>`.

The old shape gets its own refusal: an entry for `posthog` with `region`, `projectId` or `events` is refused with "PostHog is a generic entry now: put the region in connect.subdomain and the project and events in a POSTHOG_EVENT_CAPTURED trigger's config (project_id, event_names)". It is left out by the loader like any bad entry.

## 4. The shipped recipe

A recipe lives in the rulebook, which is the user's data, so an upgrade cannot rely on one being there. The daemon ships **default recipes**: data in code (`src/composio/default-recipes.ts`), one for `posthog`. `Rulebook.composioRecipe(toolkit)` returns the saved recipe if there is one and the shipped one otherwise. `rulebook_composio set` for `posthog` is now allowed and saves an override; `remove` of it falls back to the shipped one. Every consumer of `composioRecipe` (intake, `composio_try`, the enricher, `composio_samples` hints) gets this for free.

```yaml
toolkit: posthog
triggers:
  POSTHOG_EVENT_CAPTURED:
    kind: analytics_event
    id: "{payload.event.event}:{payload.event.distinct_id|payload.person.distinct_id}:{payload.event.timestamp}"
    actor: "{payload.event.distinct_id|payload.person.distinct_id}"
    title: "{payload.event.event} in PostHog ({payload.event.distinct_id|payload.person.distinct_id})"
    body: |
      PostHog event: {payload.event.event}
      Project: {payload.project.name|payload.project.id}
      Person: {payload.person.name|payload.person.distinct_id|payload.event.distinct_id}
      At: {payload.event.timestamp}
      {lines:payload.event.properties}
    url: "{payload.event.url|payload.person.url|payload.project.url}"
    ref: "{payload.event.event}"
    place: "{payload.project.name|payload.project.id}"
    subject: "posthog:{payload.event.event}"
    automatedWhen: {}
```

The event ID comes out as `posthog:<account>:<event>:<distinct>:<timestamp>`, the old form exactly. Differences from the old mapper, accepted: with no distinct ID the ID falls back to the delivery's (the old one had an empty part); with no timestamp the `At:` line is empty and not left out; with no person at all the `Person:` line is empty and not `unknown`. PostHog's payload always carries all three.

### The `{lines:path}` template

The one change to the recipe language: `{lines:<path>}` fills the object at the path as `key: value` lines, scalars only (string, number, boolean), keys beginning with `$` left out, at most 20 lines. An empty or missing object fills nothing. It is general (a Slack or Supabase payload's properties want the same) and replaces the old mapper's `propertyLines`. It works in every template field a path does and in `enrich` arguments; `pathsIn` and the recipe checker read the path after the `lines:`.

## 5. What is removed

`posthogDef` and `POSTHOG` (the slug moves into the shipped recipe's key), `posthogMapper` and `src/sources/posthog.ts`, `PostHogAccount`, the `posthog` schema in `COMPOSIO_TOOLKITS`, `posthog` from `BUILTIN_TOOLKITS`, and `posthog` from `SOURCE_KINDS` (a recipe may not name a built-in source, and PostHog's events now come from a recipe). Consequence: a rule with `source: posthog` is no longer checked against a fixed kind list; it matches whatever kinds the recipe makes. `connectExtra` on `ToolkitDef` is removed with its only user; the component merges the entry's `connect` instead. `sweep.ts`'s display name for PostHog stays.

## 6. Migration of the running daemon

Deploy the code first: until the Pi's config is changed the old-shape entry is left out with the message above, and everything else runs. Then change the entry to section 3's form (the home Clot can do it with `config_set`, which asks the user) and restart. The existing connection and its trigger are adopted: the key's hash is unchanged (a lone `generic_api_key` keeps the 2e formula), and the trigger's slug and config are the same, so Composio's trigger instance is kept rather than remade. If `project_id` or `event_names` differ from the stored trigger's config, the daemon's existing trigger sync replaces it.

## 7. Not in this change

Linear, Notion, Stripe and Google Calendar. Their mappers, enrichers, reads and inverses are not a recipe's job. Making a recipe able to name a toolkit that also has a built-in def is out: a toolkit is either built in or generic, and PostHog moves from the first to the second.
