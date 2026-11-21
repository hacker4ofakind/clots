# Clots stage 2e: Composio — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. This plan gives structure and decisions, not code. You write the implementation (TDD per task). Track tasks with the checkboxes. After all tasks, run the **Manual Verification Checklist** (or hand it to the user if they asked to do it), then fill in **Implementation Notes**.

**Goal:** Stripe, Linear, Notion, Google Calendar and PostHog reach the Clots through Composio with the Clots' own keys (Notion's events keep stage 2c's own webhook, because Composio's Notion triggers need an OAuth app that an API-key connection lacks), and the main session can act in any Composio-connected account, rated by the account's audience, Composio's tags, a fixed list and a Haiku 5.5 reviewer.
**Specs:** `.superpowers/specs/2026-11-19-clots-stage-2e-composio-design.md`; parent `.superpowers/specs/2026-10-10-clots-design.md` (sections 2, 7, 9, 16, 18).
**Architecture:** One `Composio` component in the daemon wraps `@composio/core` behind a small `ComposioApi` interface (faked in tests). It reconciles auth configs, connections, trigger instances and the webhook subscription with `sources.composio` at startup and daily. `/webhooks/composio` verifies, finds the account and hands the payload to a per-toolkit mapper that produces the same common events the 2c adapters did. The existing enrichers, senders, calendar tools and `&calendar undo` keep their logic; only their transport changes from each service's HTTP API to Composio tool calls. Two new daemon tools, `composio_find` and `composio_run`, go through a pure rating function and, where it says so, the write reviewer or a new `composio` ask kind.
**Tech Stack:** TypeScript on Node, `@anthropic-ai/claude-agent-sdk` (^0.3.296), `@composio/core` 0.28.0 (new), better-sqlite3, zod 4, vitest.

## Global Constraints

- Open Docker Desktop before any work, and check that `docker info` succeeds.
- Development environment: the local one (parent section 15). If the user says this session runs in a Claude Code cloud environment, first measure CPU, memory, disk and whether Docker can start a container, compare with what one Clot needs (the daemon, one container running Claude Code, a project build, Chromium), and stop and tell the user if it falls short.
- Install exactly `npm install @composio/core@0.28.0 --save-exact` (released 2026-11-03; 0.29 and 0.30 are too new to pin). Remove `ical.js` with `npm uninstall ical.js` once Task 6 no longer imports it. No other dependency changes; never a broad update. npm regenerates the lockfile; never edit it.
- `COMPOSIO_API_KEY` is read by the daemon only. It must never be passed to a container, a session's environment, a log line or chat.
- Reviewer model: `HAIKU` from `src/models.ts`, effort `medium`, through `structuredQuery` like the routing call.
- Webhook replay window: 300 s. Event IDs: `<source>:<account>:<the service's own ID>` where the payload gives one (2c's IDs), else `composio:<webhook-id>`.
- Node: `@composio/core` needs Node ≥ 22.22.3 (`engines.node`). The dev machine runs 25.1.0; the README's requirement becomes "Node 22.22.3 or later".
- Default audience: `public`.
- Spec and plan describe the design as built: when the build changes a decision, edit them in place, with no change notes. The same goes for the 2c spec sections that 2e replaces only if the parent design would otherwise contradict the code; the 2c spec otherwise stays as the record of stage 2c.
- `src/commands.ts` and `tests/commands.test.ts` are stored with CRLF; keep them that way.
- Commit once at the end (Task 9), on branch `stage-2e`. Do not push.

## File Map

- `scripts/spike-2e.ts` (create, Task 1): live probes for spec section 17. Kept.
- `scripts/capture-2e.ts` (create, Task 1): prints and saves raw Composio deliveries for one account, for fixtures.
- `src/composio/api.ts` (create): `ComposioApi` interface, its `@composio/core` implementation, the result types, and the pure exported `classifyComposioError(e): ExecResult["reason"]`. The only file that imports `@composio/core`.
- `src/composio/toolkits/{stripe,linear,notion,googlecalendar,posthog,generic}.ts` (create): one `ToolkitDef` per toolkit (below), the single home of every toolkit-specific slug, trigger set, identity reader and inverse. The mapper/enricher/sender bodies live in `src/sources/*` as listed; the def wires them.
- `src/composio/actions.ts` (create): the one `executeWrite` used by `composio_run`, the ask's yes and nothing else; the limits; the own-writes record.
- `src/composio/store.ts` (create): the Composio tables and their methods, given the `Store`'s database handle (keeps `src/store.ts` from growing).
- `src/composio/meter.ts` (create): monthly counts of tool calls and deliveries, and the 70%/90% warnings.
- `src/composio/component.ts` (create): `Composio` class: reconcile, sessions, `run`, identities, daily trigger check, failure reports.
- `src/composio/intake.ts` (create): `/webhooks/composio` handler and the trigger-to-mapper dispatch.
- `src/composio/rating.ts` (create): `rateComposioCall`, the fixed list, `isDestructive`. Pure.
- `src/composio/reviewer.ts` (create): `WriteReviewer`, its prompt, schema and SDK implementation.
- `src/composio/undo.ts` (create): the inverse table and `ComposioUndo` for `&composio undo`.
- `src/asks/composio.ts` (create): the `composio` ask kind.
- `src/sources/stripe.ts`, `linear.ts` (rewrite): mappers from Composio payloads, enrichers and senders over `Composio.run`. Signature checks, handlers and HTTP clients go.
- `src/sources/notion.ts` (modify): the 2c webhook handler, signature check, verification handshake and `normalizeNotion` stay; the enricher, the bot lookup and the comment sender run over `Composio.run`; the HTTP client goes.
- `src/sources/posthog.ts` (create): the PostHog mapper.
- `src/sources/generic.ts` (create): the mapper for any other toolkit's configured triggers.
- `src/sources/calendar.ts` (modify): `CalendarFeed` reads through Composio; `parseFeed` and ical.js go; `Occurrence`, `dueReminders`, `reminderEvent`, `describe*`, `parseWhen` stay.
- `src/sources/calendar-composio.ts` (create, replaces `calendar-script.ts`): the same `call(req) → ScriptResult` contract over Composio's calendar tools. Rename `ScriptEvent`/`ScriptRequest`/`ScriptResult` to `CalEvent`/`CalRequest`/`CalResult` and update `tools.ts` and `calendar-undo.ts`.
- `src/config.ts` (modify): `sources.composio`; old keys refused.
- `src/store.ts` (modify): `composio_accounts`, `composio_triggers`, `composio_writes` tables; webhook secret and Notion ingress in `state`; clear old `calendar_changes`.
- `src/tools.ts`, `src/agent/tool-server.ts`, `src/axes.ts` (modify): `composioFind`, `composioRun`.
- `src/asks.ts` (modify): `AskKindName` gains `"composio"`.
- `src/commands.ts` (modify): `&composio undo`.
- `src/agent/prompts.ts` (modify): the Composio lines and audiences in the system prompt.
- `src/events/kinds.ts`, `src/rulebook.ts` (modify): `posthog` source with `analytics_event`; generic toolkit sources with kind `trigger`.
- `src/daemon.ts` (modify): builds Composio and its tools in one block (handlers, mappers, enrichers, senders, calendar feeds), then calls `composio.start()`; the old per-source handlers, the Apps Script and iCal wiring, and `learnIdentity` go (Supervisor jobs replace its retry).
- Delete: `setup/calendar.gs`, `src/sources/calendar-script.ts`, `tests/calendar-script.test.ts`, `tests/fixtures/stripe/*`, `tests/fixtures/linear/*`, `scripts/spike-2c-calendar.ts`.
- `README.md`, `clots.config.example.json`, `.env.example` (modify).
- Tests (create): `tests/composio-rating.test.ts`, `composio-intake.test.ts`, `composio-component.test.ts`, `composio-reviewer.test.ts`, `composio-undo.test.ts`, `asks-composio.test.ts`, `posthog.test.ts`; fixtures in `tests/fixtures/composio/<toolkit>/`. Rewrite `stripe.test.ts`, `linear.test.ts`, `calendar.test.ts`; `notion.test.ts` keeps its handler tests and gets new enricher and sender tests; extend `config.test.ts`, `tools.test.ts`, `commands.test.ts`, `axes.test.ts`, `store.test.ts`, `prompts.test.ts`.

## Key Decisions & Gotchas

- **Probe first, then build.** Spec section 17 lists six assumptions. Task 1 checks them live with `scripts/spike-2e.ts` against the user's Composio project (`COMPOSIO_API_KEY` in `.env`; the user made the account under the Clots' address). If any fails, stop and report to the user before Task 2. Task 1 also fixes every slug the rest of the plan names as "confirmed in Task 1"; record them in Implementation Notes and in the code as named constants, never as string literals scattered through files.
- **Confirmed in Task 1.** Linear: triggers `LINEAR_PRIVATE_TEAM_ISSUE_CREATED` and `LINEAR_PRIVATE_TEAM_COMMENT_CREATED` (config `team_id`, polled; the webhook triggers need an OAuth client and fail on a key connection); tools `LINEAR_WHO_AM_I` (id at `data.data.id`), `LINEAR_LIST_LINEAR_TEAMS`, `LINEAR_RUN_QUERY_OR_MUTATION` (`query_or_mutation`, `variables`), `LINEAR_GET_LINEAR_ISSUE` (`issue_id`), `LINEAR_CREATE_LINEAR_ISSUE` (`team_id`, `title`), `LINEAR_CREATE_LINEAR_COMMENT` (`issueId`, `body`), `LINEAR_ARCHIVE_ISSUE` (`issue_id`), `LINEAR_UPDATE_ISSUE` (`issueId` and the fields); there is no delete-comment tool, so undoing a comment is a fixed `commentDelete` mutation through the GraphQL tool. Notion: `NOTION_WHO_AM_I`, `NOTION_CREATE_COMMENT`, `NOTION_CREATE_NOTION_PAGE`, `NOTION_ARCHIVE_NOTION_PAGE`; its read tools and arguments are confirmed in Task 5. Calendar: `GOOGLECALENDAR_EVENTS_LIST`, `_EVENTS_GET`, `_CREATE_EVENT`, `_PATCH_EVENT`, `_DELETE_EVENT`. Stripe (not exercised live: the project key had no webhook-endpoint permission): triggers listed above, reads `STRIPE_RETRIEVE_CHARGE`, `STRIPE_RETRIEVE_CUSTOMER`, `STRIPE_GET_INVOICES_INVOICE`, `STRIPE_RETRIEVE_PAYMENT_INTENT`, `STRIPE_GET_PAYOUT`, `STRIPE_LIST_DISPUTES`. PostHog: connection fields `subdomain` (`us` or `eu`) and `generic_api_key`; trigger `POSTHOG_EVENT_CAPTURED` (`project_id`, `event_names`), which needs the key to carry the `hog_function:write` scope. The polled Linear delivery arrived 26 s after the issue and carries the team key, the creator, the URL and the identifier in `data`. Errors seen: a rejected project key is 401 `APIKey_InvalidAPIKey`; a session with no pinned connection is 400 `ToolRouterV2_NoActiveConnection`; a webhook trigger on a key connection is 400 `TriggerInstance_BadRequest`; a missing scope or permission at the service is 400 `TriggerInstance_WebhookConfigInvalid` with the service's text.
- **`ComposioApi` is the seam.** Everything above it is tested with a fake. Its methods (Task 3 produces them):
  ```ts
  interface ComposioApi {
    ensureAuthConfig(toolkit: string, scheme: "API_KEY" | "MANAGED"): Promise<string>;
    connectWithKey(user: string, authConfigId: string, key: string): Promise<Connection>;
    linkManaged(user: string, authConfigId: string): Promise<{ redirectUrl: string; connectionId: string }>;
    connection(id: string): Promise<Connection>;
    deleteConnection(id: string): Promise<void>;
    upsertTrigger(user: string, connectionId: string, slug: string, config: Record<string, unknown>, pollingMinutes?: number): Promise<string>; // trigger id
    deleteTrigger(triggerId: string): Promise<void>;
    triggerState(triggerId: string): Promise<"active" | "disabled" | "missing">;
    setWebhook(url: string): Promise<{ secret: string }>;
    tool(slug: string): Promise<ToolInfo | undefined>;
    search(toolkit: string, query: string): Promise<ToolInfo[]>;
    execute(user: string, toolkit: string, slug: string, args: Record<string, unknown>): Promise<ExecResult>;
  }
  type Connection = { id: string; status: "active" | "initiating" | "expired" | "failed" };
  type ToolInfo = { slug: string; toolkit: string; name: string; description: string; inputSchema: unknown; tags: string[] };
  type ExecResult = { ok: true; data: unknown } | { ok: false; error: string; reason: "cap" | "auth" | "unreachable" | "refused" };
  ```
  `execute` runs inside a session made with `composio.create(user, { toolkits: [toolkit], sandbox: { enable: false }, connectedAccounts: { [toolkit]: connectionId } })` (the pin is what lets a session find a key connection), cached per user and connection. Map Composio's errors to `reason` in `api.ts` only: rate-limit/quota → `cap`; 401/expired/revoked connection → `auth`; network/5xx → `unreachable`; anything else → `refused`.
