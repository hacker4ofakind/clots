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
- `src/composio/default-recipes.ts` (create): the shipped recipes, as parsed data.
- `src/config.ts` (modify): `connect` on generic entries; the legacy PostHog message; `posthog` schema and `PostHogAccount` removed; `ComposioAccount` carries `connect`.
- `src/composio/auth.ts`, `component.ts`, `toolkits/index.ts` (modify): `connect` replaces `connectExtra`.
- `src/events/kinds.ts` (modify): `posthog` out of `SOURCE_KINDS` and `BUILTIN_TOOLKITS`.
- `src/composio/toolkits/posthog.ts`, `src/sources/posthog.ts` (delete); `src/daemon.ts`, `src/composio/authoring.ts` (modify where they name them).
- `tests/posthog.test.ts` (replace by a recipe parity test), `tests/config.test.ts`, `tests/composio-*.test.ts` (adjust), `tests/paths.test.ts` (add).
- `plugin/skills/composio-integration/SKILL.md`, `README.md`, `clots.config.example.json`, `scripts/spike-2e.ts` (modify): PostHog as a generic entry.

## Tasks

### Task 1: `{lines:path}`
- [ ] Test first (`tests/paths.test.ts`): an object fills as `key: value` lines; non-scalars and `$`-keys skipped; at most 20; a missing or empty object fills nothing and leaves no blank line in a body; `pathsIn` returns the path without the prefix; the recipe checker accepts `lines:` paths in `body` and in `enrich` args.
- [ ] Implement in `src/paths.ts`; keep `show` for every other path.

### Task 2: `connect`
- [ ] Tests (`config.test.ts`, `composio-auth.test.ts`, `composio-component.test.ts`): a generic entry accepts `connect` (record of non-empty strings); the legacy PostHog keys are refused with section 3's message; `chooseAuth` treats `connect` names as provided and refuses one the scheme lacks; the connection is made with the `.env` fields plus `connect`; `connect` is not in `authHash`; a lone `generic_api_key` PostHog connection keeps its 2e hash.
- [ ] Implement; remove `connectExtra` from `ToolkitDef` and its callers.

### Task 3: the shipped recipe and its parity
- [ ] Before deleting `tests/posthog.test.ts`, copy its payload and expected events into the new parity test, which renders the shipped `posthog` recipe with `renderRecipe` and expects the same event as the old mapper made, for its cases: a full event, a repeated delivery (same ID), no project name (place falls back to the project ID, then the account), a `$`-property and a nested property left out, more than 20 properties. List the accepted differences from spec section 4 as cases of their own.
- [ ] Create `default-recipes.ts` with section 4's recipe, parsed by `parseComposioRecipe` at load so a bad one fails the tests, not the daemon.
- [ ] `Rulebook.composioRecipe` returns the saved recipe first, the shipped one otherwise; `recipeFile` says so for it; `rulebook_composio` accepts `posthog` (the refusal list loses it), and removing a saved override falls back. Tests for each, and that `composio_try` and intake use the shipped recipe with no rulebook entry.

### Task 4: delete the built-in
- [ ] Remove `posthogDef`, `POSTHOG`, `posthogMapper`, `src/sources/posthog.ts`, the config schema, `PostHogAccount`, and the entries in `BUILTIN_TOOLKITS` and `SOURCE_KINDS`; fix every reference the compiler and tests find (`daemon.ts` mappers, `component.ts`, `authoring.ts`, `rulebook.ts`'s refusal text; `sweep.ts`'s name stays).
- [ ] Tests: an end-to-end intake test with a generic PostHog account and no saved recipe makes the same event; a rule `source: posthog, kind: analytics_event` still matches it; `rulebook_composio` for `linear` is still refused.

### Task 5: documentation and skill
- [ ] `SKILL.md`: PostHog leaves the built-in list and its section; add the generic PostHog entry as an example with `connect`, and the nuances (personal API key with `hog_function:write`, the region is `connect.subdomain`, `project_id` is the number in the project's URL, `event_names`). `README.md`, `clots.config.example.json` and `scripts/spike-2e.ts` likewise. Adjust `plugin-install.test.ts` where it names PostHog.

### Task 6: verify and ship
- [ ] Full suite and `tsc` pass. One commit, PR.
- [ ] Deploy order (spec section 6): deploy, check the Pi's log says the old-shape entry is left out with the new message, change the entry, restart.

## Manual Verification Checklist

1. On the Pi after deploy and the entry change: the log shows `PostHog (prod) connected, holding 1 trigger: POSTHOG_EVENT_CAPTURED` with no new connection made (the connection id in `composio_accounts` is unchanged).
2. Trigger `user_signed_up` on Truecast's production site. The new row in `events` has the same columns as the 2026-11-22 17:25 one (`source posthog`, `kind analytics_event`, `automated 1`, `outsider 1`, `place Truecast`, a body with `method: email`), and an ID of the same form.
3. Ask the home Clot to run `composio_try` on PostHog's recipe with the kept sample; it renders the same event.
4. Ask a Clot to add the event's `plan` property to the title; `rulebook_composio set` for `posthog` is accepted and the next event follows it; `&rules undo` returns to the shipped one.

## Implementation Notes

(Filled in after the build.)
