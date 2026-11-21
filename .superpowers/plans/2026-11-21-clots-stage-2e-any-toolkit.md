# Clots stage 2e: any Composio toolkit — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. This plan gives structure and decisions, not code. You write the implementation (TDD per task). Track tasks with the checkboxes. After all tasks, run the **Manual Verification Checklist** (or hand it to the user if they asked to do it), then fill in **Implementation Notes**.

**Goal:** Any Composio toolkit connects from one `sources.composio` entry whatever its auth scheme, and the Clots extend the integrations themselves: they research a toolkit, write a Composio recipe (data, never code) that turns its trigger payloads into enriched events, try it on kept samples and set it, or set a watch recipe on a read tool for a toolkit without triggers.
**Specs:** `.superpowers/specs/2026-11-21-clots-stage-2e-any-toolkit-design.md` (this follow-up; "spec section N" below means this file). It finishes stage 2e and is not a stage of its own: 2e is built per `.superpowers/specs/2026-11-19-clots-stage-2e-composio-design.md` and `.superpowers/plans/2026-11-19-clots-stage-2e-composio.md` (read that plan's Key Decisions and Implementation Notes first). Recipes: 2c spec sections 14 and 15.
**Architecture:** Auth becomes a pure choice from Composio's own toolkit metadata (`chooseAuth`), used by the component for every account, built-in or not. Composio recipes are a new list in rulebook files, checked by zod like the webhook and watch recipes. A recipe is applied in two steps that fit the existing pipeline: a synchronous mapper at intake (IDs, actor, objects, provisional text from the payload) and an enricher before routing (the recipe's read calls, then every text field rendered again). Deliveries of non-built-in toolkits are kept in a table that serves both the enricher (its payload) and the Clot's samples. The skill reaches the Clot as a local plugin the daemon writes into the Clot's home at container start.
**Tech Stack:** as stage 2e: TypeScript on Node, `@composio/core` 0.28.0 (no upgrade), better-sqlite3, zod 4, vitest, `@anthropic-ai/claude-agent-sdk`.

## Global Constraints

- Open Docker Desktop before any work, and check that `docker info` succeeds.
- No dependency changes. `@composio/core` stays at exactly 0.28.0 even though it prints "Upgrade available".
- `COMPOSIO_API_KEY` and every `.env` value an account names never reach a container, a log line, chat, a tool result or the store (store hashes only).
- The daemon never loads, evaluates or runs anything a Clot wrote. Recipes are data checked by schema; templates only read paths.
- Every recipe event has `outsider: true`. A recipe cannot change a write's rating or add an undo inverse.
- Limits, exact: at most 3 `enrich` reads per trigger; samples are the newest 5 per account and trigger, kept 7 days (a delivery younger than 1 hour is never pruned, so its enrichment can still read it); a kept payload is clipped to 64 KB; a watch on a Composio account runs every 15 minutes or less often; calendars' polling plus Composio watches ≤ 10,000 calls a month (`43200 / minutes` each).
- Spec and plan describe the design as built: when the build changes a decision, edit them in place, with no change notes.
- `src/commands.ts` and `tests/commands.test.ts` are stored with CRLF; keep them that way.
- Work on branch `stage-2e-any-toolkit`; one commit at the end (Task 7). Open a PR (it is a feature finishing 2e); do not merge without the user's yes.

## File Map