- **Users and keys.** Composio user ID = `<toolkit>:<account>`. A key connection is replaced when the key changes: store a SHA-256 of the key (never the key) in `composio_accounts.key_hash`; on mismatch, `deleteConnection` then `connectWithKey`. An account removed from the configuration has its triggers deleted at startup; its connection is left in Composio (cheap, and reconnecting stays instant).
- **Reconcile is idempotent and runs at startup, before intake answers `/webhooks/composio`.** Order: webhook subscription (store secret in `state`), then per account: auth config → connection → identity → triggers. A failure for one account is logged, reported once via the existing listener `tell` mechanism, and retried by the Supervisor with its growing wait; it never stops the daemon or other accounts.
- **Intake must not depend on the network.** `/webhooks/composio` verifies with the stored secret and looks up the connection ID in the store, both local. The SDK's `verifyWebhook` works offline but lives on a client instance and rejects any body outside its own V3 schema, so the daemon does the HMAC by hand (spec section 5), a few lines, and reads the body itself.
- **Payload shape.** V3 delivery: `type === "composio.trigger.message"`, `metadata.trigger_slug`, `metadata.toolkit_slug`, `metadata.connected_account_id`, `metadata.user_id`, `data` (confirmed on captured deliveries). Any other `type` is acknowledged and ignored (200 "ignored").
- **Mappers keep 2c's events.** Each built-in toolkit's mapper produces exactly the `ClotEvent` 2c's adapter produced (same `source`, `kind`, `place`, `ref`, `subject`, `title` format, `automated`, `outsider: false`), except `id`, which becomes `composio:<webhook-id>`. Write the new tests by porting 2c's expectations onto the captured Composio fixtures, so routing rules, pre-filters, holds and standing rules written against 2c keep matching. Where a Composio payload lacks a field 2c read from the webhook, the enricher fills it; the mapper leaves a placeholder the enricher replaces (`place: ""` is not allowed to reach routing; enrichment runs before routing, as in 2c section 7).
- **Generic toolkits are outsiders** (spec section 4). Events from a toolkit without a built-in mapper (a Slack message, say) may carry anyone's text, so they are marked `outsider: true`; a write in such a turn goes to the reviewer.
- **Self-caused drop.** Identities come from one read per account at reconcile: Linear `LINEAR_WHO_AM_I`; Notion the bot user (`NOTION_WHO_AM_I`), which 2c's webhook handler uses too; Stripe none (no actor of its own). Until an identity is known, events still flow, but the account's standing-rule sender refuses, as in 2c (keep the exact refusal texts). The handler stores the event with `dropped` set when the actor ID equals the identity, as 2c's handlers did.
- **Enrichers and senders keep their logic; change only transport.** Linear: replace `linearApi(apiKey)` with a function of the same shape that runs Composio's GraphQL tool (`query_or_mutation`, `variables`) on the account. The `ISSUE_QUERY`, the comment mutation, and the error classification (`refused` vs not) stay. Notion and Stripe: use the read tools confirmed in Task 1 that return the same fields 2c read; keep the output text format, so triage and prompts see what they saw. An `ExecResult` with `ok: false` maps to the old "could not be read" line.
- **Standing rules are not rated again.** `linear_comment` and `notion_comment` senders call `Composio.run` directly, never `composio_run`'s rating. Their record-before-send behaviour stays.
- **Calendar: same contract, new backend.** `calendar-composio.ts` implements `call(account, req)` for `create | update | remove | check` with Google Calendar tools on the account's connection, returning the same result union with `reached` and `missing` semantics (`check` on a deleted event → `missing: true`). `uid` is now Google's event ID (not the iCal UID). A repeating event is one with `recurringEventId` (an occurrence) or `recurrence` (the series); `update` on an occurrence applies to the series by addressing `recurringEventId`, matching the Apps Script's series behaviour. The guests refusal stays in `tools.ts` and is re-checked in `calendar-composio.ts` before `remove`, as the script did; an attendee that is the organizer or `self` is not a guest (Google adds the organizer unless `exclude_organizer: true`, which create passes). Create also passes `create_meeting_room: false`, since the tool adds a Google Meet link by default. Partial updates use `GOOGLECALENDAR_PATCH_EVENT` (`UPDATE_EVENT` requires a start time). A deleted event reads back with `status: "cancelled"`; deleting it again answers 410 as a failed result.
- **Calendar reading.** `CalendarFeed.read()` calls the list tool with `singleEvents: true`, `timeMin` now, `timeMax` now + 31 days (+ the longest lead time), and maps each item to `Occurrence`. All-day items (`start.date`, a bare `YYYY-MM-DD`) start at midnight of that date in `timeZone` via the helpers in `src/time.ts`; never parse it as UTC, or it lands a day early east of UTC. An item with `status: "cancelled"` is skipped in lists, and `check` treats it as `missing`. Reminder IDs use the item's `iCalUID` plus its `originalStartTime` (or start), as 2c's IDs did, so reminders already made before the upgrade are not made again. One mapping from Google's JSON to `Occurrence`/`CalEvent` lives in `calendar-composio.ts`; `CalendarFeed` uses it. The cached list serves `calendar_list` while younger than `pollMinutes`; a range beyond the cached one triggers a fresh read for that range.
- **Old calendar log.** `calendar_changes` rows from the Apps Script era hold iCal UIDs the new backend cannot address. A store migration deletes rows written before the 2e schema version, so `&calendar undo` says "Nothing to put back." instead of failing on them.
- **Managed calendar sign-in.** When the calendar's connection is not active, reconcile calls `linkManaged` and posts `Sign in to Google Calendar for the Clots: <redirectUrl>` in the bound Clot's live channel (home Clot for a shared account), once per startup; then polls `connection(id)` every 30 s until active or 15 minutes pass. This mirrors the MCP OAuth link in 2c section 13.
- **Rating is pure and total** (the tag and slug rules in "From the plan review" refine this bullet). `rateComposioCall({ slug, toolkit, tags }, audience, outsiderTurn) → { rating: "run" | "review" | "ask"; reason: string }`, in the spec's order. Matching on slugs is on the uppercase slug split at `_` into words, so `ARCHIVE` matches `LINEAR_ARCHIVE_ISSUE` but `LINEAR_LIST_ARCHIVED…` is still a read by its tag first. Fixed-list words: money (`PAYMENT`, `CHARGE`, `REFUND`, `PAYOUT`, `TRANSFER`, `INVOICE`, `SUBSCRIPTION`), plus every non-read tool whose toolkit is `stripe`; reaching people (`SEND`, `EMAIL` with a write tag, `MESSAGE` with a write tag, `SMS`, `INVITE`, `SHARE`, `PUBLISH`). Destructive words: `DELETE`, `ARCHIVE`, `REMOVE`, `REVOKE`, `CANCEL`, `REASSIGN`, `TRANSFER`. A read tag wins over every word: `GMAIL_LIST_MESSAGES` is a read. A tool with both `readOnlyHint` and `destructiveHint` is treated as destructive (tags contradict; take the worst).
- **`composio_run` flow.** Refuse if the account is unknown or the tool's toolkit differs from the account's. Fetch `ToolInfo` (cache per slug for the daemon's life; refuse an unknown slug). Rate. `run` → execute, log, post. `review` → reviewer; `run` → as before, the post adds "(reviewed)"; `ask` → open the `composio` ask with the reviewer's reason. `ask` → open the ask. The tool returns at once in the ask case, with the same "do not wait" wording the merge ask uses.
- **`TOOL_AXES` entries.** `composioFind: LOW`; `composioRun: LOW`, with a comment that it rates each call itself (like the calendar tools enforce their own rules). Under the lock both are approved as daemon tools; the read path is what lets the locked main session read.
- **The `composio` ask kind.** Channel: `mergeChannelName` (`<clot>-ask`). Payload: account, audience, slug, tool name, description, args, why. Exact yes runs the stored args exactly; the outcome goes to the main session as a note and is posted. Exact no declines. Other text goes to the main session as the user's feedback and closes the ask. No deadline, no stale check. Max open per Clot: 5; from outsiders' turns: `OUTSIDER_MAX`. Dedupe key: hash of account + slug + args.
- **Undo.** The inverse table in `undo.ts` maps a slug to how to reverse it, keyed by slugs confirmed in Task 1: Linear create issue → archive issue (ID from the result); Linear update issue → update with the fields read before (read with the get-issue tool before executing, store in `composio_writes.before`); Linear create comment → delete comment; Notion create page → archive page; Notion create comment → none. Anything else → "no undo". `&composio undo` takes this Clot's newest un-undone write that has an inverse, claims it in the store before calling (as `CalendarUndo` does), runs the inverse without rating (undoing the Clot's own write), posts it. A second `&composio undo` steps further back.
- **Daily trigger check.** A Supervisor job every 24 h (first run 10 min after startup): for each stored trigger, `triggerState`; `disabled`/`missing` → `upsertTrigger` again; failure → tell once in the account's Clot channel. Same job reads each connection; `expired`/`failed` → tell once (calendar: new link; key: "replace `<ENV_KEY>` in .env and restart").
- **Cap.** The first `ExecResult` with `reason: "cap"` (or a delivery saying so, if Composio sends one; Task 1 checks) posts once in the home Clot's channel (first Clot's without one): "Composio's free monthly limit is reached: tools and events from Composio pause until <first of next month>." Remember the month in `state` so it is said once per month.
- **Spend.** The reviewer's cost is booked with the existing `onCost(usd, clot)`.
- **System prompt.** Add, near the calendar lines: what `composio_find`/`composio_run` are; that reads always work; that private and team writes usually run and are posted, destructive team writes may be reviewed, public writes and anything moving money or reaching people outside the workspace become asks; list the configured accounts with toolkit and audience. Keep it to a few lines. Resumed sessions keep their old prompt, so the README tells the user to `&close` each Clot after updating.
- **`ToolkitDef`.** `{ toolkit: string; source: string /* "linear", "calendar", … */; triggers(a, host): Promise<TriggerWant[]>; identity?(a, host): Promise<string>; connectExtra?(a): Record<string, string>; responseChecks?: Record<string, ZodType> }`, where `host` is the Composio component (`run`, `runChecked`). `responseChecks` is keyed by tool slug. Mappers are passed to the intake handler, enrichers and senders to the pipeline and the tools, in the one block of `daemon.ts` that wires Composio; the inverse table lives in `undo.ts` and the rating rules in `rating.ts`. A registry `TOOLKITS` maps slug → def; unknown toolkits use `generic`. Config is a discriminated union on `toolkit` with one strict schema per built-in toolkit; consumers get narrowed types (`CalendarComposioAccount`).

