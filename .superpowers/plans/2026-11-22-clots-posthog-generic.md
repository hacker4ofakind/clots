# Clots: PostHog through the generic Composio path: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. This plan gives structure and decisions, not code. You write the implementation (TDD per task). Track tasks with the checkboxes. After all tasks, run the **Manual Verification Checklist**, then fill in **Implementation Notes**.

**Goal:** PostHog is configured and mapped by the generic Composio path: a generic entry with `connect`, a shipped default recipe, and a `{lines:path}` template.
**Spec:** `.superpowers/specs/2026-11-22-clots-posthog-generic-design.md` ("section N" below). A follow-up to stage 2e; read its two specs' recipe sections first.
**Architecture:** The generic entry schema gains `connect`. `Rulebook.composioRecipe` falls back to recipes shipped in code. The recipe language gains `{lines:path}` in `src/paths.ts`. PostHog's built-in def, mapper, schema and source-kind entry are deleted.
**Tech Stack:** as stage 2e. No dependency changes.

## Global Constraints

- Open Docker Desktop before any work, and check that `docker info` succeeds.
- The events PostHog makes do not change (spec section 2): the parity test in Task 3 is the proof, built from `tests/posthog.test.ts`'s payload and expected event before that file is deleted.
- Spec and plan describe the design as built: when the build changes a decision, edit them in place, with no change notes.
- `src/commands.ts` and `tests/commands.test.ts` are CRLF; this change does not touch them.
- Work on branch `posthog-generic`; one commit at the end; open a PR; do not merge without the user's yes.

## File Map

- `src/paths.ts` (modify): `{lines:path}` in `fillPaths`, `fillKey`, `pathsIn`.
- `src/rulebook.ts` (modify): the recipe checker's path check understands `lines:`; `composioRecipe` falls back to the shipped recipe; `rulebook_composio` may set or remove `posthog`'s.
- `src/composio/default-recipes.ts` (create): the shipped recipes, as data, parsed on first use (`defaultRecipe(toolkit)`).
- `src/config.ts` (modify): `connect` on generic entries; the legacy PostHog message; `posthog` schema and `PostHogAccount` removed; `ComposioAccount` carries `connect`.
- `src/composio/auth.ts`, `component.ts`, `toolkits/index.ts` (modify): `connect` replaces `connectExtra`.
- `src/events/kinds.ts` (modify): `posthog` out of `SOURCE_KINDS` and `BUILTIN_TOOLKITS`.
- `src/composio/toolkits/posthog.ts`, `src/sources/posthog.ts` (delete); `src/daemon.ts`, `src/composio/authoring.ts` (modify where they name them).
- `tests/posthog.test.ts` (replace by a recipe parity test), `tests/config.test.ts`, `tests/composio-*.test.ts` (adjust), `tests/paths.test.ts` (add).
- `plugin/skills/composio-integration/SKILL.md`, `README.md`, `clots.config.example.json`, `scripts/spike-2e.ts` (modify): PostHog as a generic entry.

## Tasks

### Task 1: `{lines:path}`
- [x] Test first (`tests/paths.test.ts`): an object fills as `key: value` lines; non-scalars and `$`-keys skipped; at most 20; a missing or empty object fills nothing and leaves no blank line in a body; `pathsIn` returns the path without the prefix; the recipe checker accepts `lines:` paths in `body` and in `enrich` args.
- [x] Implement in `src/paths.ts`; keep `show` for every other path.

### Task 2: `connect`
- [x] Tests (`config.test.ts`, `composio-auth.test.ts`, `composio-component.test.ts`): a generic entry accepts `connect` (record of non-empty strings); the legacy PostHog keys are refused with section 3's message; `chooseAuth` treats `connect` names as provided and refuses one the scheme lacks; the connection is made with the `.env` fields plus `connect`; `connect` is not in `authHash`; a lone `generic_api_key` PostHog connection keeps its 2e hash.
- [x] Implement; remove `connectExtra` from `ToolkitDef` and its callers.

### Task 3: the shipped recipe and its parity
- [x] Before deleting `tests/posthog.test.ts`, copy its payload and expected events into the new parity test, which renders the shipped `posthog` recipe with `renderRecipe` and expects the same event as the old mapper made, for its cases: a full event, a repeated delivery (same ID), no project name (place falls back to the project ID, then the account), a `$`-property and a nested property left out, more than 20 properties. List the accepted differences from spec section 4 as cases of their own.
- [x] Create `default-recipes.ts` with section 4's recipe as data, parsed by `parseComposioRecipe` on first use, and a test that parses every shipped recipe, so a bad one fails the tests, not the daemon.
- [x] `Rulebook.composioRecipe` returns the saved recipe first, the shipped one otherwise; `recipeFile` says so for it; `rulebook_composio` accepts `posthog` (the refusal list loses it), and removing a saved override falls back. Tests for each, and that `composio_try` and intake use the shipped recipe with no rulebook entry.

### Task 4: delete the built-in
- [x] Remove `posthogDef`, `POSTHOG`, `posthogMapper`, `src/sources/posthog.ts`, the config schema, `PostHogAccount`, and the entries in `BUILTIN_TOOLKITS` and `SOURCE_KINDS`; fix every reference the compiler and tests find (`daemon.ts` mappers, `component.ts`, `authoring.ts`, `rulebook.ts`'s refusal text; `sweep.ts`'s name stays).
- [x] Tests: an end-to-end intake test with a generic PostHog account and no saved recipe makes the same event; a rule `source: posthog, kind: analytics_event` still matches it; `rulebook_composio` for `linear` is still refused.