- `scripts/spike-2e.ts` (modify, Task 1): a `toolkit <slug>` mode printing metadata, and a `link <slug>` mode that makes a managed link for user `spike:<slug>` and cleans up after.
- `src/composio/api.ts` (modify): `toolkitInfo`, `triggerType`, `toolkitTools`; `ensureAuthConfig` and `connectWithKey` take an `AuthChoice`.
- `src/composio/auth.ts` (create): `ToolkitInfo`, `AuthChoice`, pure `chooseAuth`, the mismatch texts.
- `src/composio/component.ts` (modify): every account connects through `chooseAuth`; sign-in text from `info.name`; `selfIsUser`; identity from the recipe for generic toolkits; deliveries kept.
- `src/composio/store.ts` (modify): `composio_deliveries` table and its methods.
- `src/paths.ts` (create): `pathGet`, `fillPaths` (with `{a|b}`), moved from `watch.ts`.
- `src/composio/authoring.ts` (create): the logic of the four Clot tools.
- `src/composio/recipe.ts` (create): the recipe schema's helpers, `recipeMapper`, `recipeEnricher`, `renderRecipe`, the read check.
- `src/composio/intake.ts` (modify): keep the delivery; pick the recipe mapper before the generic one.
- `src/composio/toolkits/generic.ts`, `index.ts` (modify): the generic def's `identity` reads the recipe in force.
- `src/config.ts` (modify): `fields`, `scheme`, `oauthApp`, `selfIsUser` on generic entries; `apiKey` optional there.
- `src/rulebook.ts`, `src/rulebook-edit.ts`, `src/events/kinds.ts` (modify): `composio:` list in rule files, its edit kind and description, recipe kinds known for the toolkit's source; `account` form of a watch.
- `src/watch.ts` (modify): `Watcher` and `tryRecipe` take a hub chosen per recipe; a Composio hub.
- `src/tools.ts`, `src/agent/tool-server.ts`, `src/axes.ts` (modify): `composio_toolkit`, `composio_samples`, `composio_try`, `rulebook_composio`.
- `plugin/` (create, at repo root): `.claude-plugin/plugin.json` and `skills/composio-integration/SKILL.md`.
- `src/agent/container.ts`, `src/agent/runner.ts`, `src/daemon.ts` (modify): install the plugin at container start; main sessions load it; wiring.
- `src/agent/prompts.ts` (modify): one line pointing at the skill and the four tools.
- `README.md`, `clots.config.example.json` (modify).
- Tests (create): `tests/composio-auth.test.ts`, `tests/composio-recipe.test.ts`, `tests/composio-samples.test.ts`, `tests/plugin-install.test.ts`; fixtures `tests/fixtures/composio/meta/{slack,reddit,supabase,github}.json`, `tests/fixtures/composio/slack/01-channel-message.json`. Extend `config.test.ts`, `composio-component.test.ts`, `composio-intake.test.ts`, `rulebook.test.ts`, `rulebook-edit.test.ts`, `watch.test.ts`, `tools.test.ts`, `axes.test.ts`, `prompts.test.ts`.

## Key Decisions & Gotchas

**Facts already checked live (2026-11-21, read-only metadata):** `toolkits.get(slug)` returns `composioManagedAuthSchemes` and `authConfigDetails[]`, each with `mode` and `fields.connectedAccountInitiation.{required,optional}[].name`. Slack: managed `OAUTH2` only, init fields none required (optional `generic_id`); triggers (all `webhook`): `SLACK_CHANNEL_CREATED`, `SLACK_CHANNEL_MESSAGE_RECEIVED` (config `channel_id`, `channel_type`, `is_bot_message`, `is_thread_reply`), `SLACK_DIRECT_MESSAGE_RECEIVED`, `SLACK_MESSAGE_REACTION_ADDED/_REMOVED`, `SLACK_REACTION_ADDED/_REMOVED`, `SLACK_RECEIVE_BOT_MESSAGE`, `SLACK_RECEIVE_MESSAGE`. Reddit: managed `OAUTH2`, no triggers. Supabase: managed `OAUTH2`, plus `API_KEY` with required `full` and `bearer_token`. `triggers.listTypes({ toolkits })` gives `slug`, `type` (`webhook`|`poll`), `config` (JSON schema). Save these answers as the `meta` fixtures in Task 1 rather than re-deriving them.