### From the plan review (2026-11-19)

**Startup and reconcile**
- **Nothing Composio blocks startup.** The daemon never awaits reconcile at top level, and `Composio.start()` never throws out of it. The webhook subscription is one Supervisor job, and each account is another, each with its own backoff. The calendar sign-in wait is a detached timer. `/webhooks/composio` is registered at once and answers 503 only while no secret is stored. One account's failing identity read does not hold back its triggers: identity is a separate retried step, and only the standing-rule sender waits for it.
- **Reconcile adopts what Composio already holds.** The store is not the truth. Per user, list the auth configs, connections and trigger instances Composio has. Adopt one of each (prefer an active connection, and the trigger whose config hash matches). Delete extras of the same slug for that user. Only then create what is missing. `spike-2e.ts` deletes everything it creates (its users are named `spike:<toolkit>`).
- **The webhook secret is read once and kept.** Set the subscription only when none exists or its URL differs. Keep the secret Composio returned when it created the subscription; never set it again on each start. When the stored secret is missing but a subscription exists, rotate it once and store the new one. Three 401s in an hour are told once in the home Clot's channel ("Composio deliveries are failing their signature check").
- **A key change rebinds before it deletes.** Connect the new key first. Then move the account's triggers to the new connection (upsert them on it, then delete the old instances), and only then delete the old connection. Store `key_hash` after the whole sequence succeeds, so a crash midway redoes it. Composio refuses a second connection for a user without `allowMultiple`, so the connect passes it. The new connection is staged: its ID and the key's hash are kept in `state` (`composio.staged.<user>`) until the swap completes, so a retry reuses it instead of making another. A staged connection that is unusable, or made for a key that has since changed again, is deleted first; an error that is not "it is not there" (404) keeps the marker and is retried, and a new connection is made only once the staged one is confirmed gone. A marker that names the account's own connection (a crash after the swap) is only cleared. If the key goes back to the established one after a failed swap, the staged connection is deleted, the established one becomes the tool target again, and its triggers are put back. An account removed from the configuration loses its staged connection too (its row stays until that succeeds); its established connection stays.
- **Lifecycle events.** Subscribe to `composio.trigger.message`, `composio.trigger.disabled` and `composio.connected_account.expired` (and `.activated` if offered). Disabled with `connection_expired` → nothing (Composio re-enables it). Any other disabled reason → recreate once, and tell once if that fails. Expired → tell once (calendar: a fresh sign-in link). The daily check stays as a backstop: it reads the connection first and recreates triggers only when the connection is active. A Stripe webhook endpoint deleted in Stripe is not noticed: Composio has no tool that lists Stripe's webhook endpoints (its catalog has only v2 event destinations), and a deletion in Stripe does not reach Composio. The README's troubleshooting says to remove the account from the configuration, restart, and add it back, which makes the endpoint again. The lifecycle deliveries are read as Composio documents them: a disabled trigger's `data.id` is the trigger instance and `data.disabled_reason` says why (`connection_expired`, or the sentence "Connected account authentication expired."; both mean the connection); an expired connection's `data.id` is the connection (the metadata carries only the project).
- **Setup waits never just stop.** The calendar link is posted again by the daily check while the connection is not active (once a day, never more).