### Task 5: documentation and skill
- [x] `SKILL.md`: PostHog leaves the built-in list and its section; add the generic PostHog entry as an example with `connect`, and the nuances (personal API key with `hog_function:write`, the region is `connect.subdomain`, `project_id` is the number in the project's URL, `event_names`). `README.md`, `clots.config.example.json` and `scripts/spike-2e.ts` likewise. Adjust `plugin-install.test.ts` where it names PostHog.

### Task 6: verify and ship
- [x] Full suite and `tsc` pass. One commit, PR.
- [ ] Deploy order (spec section 6): deploy, check the Pi's log says the old-shape entry is left out with the new message, change the entry, restart.

## Manual Verification Checklist

1. On the Pi after deploy and the entry change: the log shows `PostHog (prod) connected, holding 1 trigger: POSTHOG_EVENT_CAPTURED` with no new connection made (the connection id in `composio_accounts` is unchanged).
2. Trigger `user_signed_up` on Truecast's production site. The new row in `events` has the same columns as the 2026-11-22 17:25 one (`source posthog`, `kind analytics_event`, `automated 1`, `outsider 1`, `place Truecast`, a body with `method: email`), and an ID of the same form.
3. Ask the home Clot to run `composio_try` on PostHog's recipe with the kept sample; it renders the same event.
4. Ask a Clot to add the event's `plan` property to the title; `rulebook_composio set` for `posthog` is accepted and the next event follows it; `&rules undo` returns to the shipped one.

## Implementation Notes

Built on branch `posthog-generic`; the full suite and `tsc` pass. The deploy-order bullet of Task 6 is the user's, after deploy: it stays unticked, and Manual Verification steps 1-4 are production steps for the same reason.

**Final names and where the plan was adjusted**
- `default-recipes.ts` keeps the recipes as plain data and exports `defaultRecipe(toolkit)` (parsed on first use, cached) and `defaultRecipeToolkits()`. It is not parsed when the module loads: `rulebook.ts` imports it and it imports `parseComposioRecipe` from `rulebook.ts`, so a load-time parse would run into the import cycle. `tests/composio-default-recipes.test.ts` parses every shipped recipe, which is where a bad one fails.
- `Rulebook.recipeFile(name)` returns `{ file: "", kind: "composio", shipped: true }` for a toolkit with only the shipped recipe. `daemon.ts` passes `file || undefined` to `ComposioAuthoring`, so a recipe set in a file is never reported as shadowed by the shipped one.
- `chooseAuth(entry, info)` lost its third argument: the entry's `connect` names count as given. It also refuses `connect` with `oauthApp`, with no key, a name the scheme lacks, and a name that is also in `fields`. The config schema refuses `connect` without `apiKey` or `fields`. `entryAuthKey` includes the sorted names of `connect` (only when there is one, so other entries keep their earlier key) so that a changed set of names makes the auth choice be made again. Values of `connect` are in neither hash.
- The legacy PostHog refusal is `legacyProblem` in `config.ts`, checked before the schema in both `loadConfig` and `composioEntryProblems` (so `composio_check_entry` and `config_set` give the same message). The loaded error reads `sources.composio[i]: PostHog is a generic entry now: ...`.
- Spec section 4's recipe changed in one line: `Person:` reads `person.name | event.distinct_id | person.distinct_id` (the old mapper's order). The accepted differences list grew (spec section 4): the ID falls back with any of event name, distinct ID or timestamp missing; an empty `Project:` line; the title's empty parentheses; a payload with no event name is still an event; an empty string counts as present in `{a|b}`. A differential run of the old mapper against the recipe over about 1,500 generated payloads that have a project and a distinct ID found no other difference; that run is not kept.
- `tests/posthog.test.ts` became `tests/generic-mapper.test.ts` (the generic mapper's two tests were in it); the parity tests are in `tests/composio-default-recipes.test.ts`, the end-to-end intake through the generic path with no saved recipe in `tests/composio-posthog.test.ts`.
- `plugin-install.test.ts` names PostHog nowhere, so it needed no change. `scripts/spike-2e.ts` (CRLF) only connects a key and a subdomain by hand and never read an entry's shape, so it is unchanged. The composio-integration skill shows the shipped recipe for a Clot to copy and change; a test keeps that block equal to the shipped one. `config.test.ts` also checks that every Composio entry in `clots.config.example.json` fits.

**Surprises and notes for what follows**
- `composio_try` takes the draft recipe as a parameter, so a Clot reshaping PostHog needs the shipped recipe's text: it is in the skill, not in a rulebook file. A later change could let `composio_try` default to the recipe in force.
- A rule `source: posthog` is no longer checked against a kind list: a typo in its `kind` is accepted and never matches.
- The `no-event-name` payload and the empty-string cases are tested as accepted differences.
- On the Pi: until its entry is changed, the old-shape entry is left out with the new message (`loadConfigLeaving`), so PostHog events pause between deploy and the `config_set` plus restart.