**Auth**
- `ToolkitInfo = { slug: string; name: string; managed: string[]; schemes: { scheme: string; required: string[]; optional: string[] }[] }`, read once per toolkit per daemon life (cache in the component; a failed read is retried with the account's job).
- `AuthChoice = { kind: "managed" } | { kind: "key"; scheme: string; fields: Record<string, string> /* field name → .env key */ } | { kind: "oauthApp"; clientId: string; clientSecret: string /* .env keys */ }`.
- `chooseAuth(a, info): AuthChoice | { error: string }`, in this order: `oauthApp` → `oauthApp` if the toolkit has `OAUTH2`; `fields` or `apiKey` → the key scheme (`scheme` if given, else the toolkit's only non-OAuth scheme; several and no `scheme` → error); `apiKey` fills the scheme's single required field by its real name (zero or several required → error naming them and saying to use `fields`); `fields` must cover every required field and name no field the scheme lacks; neither → `managed` if `info.managed` is not empty, else error. Built-in toolkits go through it too: Linear/Notion/Stripe/PostHog resolve to their `API_KEY` scheme (PostHog's `connectExtra` still adds `subdomain`; it is merged after `chooseAuth`'s fields), the calendar to `managed`. Check in Task 1 that each built-in resolves to the field name it uses today (`generic_api_key`), so no existing connection is replaced.
- Error text, posted once per start in the account's channel and logged: ``<toolkit>:<account> cannot connect: <reason>. <Toolkit name> accepts: <scheme> (fields: a, b), <scheme> (Composio's sign-in).`` The account then has no connection, triggers or tools; nothing else waits on it.
- The key hash becomes a SHA-256 of the scheme and every field's value, in field-name order, so a change of any field replaces the connection through the existing staged swap. For a single `generic_api_key` it must equal today's hash of the key (keep today's formula for that case) so upgrading replaces nothing.
- `oauthApp`: an auth config of its own per account (`use_custom_auth`, `OAUTH2`, the client ID and secret as credentials), never shared or adopted; its ID and a hash of the two values are kept in `composio_accounts`. A changed hash makes a new auth config and a new sign-in, then deletes the old connection once the new one is active.
- The sign-in message for every managed or `oauthApp` account: `Sign in to <info.name> for the Clots: <url>` (the calendar keeps reading "Google Calendar", which is its `name`), and for an account without `selfIsUser` a second line: `Sign in with the Clots' own <info.name> account, not yours, unless the entry has "selfIsUser": true.` The wait, the poll and the daily re-post are the calendar's, generalised; log lines say `<info.name> (<account>) connected`.
- `selfIsUser` accounts never call `identity`; intake's self-caused check is skipped for them (the own-writes drop stays).

**Deliveries and samples**
- `composio_deliveries(webhook_id PK, user, slug, event_id, payload, received_at)`. Intake inserts a row for every verified `composio.trigger.message` whose account's toolkit has no built-in mapper, after mapping (so `event_id` is the mapped event's ID, or empty when nothing was stored). Pruning runs on insert and in the daily check: per `(user, slug)` keep the newest 5 plus anything younger than 1 hour; delete anything older than 7 days.
- `payload` is the delivery's `data` as JSON, clipped to 64 KB; a clipped payload is marked so `composio_samples` says it is partial.

**Recipes**
- Schema (in `rulebook.ts`, list key `composio`, added to `LIST_KEYS`):
  ```ts
  { name: NAME; toolkit: /^[a-z][a-z0-9_]*$/ not a built-in toolkit;
    identity?: { tool: SLUG; path: string };
    triggers: Record<TRIGGER_SLUG, { kind; title: string; id?; actorId?; actor?; body?; url?; ref?; place?; subject?: string;
      objects?: string[]; automatedWhen?: Record<string, scalar>; enrich?: { as: NAME; tool: SLUG; args?: Record<string, unknown> }[] /* max 3, unique as */ }> /* at least one */ }
  ```
  Every tool slug must start with `<TOOLKIT>_` (uppercase toolkit). Recipe names have their own namespace (not `recipeName`, since a recipe's events take the toolkit as source, not the name). Two recipes for one toolkit: the first in file order is in force and the other is reported in the file's problems, as two recipes of one name are now.
- Template context is `{ payload, enrich }`; `fillPaths` and `pathGet` from `watch.ts` as they are. `args` values that are strings are filled the same way; other values pass through. `automatedWhen` paths are read from the same context.
- **Two-step application.** Composio expects a quick answer, so intake never waits on reads. `recipeMapper` (sync, a `Mapper`): fills `id`, `actorId`, `objects`, `automatedWhen`, `kind`, and the text fields with `enrich` empty. Event ID `<toolkit>:<account>:<id>`, or `composio:<webhook-id>` when `id` is absent or fills empty. `recipeEnricher(composio, rulebook, store): Enricher`, registered as the fallback of `enricherBySource` (add an optional fallback argument): for an event whose source is a toolkit with a recipe in force and a kept delivery with that `event_id`, run the reads in order, then render every text field again with `enrich` filled. No recipe or no kept delivery → the event is returned unchanged.
- Each read: `composio.tool(slug)` must exist, belong to the toolkit, and pass `isRead` from `rating.ts`; else the line `Could not read <as>: <slug> is not a read tool.` Runs through `composio.run` on the event's account (counted by the meter). A failed run → `Could not read <as>: <error>.` appended to the body; that read's `enrich.<as>` stays empty. Field fallbacks after rendering: `actor` → `unknown`, `body` → the clipped payload JSON, `subject` → `<toolkit>:<slug>`, others → empty; `title` filling empty → the generic mapper's title.
- Identity: the generic def's `identity` uses the recipe in force (run the tool, read `path` from the data; a missing or empty value throws, so the existing retry applies). Setting or replacing a recipe whose `identity` changed clears the stored identity of that toolkit's accounts and learns it again.
- Kinds: a recipe's kinds are known for its toolkit's source in `kinds.ts` the way a webhook recipe's kinds are for its name, so rules naming `source: slack, kind: message` validate.
- Set-time checks in the `rulebook_composio` tool (they need the network, so a hand-edited file only gets the run-time ones): the toolkit has no built-in def; every `enrich` and `identity` tool exists, belongs to the toolkit and is a read. Refusal texts name the tool and the reason.

**Watches on Composio**
- `WatchSchema` gains `account?: "<toolkit>:<account>"`; exactly one of `server` and `account`. With `account`: `every ≥ 15`, `notReadOnly` refused, `tool` must start with `<TOOLKIT>_`.
- `Watcher` and `tryRecipe` take `hubFor(recipe): Hub`. The Composio hub's `listTools` answers the tool's `ToolInfo` mapped to the MCP shape with `readOnlyHint` set from `isRead` (so `checkTool` keeps working unchanged); `callTool` runs `composio.run` and returns the data as structured content, or an error result.
- The monthly sum check runs on rulebook load (a watch over the limit is not started and is listed in the file's problems: `the watch "<name>" would take Composio past 10,000 polling calls a month`) and on `watch` edits (refused with the same text). The calendars' share comes from the config.

**Tools** (main session only, present when `sources.composio` is not empty; `TOOL_AXES`: all `LOW`, the two that only read approved under the lock)
- `composio_toolkit({ toolkit, trigger? })`: without `trigger`, the name, schemes with their fields, whether managed, each trigger's slug and type, and up to 100 tool slugs each marked read or write by `isRead`; with `trigger`, that trigger's config schema and payload schema (from `triggers.getType`), clipped to 6,000 characters. Answers for any toolkit, connected or not.
- `composio_samples({ account, trigger? })`: newest first, at most 5, each with its webhook ID, slug, time and payload clipped to 4,000 characters, the whole wrapped as untrusted data.
- `composio_try({ recipe, account, sample?: webhookId, payload?: object })`: one of `sample`/`payload` (none → the newest sample of the recipe's first trigger). Parses the draft with the schema (errors returned as text), applies both steps exactly as live (reads run on the account; the tool says so in its description), and shows the event's fields. Records nothing.
- `rulebook_composio({ action: "set" | "remove", file, recipe | name })`: a new `RuleEdit` kind, applied, undone, described and refused for outsiders' turns exactly as `rulebook_webhook` is.

**The skill**
- The Agent SDK sessions here load no filesystem settings, so `~/.claude/skills` would not be found. Ship it as a local plugin: `plugin/.claude-plugin/plugin.json` (`{ "name": "clots", "version": "1.0.0" }`) and `plugin/skills/composio-integration/SKILL.md`. At every container start the daemon copies `plugin/` to `/opt/clots/plugin` in the container as root (`docker exec -u root` removes and recreates the folder, `docker cp` fills it, `chmod -R a+rX,go-w` leaves it root-owned and read-only to the Clot; `/opt` is outside the home volume, and copying on every start keeps it current), and main-session query options get `plugins: [{ type: "local", path: "/opt/clots/plugin" }]`. Workers and the sweep do not get it. Task 1 probes that the Skill tool lists `clots:composio-integration` in a main session this way; if the SDK refuses a plugin path inside the container, stop and tell the user before Task 6.
- `SKILL.md` follows spec section 9's six steps, and adds: the exact config entry forms of spec section 4; choose webhook triggers over polled ones; for a polled-only or trigger-less toolkit, ask the user before setting a polled trigger or watch, giving its monthly call cost; write recipes against at least one kept sample and try them on every kept sample; never put a secret in a recipe or a message; the Clot can set the recipe but only the user edits `clots.config.json` and `.env`. Keep it under 150 lines.
- System prompt: one line in the Composio part: to add a service, use the `composio-integration` skill.

### From the plan review (2026-11-21)

**Auth, resolved once**
- `apiKey === undefined` means "managed" today (`component.ts:91,232,503,514`, `intake.ts:103`). Replace every such test with the account's resolved auth kind: the meter's managed pool, the expired-connection message (a `fields` account is told which `.env` keys to replace, never sent a link), and the sign-in path.
- Resolve once: store the `AuthChoice` and a hash of the entry's auth fields (`apiKey`/`fields`/`scheme`/`oauthApp` names, not values) per account in `state` (`composio.auth.<user>`), and run `chooseAuth` only when that hash changes or nothing is stored. A working account never re-reads metadata at start, and a later change in Composio's metadata cannot disconnect it. No new columns on `composio_accounts`: `ComposioStore` has no migration helper, and the user's database already has the table.
- The stored `authConfigId` is reused only for the same kind and scheme (`component.ts:233`). A changed choice makes a new auth config and connection through the staged swap; the old connection stays the tool target and keeps its triggers and its intake lookup until the new one is active (for a sign-in, until the user completes it), then triggers move and the old is deleted. Never overwrite `connectionId` before the new connection is active (`component.ts:374` does today).
- When a sign-in completes, `watchSignIn` runs the account's trigger sync and identity read at once, not at the next daily check.
- The own-account sign-in line is not posted for `googlecalendar` (the calendar is the user's own by design).
- `fields` and `oauthApp` values must be `.env` keys not used by the daemon for anything else: refuse `COMPOSIO_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, the Discord and GitHub tokens, any `RECIPE_*` key, and any key another part of the config names.
- The key hash is a SHA-256 of a JSON array `[scheme, [name, value]…]` sorted by name, except that a lone `generic_api_key` keeps today's formula.
- `chooseAuth` also reads `getAuthConfigCreationFields` for `oauthApp` and refuses with the missing ones named. A toolkit marked `noAuth` needs no entry fields; Task 1 probes how Composio connects one, and `chooseAuth` returns `{ kind: "none" }` for it.

**Recipes**
- Source names must not collide: refuse a Composio recipe (and a generic account) whose toolkit is a built-in source (`github`, `sentry`, `vercel`, …: `isBuiltinSource`) or the name of a webhook or watch recipe in force, and refuse a webhook or watch recipe named like a Composio recipe's toolkit. Otherwise `enricherBySource` gives the event to the wrong enricher (`daemon.ts:450`).
- The pipeline keeps only `body`, `title` and `actor` after enrichment (`pipeline.ts:120-126`): the schema refuses `{enrich.` in any other field.
- Keys (`id`, `actorId`, `objects`) fill empty when any path is missing; `fillPaths` gains `{a|b}` (first present). Move `pathGet`/`fillPaths` to `src/paths.ts`; `watch.ts`, `webhook-recipe.ts` and `recipe.ts` import them.
- A delivery whose payload was clipped is not enriched; the event keeps its intake text and the body says the payload was too large to read.
- `identity`: before each run, check the tool is still a read (as `enrich` is).
- `learnIdentity` takes a per-user guard so a retry chain is never started twice; the generic def gets the recipe through a lookup in `ComposioDeps`, and `Composio.recipeChanged(toolkit)` (called from the rulebook's on-load hook) clears and relearns identity for that toolkit's accounts. A generic account with no recipe identity does not retry.
- A recipe shadowed by an earlier one for the same toolkit is reported by `rulebook_composio` as set but not in force, naming the one that is.
- Edits follow the existing pattern: `RuleEdit` ops `set_composio` / `remove_composio` with `was?`, mirroring `set_webhook` (`rulebook-edit.ts:275-295`), so an undo never overwrites a later change. The tool input is derived from the exported recipe schema, not copied by hand.
- Tools are named after the existing ones: `rulebook_composio` (as `rulebook_webhook`) and `composio_try` (as `watch_try`). Their logic lives in `src/composio/authoring.ts`; `tools.ts` only passes through.

**Deliveries and watches**
- `composio_deliveries` inserts with `INSERT OR IGNORE` on `webhook_id`, in the same transaction as the event.
- `WatchRecipe.server` becoming optional touches `watch.ts`, `daemon.ts:519,570`, `describeWatch` (`rulebook-edit.ts:58`) and `tool-server.ts`'s watch input: add one `watchTarget(recipe)` helper and use it everywhere.
- A Composio watch on an account that is not active skips its run, as the calendar's poll does.
- The 10,000-call check is one function in `config.ts` (today's at `config.ts:320-322`), called by config load, rulebook load and the watch edit.

**The skill**
- For `oauthApp`, the skill tells the user the redirect URL to register in their app (Task 1 records Composio's) and that scopes come from the toolkit's auth config.

## Tasks

### Task 1: Probes and fixtures
**Files:** `scripts/spike-2e.ts`, `tests/fixtures/composio/meta/*.json`
**Build:**
- Add the `toolkit <slug>` mode (prints and, with `--save`, writes `ToolkitInfo` plus trigger types to the meta fixture) and run it for slack, reddit, supabase, github, linear, notion, stripe, posthog, googlecalendar.
- Confirm from the saved metadata that every built-in toolkit resolves through `chooseAuth`'s rules to the scheme and field it uses today (record in Implementation Notes).
- Confirm `triggers.getType(slug)` returns a payload schema, and its field name.
- Probe the plugin path: one main-session turn on the home Clot with the plugin copied in, asking it to list its skills.
- Ask the user to sign in to Slack once through `link slack` (user `spike:slack`, a Slack workspace they choose, ideally as the Clots' own account), make a `SLACK_CHANNEL_MESSAGE_RECEIVED` trigger, post one message, save the delivery as the Slack fixture, then delete the user's trigger and connection.
**Done when:** fixtures saved; findings in Implementation Notes; any failed probe reported to the user before Task 2.

- [ ] Task 1 complete

### Task 2: Auth for any toolkit
**Files:** `src/composio/auth.ts`, `src/composio/api.ts`, `src/composio/component.ts`, `src/config.ts`, `tests/composio-auth.test.ts`, `tests/composio-component.test.ts`, `tests/config.test.ts`
**Interfaces:**
- Produces: `ToolkitInfo`, `AuthChoice`, `chooseAuth(a: ComposioAccount, info: ToolkitInfo): AuthChoice | { error: string }`; `ComposioApi.toolkitInfo(slug): Promise<ToolkitInfo>`, `ComposioApi.ensureAuthConfig(toolkit: string, choice: AuthChoice, secrets: Record<string, string>): Promise<string>`, `ComposioApi.connectWithKey(user, authConfigId, scheme: string, fields: Record<string, string> /* resolved values */): Promise<Connection>`; `ComposioAccount` gains `fields?: Record<string, string>` (resolved), `fieldKeys?`, `scheme?`, `oauthApp?`, `selfIsUser: boolean`; `Composio.toolkitInfo(slug)`.
**Build:** per Key Decisions "Auth". Config: generic entries get `apiKey` optional, `fields` (record of field name → env key), `scheme` (uppercase), `oauthApp`, `selfIsUser` (default false); `oauthApp` with `apiKey`/`fields` refused; `fields` with `apiKey` refused. The calendar's dedicated managed path becomes the general one.
**Tests (behaviours):**
- each meta fixture × each entry form gives the expected choice or the exact error (Slack no key → managed; Slack `apiKey` → error naming Composio's sign-in; Supabase `fields` → key with both; Supabase `apiKey` → error naming `full`, `bearer_token`; Reddit → managed; a toolkit with no managed scheme and no key → error);
- every built-in resolves to today's scheme and field, and an existing stored key hash is unchanged (no reconnect);
- a managed generic account posts `Sign in to Slack for the Clots: …` with the own-account line, once; `selfIsUser` omits the line and identity is never read;
- changing one of two `fields` replaces the connection through the staged swap; changing an `oauthApp` secret makes a new auth config and sign-in;
- a mismatch is told once per start, and the other accounts connect.
**Done when:** `npm test -- composio-auth composio-component config` passes.

- [ ] Task 2 complete

### Task 3: Deliveries and recipes at intake and enrichment
**Files:** `src/composio/store.ts`, `src/composio/recipe.ts`, `src/composio/intake.ts`, `src/composio/toolkits/{generic,index}.ts`, `src/enrich.ts`, `src/rulebook.ts`, `src/events/kinds.ts`, `src/daemon.ts` (wiring only), `tests/composio-recipe.test.ts`, `tests/composio-samples.test.ts`, `tests/composio-intake.test.ts`, `tests/rulebook.test.ts`
**Interfaces:**
- Produces: `ComposioRecipe` type and `parseComposioRecipe(value): ComposioRecipe`; `Rulebook.composioRecipe(toolkit): ComposioRecipe | undefined`; `recipeMapper(recipe: ComposioRecipe): Mapper`; `recipeEnricher(d: { composio: Composio; recipe(toolkit: string): ComposioRecipe | undefined; delivery(eventId: string): { payload: unknown; user: string } | undefined }): Enricher`; `renderRecipe(recipe, slug, account, payload, enrich, webhookId, receivedAt): Mapped` (pure, used by both steps and by `composio_try`); store `composio.keepDelivery(row)`, `composio.deliveryByEvent(eventId)`, `composio.samples(user, slug?)`, `composio.pruneDeliveries(now)`; intake deps gain `recipe(toolkit)`.
**Build:** per Key Decisions "Deliveries and samples" and "Recipes". Intake order for a non-built-in toolkit: recipe mapper if the recipe lists the slug, else the generic mapper when the account has triggers; keep the delivery either way. Self-caused check skipped for `selfIsUser`.
**Tests (behaviours):**
- schema: a built-in toolkit, a fourth read, a duplicate `as`, a tool of another toolkit, an empty `triggers` → each refused with its reason; two recipes for one toolkit → second reported;
- the Slack fixture through intake: stored as `slack:work:<channel>:<ts>`, kind `message`, outsider; the enricher then fills title and actor from fake reads; a failed read leaves its line and the event goes on; a write tool named in `enrich` is not called;
- `actorId` equal to the learned identity → dropped as self-caused; same with `selfIsUser` → not dropped;
- an unlisted trigger of a toolkit with a recipe → generic event; a recipe with no `id` → `composio:<webhook-id>`;
- samples: the sixth delivery prunes the oldest unless it is younger than an hour; 7-day-old rows go; a 70 KB payload is clipped and marked;
- rules with `source: slack, kind: message` validate once the recipe is in force.
**Done when:** `npm test -- composio-recipe composio-samples composio-intake rulebook` passes.

- [ ] Task 3 complete

### Task 4: Watch recipes on Composio read tools
**Files:** `src/rulebook.ts`, `src/watch.ts`, `src/daemon.ts` (wiring), `tests/watch.test.ts`, `tests/rulebook.test.ts`
**Interfaces:** Consumes `Composio.run`, `Composio.tool`, `isRead`. Produces `composioHub(c: Composio): Hub`; `Watcher` deps `hubFor(recipe): Hub`.
**Build:** per Key Decisions "Watches on Composio".
**Tests (behaviours):** a watch with `account` and a read tool reports new items as `item_added`; `every: 5` refused; `server` and `account` together refused; a write tool is refused at run like a non-read MCP tool; the monthly sum refuses the watch that crosses 10,000 and starts the others.
**Done when:** `npm test -- watch rulebook` passes.

- [ ] Task 4 complete

### Task 5: The Clot's tools
**Files:** `src/composio/api.ts` (`triggerType`, `toolkitTools`), `src/tools.ts`, `src/agent/tool-server.ts`, `src/axes.ts`, `src/rulebook-edit.ts`, `tests/tools.test.ts`, `tests/axes.test.ts`, `tests/rulebook-edit.test.ts`
**Interfaces:** Produces `DaemonTools.composioToolkit?`, `composioSamples?`, `composioRecipeTry?`, `composioRecipe?` (string results); `RuleEdit` gains `{ kind: "composio"; action: "set"; file; recipe } | { kind: "composio"; action: "remove"; file; name }`; `describeComposioRecipe(recipe): string` (toolkit, triggers mapped, reads named).
**Build:** per Key Decisions "Tools". Tool descriptions say what each does in one or two sentences and that samples and tried payloads are other people's text.
**Tests (behaviours):** `composio_toolkit slack` lists both the managed scheme and the nine triggers as webhook; with a trigger it shows its config schema; `composio_samples` wraps as untrusted and clips; `composio_try` on a kept sample shows the rendered event and stores nothing; a draft with a schema error returns the error; `rulebook_composio set` with a write tool in `enrich` is refused naming it; set → posted with its undo, undo removes it; in an outsider's turn it is put to the user; the read-only two are approved under the lock.
**Done when:** `npm test -- tools axes rulebook-edit` passes.

- [ ] Task 5 complete

### Task 6: The skill as a plugin
**Files:** `plugin/.claude-plugin/plugin.json`, `plugin/skills/composio-integration/SKILL.md`, `src/agent/container.ts`, `src/agent/runner.ts`, `src/daemon.ts`, `src/agent/prompts.ts`, `tests/plugin-install.test.ts`, `tests/prompts.test.ts`
**Interfaces:** Produces `installPlugin(container: string, source: string): Promise<void>` (docker args built by a pure function, as `dockerExecArgs` is); main-session options gain `plugins`.
**Build:** per Key Decisions "The skill". Install after `ensureContainer` succeeds for each Clot, on every daemon start; a failed install is logged and the Clot still starts.
**Tests (behaviours):** the docker argument lists remove, copy and chown in that order; main-session options carry the plugin and worker ones do not; the prompt has the skill line; `SKILL.md` names all four tools and the config fields `apiKey`, `fields`, `scheme`, `oauthApp`, `selfIsUser`, `triggers` (a test reads the file, so renames break it).
**Done when:** `npm test -- plugin-install prompts runner` passes.

- [ ] Task 6 complete

### Task 7: Docs, full run and the PR
**Files:** `README.md`, `clots.config.example.json`, spec and plan (only where the build changed a decision)
**Build:** README's Composio section: the auth forms with Slack, Supabase and an `oauthApp` example; `selfIsUser`; "To add a service, ask a Clot" with what the skill does and what is left to the user; Composio recipes and Composio watches in the Recipes section; the `&close` reminder (resumed sessions keep their old prompt). Example config gains the Slack and Supabase entries of spec section 4.
**Done when:** `npm test` and `npm run typecheck` pass; the daemon starts against the user's config and every existing account reconnects with no new connection or trigger (log and store); one commit; PR open.

- [ ] Task 7 complete

## Manual Verification Checklist

**Shared setup:** Docker Desktop open and `docker info` succeeds; `npm install`; `npm run image`; `tailscale funnel --bg 8787`; the daemon as a background process (`npm run daemon`); `&close` in each Clot's channel after the build so sessions take the new prompt and plugin. Stop the daemon by killing the process listening on 8787.

#### MV-1: Upgrading changes nothing for the existing accounts
- **Setup:** the user's current config.
- **Steps:** 1. Start the daemon. 2. Compare `composio_accounts` connection IDs and `composio_triggers` with a copy taken before.
- **Expected:** identical rows; no sign-in link; no "cannot connect" message.
- **How the executor runs it:** CLI and sqlite query.

#### MV-2: A mismatched entry is explained
- **Setup:** add `{ "toolkit": "slack", "account": "bad", "shared": true, "apiKey": "SLACK_BAD_KEY" }` with any value in `.env`.
- **Steps:** start the daemon; read the home Clot's channel.
- **Expected:** one message `slack:bad cannot connect: …` naming Slack's accepted scheme as Composio's sign-in; other accounts connect. Remove the entry afterwards.
- **How the executor runs it:** CLI; channel read through the daemon's log of posts.

#### MV-3: The skill walks the Clot through Slack
- **Steps:** 1. In the home Clot's chat: "I want Slack messages from #clots-test." 2. Follow what it says.
- **Expected:** it uses the skill, calls `composio_toolkit slack`, proposes `SLACK_CHANNEL_MESSAGE_RECEIVED` (a webhook trigger), gives the exact `sources.composio` entry with no key, asks whether the Clots have their own Slack account, and says a restart applies it. It does not edit `clots.config.json` itself.
- **How the executor runs it:** `[user-only]`: the chat and the Slack workspace are the user's.

#### MV-4: Managed sign-in for Slack
- **Setup:** the entry from MV-3 added; restart.
- **Steps:** open the posted link and approve.
- **Expected:** exactly one `Sign in to Slack for the Clots: …` with the own-account line; within a minute the log says `Slack (work) connected`; the trigger instance exists.
- **How the executor runs it:** `[user-only]` (OAuth sign-in).

#### MV-5: A recipe from a kept sample
- **Steps:** 1. Post a message in the channel. 2. Ask the Clot to finish the Slack setup.
- **Expected:** the first message arrives as a generic `trigger` event; the Clot calls `composio_samples`, `composio_try` (shown event has the channel's and author's names), then `rulebook_composio set`, posted with its undo. The next message arrives as `slack / message`, title `Message in #clots-test`, actor the author's name, outsider.
- **How the executor runs it:** `[user-only]` for chat and Slack; executor checks the events table.

#### MV-6: The Clot's own Slack message is not an event
- **Steps:** ask the Clot to post "composio check" in the channel.
- **Expected:** the write runs or asks per the team rating; its delivery is stored dropped "caused by the Clot itself". With `selfIsUser: true` instead, the user's own messages still arrive.
- **How the executor runs it:** `[user-only]`; executor checks the store.

#### MV-7: Supabase with a two-field key
- **Setup:** the Supabase entry of spec section 4 and its two `.env` keys (the user's project).
- **Steps:** restart; ask the Clot to list the project's tables through `composio_find`/`composio_run`.
- **Expected:** connected without a sign-in link; the read runs and answers.
- **How the executor runs it:** `[user-only]` for the keys; the rest by the executor through the home Clot.

#### MV-8: Reddit through a watch
- **Setup:** `{ "toolkit": "reddit", "account": "me", "shared": true }`; sign in through the posted link.
- **Steps:** ask the Clot to watch new posts in a small subreddit; then `every: 5` in a hand edit.
- **Expected:** the Clot sets a watch with `account: reddit:me` and `every ≥ 15` after saying its monthly cost; new posts arrive as `item_added`; the hand edit with `every: 5` is reported as a problem and not run.
- **How the executor runs it:** `[user-only]` for the sign-in and chat.

#### MV-9: Recipes cannot widen anything
- **Steps:** ask the Clot to set a recipe for `linear`, then one whose `enrich` names `SLACK_CHAT_POST_MESSAGE`.
- **Expected:** both refused with the reason; nothing written to the rule file.
- **How the executor runs it:** `[user-only]` for the chat; the executor confirms with `git diff rulebook/` that no file changed.

#### MV-10: The Clot cannot change its plugin
- **Steps:** `docker exec clot-home sh -c 'echo x >> /opt/clots/plugin/skills/composio-integration/SKILL.md'`; then `docker exec -u root clot-home sh -c 'echo x >> /opt/clots/plugin/skills/composio-integration/SKILL.md'`; restart the daemon; `docker exec clot-home tail -1 /opt/clots/plugin/skills/composio-integration/SKILL.md`.
- **Expected:** the first write fails with "Permission denied"; after the restart the last line is the repository file's, not `x`.
- **How the executor runs it:** CLI.

#### MV-11: Regressions
- **Steps:** a Linear issue, a Notion comment and a calendar reminder, as in stage 2e's MV-3, MV-5 and MV-6.
- **Expected:** each arrives exactly as before.
- **How the executor runs it:** `[user-only]` for making them; executor checks the store.

## Out of Scope

- Recipes that rate writes or add undo inverses; Clot-written code run by the daemon (spec section 14).
- Moving Linear or Notion to webhook triggers through `oauthApp`.
- Upgrading `@composio/core`.
- Stage 3's onboarding entries.

## Implementation Notes
_Filled in by the executor: deviations and why, changed names/interfaces, surprises, notes for the next stage's planner._