**Events**
- **Dedupe on the service's own IDs** (2c's IDs: Stripe `evt_…`, Notion's event ID, Linear's comment/issue ID plus kind). This also covers a repeated poll and Stripe's retries. Fall back to `composio:<webhook-id>` for generic toolkits.
- **Outsider is per source, as 2c had it**: Stripe `true` (a customer writes the description, name and address), PostHog `true`, generic `true`, calendar from the organiser (2c), Linear and Notion `false`. When a mapper cannot find the actor, `true`.
- **The Clot's own writes are not events.** `actions.ts` records the object IDs each write created or changed (from the result). Intake drops, as self-caused, an event whose object ID matches a write of the same account in the last 10 minutes. This covers generic toolkits and the time before an identity is known.
- **`place` is never empty.** The mapper sets a fallback from the payload (Linear team ID, Notion parent ID, Stripe account name), which enrichment replaces when it can.
- **Generic triggers.** The trigger instance is keyed by slug and a hash of its config: a changed config replaces the instance. The same slug twice in one account fails config loading.
- **Old webhooks.** The README's 2e upgrade steps tell the user to delete the Stripe endpoint and the Linear webhook that pointed at the old paths. The Notion subscription stays, on its 2c path.

**Calls**
- **Timeouts.** Every `ComposioApi` call times out after 30 s; `structuredQuery` gains an optional `timeoutMs` (the reviewer uses 30 s). A write that times out is logged as `unknown`, posted as "outcome unknown: check <service>", never retried by the daemon, and has no undo.
- **Limits.** `composio_run`: 30 calls per turn and 300 per Clot per day; past either it refuses with the limit named. Reviewer calls from outsiders' turns: 10 per Clot per day; past that, the write asks. Calendar polling: the sum over calendars of `43200 / pollMinutes` must be at most 10,000 a month, or config loading fails naming the limit. The list is read with `maxResults: 2500`, following `nextPageToken`.
- **Meter.** `meter.ts` counts tool calls (managed and own-app apart) and deliveries per calendar month (Task 1 confirms Composio's period anchor; use it). It warns once at 70% and once at 90% of each Hobby allowance in the home Clot's channel, with the largest consumers named.
- **Response checks.** Each fixed-purpose call the daemon makes (enrichment reads, identity, the team list, the calendar list, get and create, the issue and comment GraphQL operations, and the reads before an update or an undo) goes through `Composio.runChecked`, which checks the fields it relies on with a zod schema: the def's `responseChecks` for the slug, or the caller's own (the GraphQL tool answers different shapes per operation; `LINEAR_GRAPHQL` holds them). On a mismatch it fails closed as a refused result marked `drift`: enrichment says "could not be read", a calendar remove or update is refused, and a drifted answer is never taken for "the event is not there". The first drift per tool and account is logged and remembered; the daily check tells it once per start in the account's Clot channel ("Composio's <tool> answered in an unexpected shape"). The calendar's patch and delete answers are not read (a patch is read back with `get`, and a delete is confirmed by the call succeeding).

**Rating**
- **Composio's tags are `readOnlyHint`, `createHint`, `updateHint`, `destructiveHint`** (and `idempotentHint`, ignored). A tool is untagged when it has none of the first four. Destructive means `destructiveHint`, untagged, or a destructive slug word. `createHint` and `updateHint` alone are ordinary writes.
- **A read tag is not trusted alone.** It is demoted to a write when the slug's verb (the first word after the toolkit) is a write verb: `CREATE`, `ADD`, `UPDATE`, `EDIT`, `SET`, `DELETE`, `REMOVE`, `ARCHIVE`, `SEND`, `POST`, `INVITE`, `SHARE`, `PUBLISH`, `MOVE`, `MERGE`, `CANCEL`. Passthrough tools are always rated destructive: any slug with `GRAPHQL`, `QUERY_OR_MUTATION`, `PROXY`, `REQUEST`, `RAW`, `EXECUTE`, and every `COMPOSIO_*` meta tool. The daemon's own fixed-purpose calls are not rated.
- **The fixed list also covers control-plane writes**: any non-read tool whose slug names `WEBHOOK`, `API_KEY`, `TOKEN`, `OAUTH`, `INTEGRATION`, `ROLE`, `PERMISSION`, `MEMBER`, `ADMIN` → ask, whatever the audience.
- **Calendar writes go through the calendar tools only.** `composio_run` refuses any non-read Google Calendar tool: "use calendar_write or calendar_remove". Those tools keep the guests, repeating-event and outsider rules.
- **Accounts are named `<toolkit>:<account>`** in `composio_find`, `composio_run`, asks and posts. That is the same string as the Composio user, and it is unambiguous when two toolkits share an account name.
- **The reviewer gets facts the daemon checked.** Added to `ReviewInput`: `targetCreatedByClot: boolean | "unknown"` (the target ID matches a create in `composio_writes`), and, where the def has a read for it, the target's creator and last editor. The reviewer's reason is shown in asks as `Reviewer (Haiku): "<reason>"`, never as the daemon's own words.

**Asks and undo**
- **An ask shows every argument.** Show the full JSON and let the chat adapter split long posts (`src/chat/discord.ts:52`). An args payload over 6,000 characters makes `composio_run` refuse the call before any ask is opened ("too large to show the user; split it"). Args are put in a fenced block with backticks escaped.
- **Yes re-checks.** On yes, re-read the account from config: if it is gone, or its toolkit or audience changed, withdraw the ask ("the account changed"). Then run through `actions.executeWrite`, the same path as a direct write. So the write is logged, has its before-read, and gets its undo.
- **Undo is built from the table only.** The inverse's arguments come from the inverse table applied to the stored result and the stored before-values, never from model text. Undoing an update first re-reads the object: if a field the write set no longer has the value the write gave it, undo refuses ("changed since; not put back"). The before-read uses the same field names as the update's input, mapped per toolkit in the def. `/webhooks/stripe/*` and `/webhooks/linear/*` stop existing (404 with the existing log line). The config refusal for `sources.stripe|linear|notion|calendar` says: ``sources.<name> moved to sources.composio in stage 2e; see clots.config.example.json``.

## Tasks

### Task 1: Live probes and fixtures
**Files:** `scripts/spike-2e.ts`, `scripts/capture-2e.ts` (create), `package.json` (dependency), `.env.example` (`COMPOSIO_API_KEY`)
**Interfaces:**
- Produces: confirmed slugs and payload shapes, recorded in Implementation Notes; fixtures in `tests/fixtures/composio/<toolkit>/NN-<trigger>.json` (headers and raw body).

**Build:**
- Install `@composio/core@0.28.0`. The spike uses the raw SDK; nothing in `src/` yet.
- Check each assumption of spec section 17 in order and print PASS/FAIL with the evidence: API-key connections for Linear and Notion receive a trigger event (create an issue and a comment by hand, as the user, while `capture-2e.ts` listens via a temporary `cloudflared` address or the Funnel); Composio's Linear webhook registration as the Clots' member; Notion ingress and verification token round trip; Stripe trigger creation with the restricted key plus webhook-endpoint write (test mode); tags on the Linear, Notion and Calendar write tools; the calendar list with `singleEvents` returns occurrences with `recurringEventId`.
- Also confirm: the sandbox-off session option; `verifyWebhook` works offline; the V3 metadata field names; the exact slugs for every trigger and tool this plan names "confirmed in Task 1" (Stripe triggers for the 2c kinds; Notion page/comment created; PostHog; Linear GraphQL tool and its argument names; Notion and Stripe read tools for enrichment; Calendar list/get/create/update/delete; the undo inverses); how a cap or an expired connection shows up in errors.
- Live steps that need the user (OAuth sign-in, making an issue as a person) are listed for them with exact actions; wait for them.

**Tests (behaviours):** none (probe). Each assumption has an explicit PASS/FAIL line.

**Done when:** every assumption printed PASS, or the user was told which failed and decided how to go on; fixtures saved for every trigger the mappers use.

- [x] Task 1 complete

### Task 2: Configuration and store
**Files:** `src/config.ts`, `src/store.ts`, `clots.config.example.json`, `tests/config.test.ts`, `tests/store.test.ts`
**Interfaces:**
- Produces: `ComposioAccount = { toolkit: string; account: string; clot?: string; shared?: true; audience: "private" | "team" | "public"; apiKey?: string /* resolved value */; apiKeyName?: string /* the .env key */; triggers: { slug: string; config: Record<string, unknown> }[]; leadMinutes?: number[]; pollMinutes?: number; checkoutCompleted?: boolean; region?: "us" | "eu"; projectId?: number; events?: string[] }`; `config.sources.composio: ComposioAccount[]`; `config.composioApiKey: string | undefined`.
- Store: `composio_accounts(user PK, connection_id, auth_config_id, key_hash, identity, status)`, `composio_triggers(user, slug, key, trigger_id, PK(user, slug, key))` (`key` is a hash of the instance's config, so one slug can run once per Linear team), `composio_writes(id, clot, account, slug, args, result, before, inverse, undone, at)`; getters/setters named after the columns; `state` keys `composio.webhookSecret`, `composio.ingress.<user>`, `composio.capMonth`.

**Build:**
- Schema per spec section 4. `toolkit` lowercase slug. `apiKey` required for every toolkit except `googlecalendar`, refused for it. `leadTimes`/`pollMinutes` only for `googlecalendar` (reuse the existing `leadTime` parser); `checkoutCompleted` only for `stripe`; `region` (default `us`), `projectId` and `events` only for `posthog`, where `projectId` and `events` are required; `triggers` only for toolkits without a built-in mapper. Account names unique per toolkit.
- `COMPOSIO_API_KEY` required when `sources.composio` is not empty.
- The old keys fail with the message in Key Decisions.
- Migration clearing old `calendar_changes` rows.

**Tests (behaviours):**
- a full example config parses, with `audience` defaulting to `public`;
- `sources.linear` present → load fails naming the key and `sources.composio`;
- calendar with `apiKey`, or Linear without → refused with the field named;
- `triggers` on `linear` → refused;
- missing `COMPOSIO_API_KEY` with accounts → refused; with none → fine;
- store round-trips each new table; the migration empties pre-2e calendar changes once.

**Done when:** `npm test -- config store` passes. Removing the old source keys breaks `daemon.ts` until Task 9 rewires it, so the full `npm run typecheck` is required from Task 8 on; until then each task's own test files must pass (vitest runs them without the whole project compiling).

- [x] Task 2 complete

### Task 3: The Composio component
**Files:** `src/composio/api.ts`, `src/composio/component.ts`, `tests/composio-component.test.ts`
**Interfaces:**
- Consumes: `ComposioAccount`, the store methods of Task 2, `Supervisor` from `src/listeners.ts`.
- Produces: `ComposioApi` (above) and `sdkComposioApi(apiKey): ComposioApi`; `class Composio { constructor(d: { api: ComposioApi; store: Store; accounts: ComposioAccount[]; publicUrl: string; tell(account: ComposioAccount, text: string): Promise<void>; tellHome(text: string): Promise<void>; now(): number }); reconcile(): Promise<void>; account(name: string, toolkit?: string): ComposioAccount | undefined; byConnection(connectionId: string): ComposioAccount | undefined; identity(a: ComposioAccount): string; run(a: ComposioAccount, slug: string, args: Record<string, unknown>): Promise<ExecResult>; tool(slug: string): Promise<ToolInfo | undefined>; find(a: ComposioAccount, query: string): Promise<ToolInfo[]>; checkDaily(): Promise<void>; userOf(a: ComposioAccount): string }`.

**Build:**
- Reconcile in the order of Key Decisions, per account independently; each account's step that throws is retried by its own Supervisor job.
- Identity readers per toolkit, behind a small map (`linear`, `notion`; others none).
- Trigger set per built-in toolkit (constants from Task 1): Linear's two polled private-team triggers (`LINEAR_PRIVATE_TEAM_ISSUE_CREATED`, `LINEAR_PRIVATE_TEAM_COMMENT_CREATED`, polled every minute) for each team the member belongs to, read with `LINEAR_LIST_LINEAR_TEAMS` (the daily check adds teams joined since); Stripe's seven (`STRIPE_INVOICE_PAYMENT_FAILED`, `STRIPE_PAYMENT_INTENT_PAYMENT_FAILED`, `STRIPE_CHARGE_DISPUTE_CREATED`, `STRIPE_CUSTOMER_SUBSCRIPTION_DELETED`, `STRIPE_PAYOUT_FAILED`, `STRIPE_CHARGE_REFUNDED`, and `STRIPE_CHECKOUT_SESSION_COMPLETED` only with `checkoutCompleted`); PostHog's `POSTHOG_EVENT_CAPTURED` with the account's `projectId` and `events`; none for Notion and the calendar; for other toolkits, the configured `triggers`. Remove stored triggers no longer wanted.
- `run` wraps `api.execute` with `userOf(a)`, and on `reason: "cap"` calls the once-a-month cap notice; on `auth`, the once-per-start expired notice.
- Calendar sign-in link and polling, per Key Decisions.

`Composio` takes `schedule` (as `Supervisor` does) besides `now`, so every wait and poll is driven by tests. `classifyComposioError` is tested on a table of the errors captured in Task 1.

**Tests (behaviours):** (fake `ComposioApi` recording calls; also every bullet under "Startup and reconcile" in Key Decisions)
- first reconcile creates webhook, auth configs, connections, triggers, in order; a second is a no-op;
- a changed key hash replaces the connection; an unchanged one does not;
- a removed account's triggers are deleted; another account's failure does not stop the rest;
- calendar not active → one sign-in link posted, then active after polling;
- `checkDaily` recreates a disabled trigger, tells once when it cannot, tells once for an expired connection;
- `run` with a cap error tells home once per month; `run` passes the right user;
- `COMPOSIO_API_KEY` never appears in any `tell` text or log line produced (assert over captured output).

**Done when:** `npm test -- composio-component` passes.

- [x] Task 3 complete

### Task 4: Intake
**Files:** `src/composio/intake.ts`, `tests/composio-intake.test.ts`
**Interfaces:**
- Consumes: `Composio.byConnection`, the store's webhook secret, `storeEvent` from `src/intake.ts`.
- Produces: `type Mapper = (account: ComposioAccount, slug: string, data: unknown, webhookId: string, receivedAt: number) => { event: ClotEvent; actorId: string } | undefined`; `composioHandler(d: { composio: Composio; secret: () => string | undefined; mappers: Record<string, Mapper>; insertEvent(e: ClotEvent): boolean; now(): number }): Handler`.

**Build:**
- Verify (spec section 5), 401 on failure or stale timestamp, 400 on missing headers or bad JSON, 503 while no secret is stored yet.
- Non-trigger `type` → 200 "ignored". Unknown connection → 200 "unknown account" with a log line. No mapper for the toolkit → the generic mapper when the account has `triggers`, else 200 "ignored". Mapper returns undefined → 200 "ignored".
- Drop as self-caused when `actorId !== ""` and equals `composio.identity(account)`.

**Tests (behaviours):**
- a correctly signed fixture is stored once and a repeat is "duplicate";
- a wrong signature, a timestamp 301 s old, and a missing `webhook-id` are refused;
- an unknown connection ID is acknowledged and not stored;
- an event by the Clots' own Linear member is stored with `dropped`;
- the same Linear issue from the public and the private trigger is stored once; a Stripe event redelivered under a new `webhook-id` is stored once;
- an event about an object a Clot's write created 2 minutes earlier is dropped as self-caused; one 11 minutes later is not;
- `trigger.disabled` and `connected_account.expired` deliveries reach the component and store no event.

**Done when:** `npm test -- composio-intake` passes.

- [x] Task 4 complete

### Task 5: Sources over Composio
**Files:** rewrite `src/sources/stripe.ts`, `linear.ts`; modify `src/sources/notion.ts`; create `src/sources/posthog.ts`, `src/sources/generic.ts`; modify `src/events/kinds.ts`, `src/rulebook.ts`; rewrite `tests/stripe.test.ts`, `linear.test.ts`, `notion.test.ts`; create `tests/posthog.test.ts`; delete old fixtures.
**Interfaces:**
- Consumes: `Mapper`, `Composio.run`, `Composio.identity`.
- Produces: `stripeMapper`, `linearMapper`, `posthogMapper`, `genericMapper: Mapper`; `stripeEnricher(c: Composio)`, `linearEnricher(c)`, `notionEnricher(c): Enricher`; `linearCommentSender(c)`, `notionCommentSender(c): Sender`.

**Build:**
- Mappers per Key Decisions ("Mappers keep 2c's events"). Stripe: `title` with amount, customer and "(test mode)" when not live, as 2c. PostHog: per 2c section 16 (`analytics_event`, `place` the project, `subject` `posthog:<event name>`, `actor` the distinct ID, automated). Generic: `source` = toolkit slug, `kind` `trigger`, `title` = trigger's name, `body` = clipped JSON of `data`, `subject` `<toolkit>:<slug>`, `outsider: true`, automated false.
- Enrichers and senders keep 2c's queries, text and refusal strings; only transport changes.
- Notion: `normalizeNotion`, `notionHandler`, `verifyNotion` and the verification handshake stay, taking the Composio account; `notionApi` and `notionBot` go, the bot id comes from `NOTION_WHO_AM_I`.
- Delete the Stripe and Linear signature verifiers and `*Handler` functions, the `linearApi` and Notion HTTP clients, and their tests.
- `kinds.ts`/`rulebook.ts`: `posthog` and `analytics_event` known; any configured generic toolkit name accepted as a `source` in rules with kind `trigger`.

**Tests (behaviours):** port every 2c expectation (kinds, titles, refs, subjects, automated flags, enrichment text, unreadable-line, sender refusals and the "member not known yet" refusal) onto the Composio fixtures; plus PostHog mapping and generic mapping with `outsider: true`.

**Done when:** `npm test -- stripe linear notion posthog` passes.

- [x] Task 5 complete

### Task 6: Calendar over Composio
**Files:** `src/sources/calendar.ts`, `src/sources/calendar-composio.ts` (create), delete `src/sources/calendar-script.ts`, `setup/calendar.gs`, `scripts/spike-2c-calendar.ts`, `tests/calendar-script.test.ts`; modify `src/tools.ts`, `src/calendar-undo.ts`; rewrite `tests/calendar.test.ts`; uninstall `ical.js`.
**Interfaces:**
- Consumes: `Composio.run` on the calendar account.
- Produces: `calendarOverComposio(c: Composio, account: ComposioAccount): { call(req: CalRequest): Promise<CalResult>; list(from: Date, to: Date): Promise<Occurrence[]> }`; `CalEvent`, `CalRequest`, `CalResult` with the shapes of the old `Script*` types (field `uid` kept, now Google's event ID; `recurring` boolean).

**Build:** per Key Decisions ("Calendar: same contract", "Calendar reading"). `tools.ts` and `calendar-undo.ts` only change their imports and type names; `writableAccount` now means "a calendar account with an active connection".

**Tests (behaviours):** (fake Composio returning Google event JSON)
- reminders: an occurrence within the lead time yields one reminder with 2c's ID, title and body; a repeat poll yields none; an all-day event starts at midnight in the zone;
- `check` of a deleted event → `missing`; `remove` refuses an event with guests and a repeating one;
- `update` of an occurrence addresses its series;
- the whole existing `tools.test.ts` calendar section and `&calendar undo` tests pass against the new backend (create → undo removes; update → undo restores; remove → undo recreates only after `check` says missing).

**Done when:** `npm test -- calendar tools` passes and `ical.js` is gone from `package.json`.

- [x] Task 6 complete

### Task 7: Rating and the reviewer
**Files:** `src/composio/rating.ts`, `src/composio/reviewer.ts`, `tests/composio-rating.test.ts`, `tests/composio-reviewer.test.ts`
**Interfaces:**
- Produces: `type Audience = "private" | "team" | "public"`; `rateComposioCall(tool: Pick<ToolInfo, "slug" | "toolkit" | "tags">, audience: Audience, outsiderTurn: boolean, targetCreatedByClot: boolean | "unknown"): { rating: "run" | "review" | "ask"; reason: string }` (`"unknown"` counts as not created by a Clot; the caller resolves the target ID from the args through the def's per-tool target field, against `composio_writes`); `isDestructive(tool): boolean`; `onFixedList(tool): "money" | "people" | undefined`; `interface WriteReviewer { review(i: ReviewInput): Promise<{ verdict: "run" | "ask"; reason: string }> }`; `ReviewInput = { slug: string; description: string; args: Record<string, unknown>; account: string; toolkit: string; audience: Audience; outsiderTurn: boolean; targetCreatedByClot: boolean | "unknown"; targetPeople?: { creator?: string; lastEditor?: string }; userMessage?: string }`. `userMessage` is set only when `TurnContext.kind === "chat"`: the text of the user's message(s) that started the turn and any fed into it, which `TurnContext` gains as `userText?: string` (set in `src/clot.ts` from the turn's message rows). The prompt labels it as the user's own instruction, which shows what they asked for; event text, worker reports and the Clot's reasoning are never passed; `sdkWriteReviewer(onCost: (usd: number) => void): WriteReviewer`.

**Build:**
- Rating per spec section 12 and Key Decisions. `reason` strings are user-facing in the ask: "this account is public", "it moves money", "it reaches people outside the workspace", "the reviewer: <reason>".
- Reviewer prompt per spec section 12: the one question, the examples given there, args wrapped as `<untrusted>…</untrusted>` and labelled data, answer schema `{ verdict: "run" | "ask", reason: string (≤ 120 chars) }`. Anything unparseable, an error, or no output → `{ verdict: "ask", reason: "the reviewer gave no clear answer" }`.

**Tests (behaviours):**
- the table uses the real tag sets recorded in Task 1; `createHint`-only create in a team account → run; read tag on `LINEAR_CREATE_…` → write; any `GRAPHQL`/`PROXY`/`COMPOSIO_*` slug → destructive; `LINEAR_CREATE_WEBHOOK` → ask in private; a Google Calendar write → refused;
- read tag → run in every audience and turn; Stripe write → ask everywhere; `GMAIL_SEND_EMAIL` → ask in private; private create → run, private create in outsider turn → review; team create → run, team delete → review, team untagged → review, team create in outsider turn → review; outsider turn, private or team, delete of something no Clot created (or unknown) → ask, delete of a Clot-created object → review; public anything-not-read → ask; both tags → destructive;
- slug-word cases that must and must not match (`LINEAR_ARCHIVE_ISSUE` destructive; `NOTION_SHARE_PAGE` people; `LINEAR_LIST_ARCHIVED_ISSUES` with read tag → read);
- reviewer parsing: valid `run`, valid `ask`, garbage, thrown error → ask;
- the prompt includes the user's message in a chat turn, and has no user-message section in event and worker turns;
- labelled set: `tests/fixtures/composio/reviewer-cases.json` (8–12 writes with the expected verdict) is scored by an opt-in live test (`LIVE=1`), skipped by default, as the triage set is.

**Done when:** `npm test -- composio-rating composio-reviewer` passes.

- [x] Task 7 complete

### Task 8: The tools, the ask, undo and the prompt
**Files:** `src/tools.ts`, `src/agent/tool-server.ts`, `src/axes.ts`, `src/asks.ts`, `src/asks/composio.ts`, `src/composio/undo.ts`, `src/commands.ts`, `src/agent/prompts.ts`, tests: `tools.test.ts`, `asks-composio.test.ts`, `composio-undo.test.ts`, `commands.test.ts`, `axes.test.ts`, `prompts.test.ts`
**Interfaces:**
- Consumes: `Composio`, `rateComposioCall`, `WriteReviewer`, `Asks`, `TurnContext.outsider`.
- Produces: `DaemonTools.composioFind?(a: { account: string; query: string }): Promise<string>`; `DaemonTools.composioRun?(a: { account: string; tool: string; args: Record<string, unknown> }): Promise<string>` (present only when `sources.composio` is not empty); MCP names `composio_find`, `composio_run`; `composioKind(d): AskKind<ComposioPayload>`; `class ComposioUndo { undo(clot: string): Promise<string> }`; command `{ kind: "composio"; undo: true }`.

**Build:**
- `composio_find` returns at most 10 tools: slug, name, one-line description, whether it reads, and the input schema compacted. Account names an unknown account → the list of accounts.
- `composio_run` flow per Key Decisions. The live-channel post: `Composio (<toolkit> <account>): <tool name>, <link or short result>. \`&composio undo\` reverses it.` or `… (no undo)`. Results returned to the model are clipped to 4,000 characters and wrapped as untrusted data (they can hold other people's text).
- Before an update with an inverse, read the "before" fields; store `before` and `inverse` in `composio_writes`.
- Every `composio_run` call, read or write, leaves one log line: `[composio] <clot> <account> <slug> → <run|review→run|review→ask|ask|refused|failed>`, with args clipped to 200 characters.
- The ask kind per Key Decisions; render shows account, audience, tool, description, every argument (see "An ask shows every argument"), and the reason.
- `&composio undo` in `commands.ts` (CRLF), `COMMAND_USAGE` updated.
- Prompt lines per Key Decisions; the accounts list is built from config.

**Tests (behaviours):**
- a read runs in a locked event turn; a private write runs, is logged and posted with its undo line;
- a team destructive write with reviewer `run` runs, with `ask` opens one `composio` ask whose text names the reviewer's reason;
- a public write opens an ask; yes runs exactly the stored args once; no declines; other text reaches the main session; a duplicate ask is refused as already open;
- a tool from another toolkit, an unknown slug, an unknown account are refused with clear text;
- `&composio undo` archives a created Linear issue, restores an updated one's fields, says "Nothing to undo." with none, and two quick undos reverse one write each;
- the system prompt lists accounts with audiences and never contains a key.

**Done when:** `npm test` passes in full, and `npm run typecheck` passes for everything but `src/daemon.ts` (fixed in Task 9).

- [x] Task 8 complete

### Task 9: Wiring, docs and the commit
**Files:** `src/daemon.ts`, `README.md`, `clots.config.example.json`, `.env.example`, `clots.config.json` (the user's, gitignored: migrate their Stripe, Linear, Notion and calendar entries to `sources.composio` with audiences `public`, `team`, `private`, `private` — ask the user to confirm the audiences in chat before relying on them), the parent spec status line.
**Build:**
- Daemon: construct `Composio` with `sdkComposioApi`, run `reconcile()` before registering `/webhooks/composio` as ready (503 until the secret exists), register enrichers by source name, senders, calendar feeds via the Supervisor, the daily check, the tools, the ask kind, `ComposioUndo`. Remove the old per-source wiring and the Apps Script map.
- README: replace the Stripe/Linear/Notion/Calendar rows of the Sources table with one Composio section (setting `COMPOSIO_API_KEY`, `sources.composio` fields and audiences, the calendar sign-in link, the Notion webhook steps as in 2c, the Stripe key's webhook-endpoint permission, the PostHog key's `hog_function:write` scope), add `&composio undo` to Commands and the Composio write ask to Asks, remove `setup/calendar.gs` mentions, and the `&close` reminder after updating.
- Parent spec status line: 2e built (code and unit tests) once Task 8 passes; the live checks are reported in Implementation Notes.
- Commit on `stage-2e`.

**Done when:** `npm test`, `npm run typecheck` pass; the daemon starts against the user's config and logs reconcile done for every account; one commit on `stage-2e`.

- [x] Task 9 complete

## Manual Verification Checklist

**Shared setup:** Docker Desktop open and `docker info` succeeds; `npm install`; `npm run image`; `.env` has `COMPOSIO_API_KEY` and the account keys; `clots.config.json` migrated (Task 9); `tailscale funnel --bg 8787`; `npm run daemon` as a background process. Stop the daemon by killing the process listening on 8787.

#### MV-1: Reconcile at startup
- **Setup:** none.
- **Steps:** 1. Start the daemon. 2. Read its log. 3. Run `npm run daemon` again in a second terminal.
- **Expected:** one `[composio]` line per account saying connected and the triggers it holds; no key value in the log; the Composio dashboard shows the webhook subscription at `<publicUrl>/webhooks/composio`. The second daemon refuses to start, having touched nothing. Restarting the first makes no new connections or triggers.
- **How the executor runs it:** CLI and log; the dashboard look is `[user-only]` (needs the user's Composio login).

#### MV-2: Calendar sign-in link
- **Setup:** the calendar account has never been connected.
- **Steps:** 1. Start the daemon. 2. Open the link posted in the bound Clot's channel and approve.
- **Expected:** exactly one message `Sign in to Google Calendar for the Clots: https://…`; within a minute of approving, the log says the calendar is connected; no second link.
- **How the executor runs it:** `[user-only]`: Google sign-in is the user's.

#### MV-3: A Linear issue arrives through Composio
- **Steps:** 1. As the user, create an issue in the team bound to the Clot. 2. Watch the Clot's live channel.
- **Expected:** the one-line notice within a minute; the event row has `id` `linear:<account>:Issue:<the issue's UUID>`, `source` `linear`, `kind` `issue_opened`, `place` the team key, and the enriched body with "From Linear:".
- **How the executor runs it:** `[user-only]` for creating the issue as a person; the executor checks the store with a query.

#### MV-4: The Clots' own Linear comment is dropped
- **Steps:** 1. Ask the Clot in chat to comment "test from the Clot" on that issue. 2. Check the events table.
- **Expected:** the comment's event is stored with dropped reason "caused by the Clot itself" and produces no notice.
- **How the executor runs it:** `[user-only]` for the chat message; executor checks the store.

#### MV-5: Notion comment, Stripe failed payment, PostHog event
- **Steps:** 1. Comment on a page shared with the connection. 2. In Stripe test mode, trigger `invoice.payment_failed` with `stripe trigger invoice.payment_failed`. 3. Send a PostHog test event matching the configured trigger.
- **Expected:** each arrives as 2c's kinds (`comment`, `payment_failed` with "(test mode)" in the title, `analytics_event`), routed to the bound Clot.
- **How the executor runs it:** Stripe CLI by the executor if installed and logged in, else `[user-only]`; Notion and PostHog `[user-only]`.

#### MV-6: Calendar reminder and calendar tools
- **Steps:** 1. Add an event starting in 23 hours to the calendar by hand. 2. Wait one poll. 3. In chat: "add a test event tomorrow 09:00 called Composio check". 4. `&calendar undo`.
- **Expected:** one reminder notice for the hand-made event; the Clot posts "Calendar (personal): added …" with the undo line; after `&calendar undo`, "Removed: …" and the event is gone in Google Calendar.
- **How the executor runs it:** `[user-only]` (chat and the user's calendar).

#### MV-7: Private and team writes run without asking
- **Steps:** 1. In chat, ask the Clot to create a Linear issue "Composio write check" in the team account. 2. `&composio undo`.
- **Expected:** no ask channel; a live-channel line `Composio (linear proton): …` with a link and the undo line; after undo, the issue is archived and the reply says so.
- **How the executor runs it:** `[user-only]` for chat; executor checks `composio_writes`.

#### MV-8: A destructive team write goes to the reviewer
- **Steps:** 1. Ask the Clot to delete a comment a teammate wrote on an issue.
- **Expected:** either the reviewer's `ask` opens `<clot>-ask` showing the tool, args and "the reviewer: …", or it runs with "(reviewed)" in the post; the spend log shows a Haiku cost for the Clot.
- **How the executor runs it:** `[user-only]`.

#### MV-9: Public writes and the fixed list ask
- **Steps:** 1. Ask the Clot to update a Stripe customer's description (public account). 2. Answer `no`. 3. Ask again and answer `yes`.
- **Expected:** an ask in `<clot>-ask` with reason "it moves money" (every Stripe write is on the fixed list); `no` declines with nothing changed in Stripe; `yes` runs it once and the outcome is posted: Stripe's refusal, since the restricted key cannot write customers.
- **How the executor runs it:** `[user-only]`.

#### MV-10: A disabled trigger is recreated
- **Steps:** 1. Disable one trigger in the Composio dashboard. 2. Run the daily check by restarting the daemon and waiting 10 minutes.
- **Expected:** a log line that the trigger was recreated; the next Linear issue still arrives.
- **How the executor runs it:** `[user-only]` for the dashboard step.

#### MV-11: Bad deliveries are refused
- **Steps:** 1. `curl -X POST <publicUrl>/webhooks/composio -H 'webhook-id: x' -H 'webhook-timestamp: 1' -H 'webhook-signature: v1,AAAA' -d '{}'`. 2. `curl -X POST http://127.0.0.1:8787/webhooks/linear/proton -d '{}'`.
- **Expected:** 1 answers 401 with a log line; 2 answers 404 with "no such path"; nothing stored.
- **How the executor runs it:** curl.

#### MV-12: Regressions
- **Steps:** 1. Open a GitHub issue on the bound repository. 2. Send an email to a watched mailbox.
- **Expected:** both arrive exactly as before 2e.
- **How the executor runs it:** `[user-only]`.

## Out of Scope

- Moving GitHub or email to Composio; Sentry and Vercel (no Composio triggers).
- Composio's Notion triggers (they need a Notion OAuth app; Notion's events stay on 2c's webhook), and Linear's webhook triggers (same reason: Linear's polled triggers are used).
- The two Stripe kinds Composio has no trigger for (`radar.early_fraud_warning.created`, `invoice.overdue`).
- Composio's sandbox, Orgo, Browser Use; Composio's MCP URL in sessions.
- Composio tools for workers.
- Stage 3's onboarding checklist entries for Composio (stage 3 plans them).

## Implementation Notes

Built 2026-11-19 on branch `stage-2e`. Code and unit tests are done (2303 pass); the live checks are listed at the end.

**Task 1 findings that shaped the design** (also in spec section 17 and Key Decisions): Composio's webhook triggers need an OAuth client, so on an API-key connection they fail with "Auth config does not contain an OAuth client_id". Linear therefore uses the polled `LINEAR_PRIVATE_TEAM_*` triggers (a delivery came 26 s after the issue); every Notion trigger is a webhook, so Notion's events stay on stage 2c's own webhook and `/webhooks/notion/<account>` stays. Stripe has no trigger for `radar.early_fraud_warning.created` or `invoice.overdue`, and its Composio payload is the object, not the event (no `evt_` ID). A key connection needs `connectedAccounts` pinned in the session or it answers `ToolRouterV2_NoActiveConnection`. PostHog is on the US region; its trigger needs the `hog_function:write` scope. The calendar's create tool adds a Meet link and the organiser as an attendee unless told not to; `PATCH_EVENT` takes `YYYY-MM-DD` for all-day times.

**Deviations from the plan**
- `ComposioApi` differs from the sketch: no `createIngress`/`ingressToken`; added `findConnection`, `listTriggers`, `webhook`, `rotateWebhookSecret`; `upsertTrigger` takes `pollingMinutes`; `ExecResult` failures may carry `timedOut`. The webhook listing shows its secret, so a lost secret is read back instead of rotated.
- `composio_triggers` is keyed `(user, slug, key)` with `key` a hash of the config (Linear has one pair per team, read with `LINEAR_LIST_LINEAR_TEAMS`). `composio_writes` also has `outcome`, `touched`, `created`.
- Config: PostHog entries take `projectId` and `events`; Notion may carry `verificationToken`. `Composio` takes `supervisor`, `schedule` and an optional `meter`; `start()` runs the jobs, `reconcile()` is the one-pass form the tests use.
- Verification uses a hand-written HMAC (`verifyComposio`), since the SDK's `verifyWebhook` rejects any body outside its V3 schema. `/webhooks/composio` is registered at the start and answers 503 until set up.
- The inverse table is in `src/composio/undo.ts`, not in the toolkit defs. A Linear comment is undone with a fixed `commentDelete` mutation (no delete-comment tool). Undo of an update re-reads the object first and refuses if a field changed.
- Response checks and the daily drift report are built as `Composio.runChecked` and `responseChecks` on the def (see Key Decisions); every schema except Stripe's and the calendar's `get`/`create` was run against live answers. Stripe's daily webhook-endpoint check is not built: Composio has no tool that lists Stripe's v1 webhook endpoints.
- The reviewer's cost is booked as `triage`. `userText` joins `TurnContext` in `src/clot.ts`; `structuredQuery` gained `timeoutMs`.
- Calendar: an occurrence's update moves its series by the occurrence's own change; the poll is skipped until the account is signed in. `Occurrence` gained `icalUid` and `originalStart`; reminder IDs keep stage 2c's form.
- Fixtures: only the Linear issue is a real Composio delivery. The Linear comment and PostHog tests use the published payload schema, and Stripe's fixtures are 2c's recorded objects wrapped as Composio sends them.

**Live results** (2026-11-21, the real daemon, Linear, Notion and Calendar accounts; Stripe and PostHog are not in the configuration). MV-1: a restart adds no connection or trigger (store and Composio agree), and the dashboard shows the subscription at `<publicUrl>/webhooks/composio`, V3, with the three event types. MV-2: the calendar connection is active and no second link was posted. MV-3: a Linear issue arrived within a minute as `linear / issue_opened / CLO`, enriched through the checked GraphQL read, and was triaged. MV-4: the Clot's own issue and its own comment were stored as dropped, "caused by the Clot itself", with no notice. MV-5: a Notion comment arrived on stage 2c's webhook and was enriched through Composio's reads (Notion had paused the subscription after the downtime; resumed in its Webhooks tab). MV-6: an event 23 hours out was created through `calendar_write`, the 24-hour reminder arrived on the next poll, and `&calendar undo` removed it (create, get and delete through the checks). MV-7: a Linear issue was created in the private account without asking and posted with `&composio undo`; the undo was first refused by Linear ("Invalid scope: write required") because the key had create-only permissions; with a Read and Write key (no Admin) it archived the issue. Changing the key also tested a key change live: Composio refused the second connection for the same user until `connectWithKey` passed `allowMultiple`, after which the new connection was made, both triggers moved to it, and the old connection was deleted. MV-8: archiving a page in the team Notion account went to the reviewer (`review→run`) and its cost is a `triage` spend line. MV-9: a fixed-list tool (`NOTION_SEND_FILE_UPLOAD`) opened an ask with the reason and every argument; "no" closed it, and "yes" ran it through `executeWrite` and posted the service's own failure. MV-10: a trigger disabled at Composio (through the SDK; a manual disable emits no `trigger.disabled` delivery) was found and made again by the daily check. MV-11 and MV-12: bad deliveries are refused (verifier), a GitHub issue still arrives. Not run live: Stripe and PostHog (not configured), an email (needs the mailbox), a real lifecycle delivery. The Haiku reviewer scored all 10 labelled cases live.

**For the next planner.** Stripe's trigger creation was never exercised live (the key lacks webhook-endpoint permission; the user has moved to Paddle). Composio's polling may count against the trigger-event allowance; watch the month's usage. Lifecycle deliveries (`trigger.disabled`, `connected_account.expired`) are handled from the field names Composio's documentation gives; none has been captured live.
