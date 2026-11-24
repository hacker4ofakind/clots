# Clots stage 4a: web UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. This plan gives structure and decisions, not code. You write the implementation (TDD per task). Track tasks with the checkboxes. After all tasks, run the **Manual Verification Checklist** (or hand it to the user if they asked to do it), then fill in **Implementation Notes**.

**Goal:** Replace Discord with a Next.js web app (desktop and phone, installable, with push) that talks to the daemon through a private API.
**Specs:** `.superpowers/specs/2026-11-23-clots-stage-4a-web-ui-design.md` (this stage); parent `.superpowers/specs/2026-10-10-clots-design.md`.
**Architecture:** The daemon gains a loopback UI API (`127.0.0.1:8788`, JSON + one SSE stream) and a conversation store that replaces the `ChatAdapter`. A Next.js App Router app in the `web/` workspace renders every screen, calls the API only from the server side (route handlers, server components, an SSE proxy), and is published tailnet-only with `tailscale serve` on 8443.
**Tech Stack:** TypeScript, Node, better-sqlite3, zod 4, Next.js (App Router), React, Tailwind CSS v4, shadcn/ui (CLI), `@phosphor-icons/react`, `motion`, `next-themes`, `react-markdown` + `remark-gfm`, `web-push`, `sharp`, vitest, Playwright + `@axe-core/playwright`.

## Global Constraints

- UI API: `127.0.0.1:8788`, base path `/api/v1`, header `X-Clots-UI-Secret` = `.env` `CLOTS_UI_SECRET` (generated on first start if missing). Never on 8787.
- Web app: `127.0.0.1:3000`; published with `tailscale serve --bg --https=8443 http://127.0.0.1:3000`; Funnel stays on 443 for webhooks only.
- Access: header `Tailscale-User-Login` must equal `ui.owner` in `clots.config.json`; else a 403 page.
- Config: `choiceTimeoutMinutes` is renamed `askTimeoutMinutes` (default 10); `sendReview` is removed; `discord` is removed; `ui: { owner: string }` is added.
- Every ask has `deadline = openedAt + askTimeoutMinutes`. Choice past deadline: the Clot's pick (existing timeout turn). Every other kind past deadline: closed as blocked.
- Timer states: calm > 5 min, calling 5 to 1 min, urgent < 1 min.
- Commands start with `/`; same set as `&` today.
- VAPID keys in `.env`: `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` (generated on first start).
- New integration key names: `<TOOLKIT>_<ACCOUNT>_KEY`, upper case.
- Planned features (daily todo, voice, browser use, computer use, Secret Storage) are absent from the build: no buttons, toggles, rail items or settings pages.
- UI copy follows the design system README: the Clot's name alone, verbs on buttons, no em dashes.
- Mockup to code: never copy the canvas's markup, icon masks or classes. shadcn components (added with `npx shadcn@latest add …` in `web/`, then restyled), `@phosphor-icons/react`, `next/image`, tokens only (no literal colours).
- Dependencies: `npm install -w <workspace> <pkg>`; never hand-edit `package-lock.json`.
- Commit once at the end of the stage (one feature).

## File Map

Daemon (root workspace):
- `package.json` (modify): `workspaces: ["web", "packages/*"]`; scripts `web`, `web:build`, `test:e2e`.
- `src/ui-api/server.ts` (create): the loopback HTTP server, secret check, routing.
- `src/ui-api/schemas.ts` (create): zod request/response schemas, exported to `web/`.
- `src/ui-api/routes/*.ts` (create): clots, messages, asks, workers, settings, keys, integrations, push, img placeholder none.
- `src/ui-api/events.ts` (create): the event bus with a 1,000-event replay ring and SSE writer.
- `src/conversation/store.ts` (create): message rows, paging, UI preferences.
- `src/conversation/conversation.ts` (create): the `Conversation` interface implementation (replaces `ChatAdapter`).
- `src/conversation/activity-lines.ts` (create): tool call → one line with an icon name.
- `src/chat/` (delete), `src/asks-migration.ts` (review; drop Discord-only parts).
- `src/clot.ts`, `src/pipeline.ts`, `src/waiting.ts`, `src/workers.ts`, `src/global-memory.ts`, `src/daemon.ts` (modify): post through `Conversation`, no channels.
- `src/asks.ts`, `src/asks/*.ts` (modify): answers instead of reply matching, deadlines on every kind.
- `src/commands.ts` (modify): `/` prefix, command list export.
- `src/agent/runner.ts` (modify): partial messages → text deltas; tool calls → activity callback.
- `src/store.ts` (modify): migration dropping `category_id`/`channel_id`, new tables.
- `src/config.ts`, `src/config-edit.ts` (modify); `src/config-store.ts` (create): load, validate, atomic write with backup, watch, apply handlers.
- `src/push.ts` (create): VAPID, subscriptions, sends.
- `src/onboarding/*.ts` (create): New Clot creation, repo access, icon processing, checklist.
- `src/integrations/configurer.ts` (create): the configurer session and its tools.
- `deploy/update.sh` (modify), `deploy/clots-web.service` (create), `README.md` (modify).
- `tests/**` (create/modify) per task.

Web (`web/` workspace):
- `web/app/layout.tsx`, `web/app/globals.css` (tokens), `web/middleware.ts` (Tailscale check).
- `web/app/(app)/…` routes: `/` (redirects to Waiting), `/waiting`, `/c/[clot]`, `/settings/{general,clots,integrations}`, `/new`.
- `web/app/api/stream/route.ts` (SSE proxy), `web/app/api/**/route.ts` (actions proxied to the daemon).
- `web/lib/daemon.ts` (typed client), `web/lib/stream.ts` (client hook with reconnect).
- `web/components/ui/*` (shadcn), `web/components/clots/*` (rail, chat, composer, ask-card, ask-actions, timer, worker-card, time-input, side-pane, logo, clapboard-icon placeholder for 4b).
- `web/public/manifest.webmanifest`, `web/public/sw.js`, icons from the logo mark.
- `web/e2e/*.spec.ts` (Playwright), `web/e2e/fake-daemon.ts`.

## Key Decisions & Gotchas

- **`Conversation` keeps the adapter's verbs but is keyed by Clot, not channel.** Every `chat.post(channelId, …)` becomes `conv.post(clot, …)`; categories, channel creation, read-only, pins, `channelExists`, `mention`, `channelLink` disappear. A rollover creates a new session row and a `note` message; it no longer creates anything else. `sessionByChannel` is replaced by "active session of a Clot". Read every call site in `clot.ts` (about 40) and `asks.ts` before starting: the order of "save, then announce" in `rollover` must be kept (the comment at "Saved before anything is announced").
- **Store migration**: SQLite ≥3.35 supports `ALTER TABLE … DROP COLUMN`; drop `clots.category_id`, `sessions.channel_id`, `inbox.channel_id`, `asks.channel_id`, `asks.channel_name`. Inbox rows that need a "where to answer" use the Clot. Run it inside the existing schema-version step so a restart mid-migration is safe.
- **Asks**: replace `onReply(ask, text, io)` with two methods: `onAnswer(ask, answer, io)` for buttons and `onFeedback(ask, text, io)` for chat text (today's "any other reply" branch of each kind, moved unchanged). Delete the exact-word matchers. `AskIo.repeat` and `dropChannel` go; `close` posts a `note` and an `ask.closed` event. Kinds `config` and `restart` stay (a config key that needs a restart still asks). Add `onDeadline` to every kind: choice keeps its timeout turn; others close as blocked with the note "Blocked: no answer within N minutes." `stale()` withdrawals are unchanged.
- **Email edit**: the answer `{ action: "edit", body }` replaces the payload's body, then runs the same path as allow; the note to the main session quotes the user's changed lines (a simple line diff, removed and added).
- **Waiting summary** comes from open asks; `clots-waiting` pin logic in `waiting.ts` is removed, but its list-building (summary, deadline) is reused by the API.
- **Streaming**: set `includePartialMessages: true` on main-session turns only; forward `stream_event` text deltas as `message.delta` with the message's id, and keep posting the final text exactly as `onText` does today (the stored message is the final text). Workers stay non-streaming.
- **Activity lines**: runner already reports tool use to `src/agent/activity.ts` for the turn summary; add a per-call callback producing `{ icon, text }` (`Read issue #31`, `Searched the code for "delete"`, `Asking to send an email`). Icon names are Phosphor component names, rendered by the web app from a fixed map.
- **SSE through Next.js**: the route handler must return a streaming `Response` (`ReadableStream`), set `export const dynamic = "force-dynamic"`, and pipe the daemon's body through with the secret added; disable compression for that route. Heartbeat every 20 s keeps `tailscale serve` from closing it.
- **shadcn on Tailwind v4**: run `npx shadcn@latest init` in `web/` (choose Neutral, CSS variables), then replace its generated variables with the design system tokens (`tokens.json` from the design system; names are already shadcn's). Map extras (`highlight`, `calling`, `primary-ink`, `foreground-soft`, `muted-strong`, `tile`, `brand`) in `@theme inline`. shadcn `accent` = the value of `muted`.
- **Fonts**: `next/font/google` for Rethink Sans and Red Hat Mono, as `--font-sans` / `--font-mono`.
- **Phosphor in RSC**: import from `@phosphor-icons/react/dist/ssr` in server components, `@phosphor-icons/react` in client components.
- **Clot icons**: a Clot's icon is either `{ phosphor: "Sliders", color }` or an uploaded file; the active variant of an upload is precomputed with `sharp` (count opaque-pixel colour clusters: exactly 2 → swap, else negate) and stored beside it.
- **Hot reload apply handlers**: register per top-level key; the Composio sync and email (IMAP) source restarts already exist as functions called at startup: call them with the new config. Keys flagged `restart` (intake port, image, `ui.owner`) are saved and reported, not applied.
- **`.env` writing**: reuse `src/env-file.ts` for reading; writing keeps comments and order, replaces a key's line in place, appends new keys; atomic write like the config.
- **Configurer**: a throwaway Agent SDK session in the daemon (not in a container), `model: "claude-sonnet-5-5"`, effort medium, with the existing `plugin/skills/composio-integration` skill content in its system prompt and only these tools via `createSdkMcpServer`: `toolkit_info`, `trigger_types`, `web_search`, `web_fetch`, `save_integration`. No Bash, no file tools. `save_integration` validates with the `sources.composio` entry schema; the API key value is never in its context.
- **OAuth link**: from the existing Composio connect flow in `src/composio/auth.ts`/`hub.ts` (managed link), never from the configurer.
- **Discord leftovers**: `config.ts` must accept a file that still has `discord` (ignore with one log line) so the Pi does not fail to start after deploy; `ui.owner` missing → the web app shows a setup page naming the key.
- **Tests that used `src/chat/fake.ts`** move to a fake `Conversation` with the same recording style.

### From the stress test (apply all)
- **Access:** `tailscale serve` sets `Tailscale-User-Login` only for tailnet users; middleware checks `Tailscale-User-Login` == `ui.owner` and `Host` == the configured serve host; `web/lib/daemon.ts` re-checks the owner on every server-side call (defence in depth against middleware bypasses); missing `ui.owner` fails closed to the setup page. The test-only owner env var is ignored when `NODE_ENV=production`.
- **CSRF:** every mutating route handler goes through one wrapper requiring `Origin` == own origin, `Content-Type: application/json` (multipart only for uploads), and the owner check. One catch-all proxy route (`web/app/api/d/[...path]/route.ts`) forwards to the daemon through that wrapper, plus the separate stream route; no per-action route files.
- **Pin and audit:** pin Next.js and React to patched versions (CVE-2025-29927, CVE-2025-55182); `npm audit --omit=dev` clean in Task 1 and Task 11.
- **CSP:** site-wide CSP (`default-src 'self'`, `img-src 'self' data:` plus the proxy, no inline script beyond Next's nonce); `X-Content-Type-Options: nosniff` on every daemon-served file.
- **Clot icons:** SVG uploads are rasterized with `sharp` to PNG; only PNG, JPEG, WebP (magic-byte checked) are stored; ICO is converted client-side or refused with a clear message (sharp cannot read it).
- **Markdown:** images in markdown (`![]()`) are not loaded directly: they render as a link, or through the 4b proxy once it exists. Widgets render only in `clot` messages (4b), never in notes, asks or user text.
- **Keys:** names must match `^[A-Z][A-Z0-9_]{0,63}$`; values may not contain `\r` or `\n`; `CLOTS_UI_SECRET`, `VAPID_*` and `CLAUDE_CODE_OAUTH_TOKEN` are not writable from the UI. Removing a key still named by the config is refused, naming the users of it.
- **Runtime env:** the daemon was started with `node --env-file`, so keys written at runtime are not in `process.env`. Every secret lookup goes through the config store's live `.env` map, never `process.env`. The API-key connect flow writes the key **before** the entry (or saves the entry only once the key exists), because `loadConfig` requires every named key.
- **Clot-made config changes:** hot reload removes today's de facto gate (changes took effect only after `daemon_restart`). So `set_config` from a Clot always goes through the existing `config` ask (no SAFE_KEYS shortcut); add `ui` to `BLOCKED_KEYS`. The UI's own saves apply directly.
- **Configurer:** the daemon overwrites audience, scope and owning Clot in the saved entry with the user's Options choices; its `web_fetch` uses the same SSRF guard as the 4b image proxy (shared module `src/net/safe-fetch.ts`, built here).
- **Push:** subscription endpoints must be https on known push hosts (`*.push.apple.com`, `fcm.googleapis.com`, `updates.push.services.mozilla.com`, `*.notify.windows.com`); `notificationclick` opens only same-origin paths. "No tab open" means no client that was **visible and active in the last 2 minutes** (the client reports `visibilitychange` over a tiny POST), so a desktop tab left open at home does not suppress the phone's pushes; the SSE proxy aborts its upstream when the browser disconnects.
- **Web service env:** `clots-web.service` gets its own env file with only `CLOTS_UI_SECRET` and the daemon URL, never the full `.env`.
- **Input hardening:** per-route body limits (messages 20 MB with images, others 256 KB); Clot names are letters, digits and hyphens, starting with a letter, up to 31 characters, capitals allowed (the slug, the name in lower case, names the container, volumes and rule file); repo as `owner/name` validated; `docker`/`git` via argv arrays only; the token scrubbed from clone logs.
- **Message idempotency:** the client generates the message id (UUID) and reuses it on Retry; the API keeps `INSERT OR IGNORE` semantics (today Discord's id did this). Same for ask answers (idempotency key).
- **Event ids:** `<bootId>-<seq>`; a `Last-Event-ID` with another boot id gets `resync`. The stream route forwards `Last-Event-ID`; the page subscribes before its server data is considered fresh (or refetches after `open`).
- **Phone resume:** on `visibilitychange` to visible and on stream reconnect, refetch the open screen and asks. Timers compute from the server deadline; a card past zero reads "Closing…" until `ask.closed` arrives.
- **Asks UI:** buttons disable with a spinner until the daemon replies; failure keeps the card with Retry; the closed outcome shows on the card itself, not only a toast. An email edit that hits 409 keeps the edited text in the card with the outcome. `/commands`, widget submits and image-only messages are **not** feedback to an open ask. Answering a busy ask returns `{ outcome: "in progress" }`.
- **Option numbering:** choices are stored with pick 1|2; the API uses 0|1. Convert in one place (`routes/asks.ts`) and test it.
- **Upgrade:** asks open before the upgrade get `deadline = now + askTimeoutMinutes` at first start.
- **Startup-captured config:** `src/daemon.ts` builds the email ask kind only when an inbox exists (lines ~256-259) and reads the ask timeout once (~263, ~421). Make both read the live config so adding the first inbox and changing the timeout work without restart.
- **File watching:** watch the directory, not the file (atomic renames replace the inode); ignore the store's own writes by comparing content hash with the last write.
- **Clot lifecycle:** delete refuses while config entries (accounts scoped to the Clot) still name it, listing them; pending inbox rows of a deleted Clot are dropped. Renaming a Clot is not offered in Edit (name is fixed once created); changing the repository in Edit re-clones into a fresh volume. Create starts the container in the create flow and the reload handler skips Clots whose create is in progress (no double `docker run`); a failed create removes the config entry so the name is free.
- **Integration dialog:** re-Finish after Back updates the same job's entry, never duplicates it; an abandoned OAuth removes its config entry with the Composio connection; account names are slugged to `[A-Z0-9_]` for key names.
- **Composer:** drafts persisted per Clot in `localStorage`; on touch devices Enter inserts a newline and the button sends; inputs ≥ 16px; layout uses `dvh`/`visualViewport` so the composer stays above the keyboard; pasted phone images are downscaled client-side to ≤ 2048 px JPEG before upload.
- **Chat states:** skeletons shaped like the chat and the Clots list on first load; scroll anchoring when older pages prepend; auto-follow streaming only when already at the bottom, else a "New messages" pill; reserve image dimensions.
- **Interrupted flows:** New Clot step state kept in the URL; Settings warns on leaving with unsaved edits; a reload during a build shows the build progress from the Clot's state.
- **Notifications row:** phone Waiting shows the notification state (on, off, denied with how to fix) and "Send a test notification".
- **Accessibility:** keyboard reorder for the rail (move up/down in its context menu) and keyboard resize for the pane; `motion` honours reduced motion; timer states carry their text, not colour only; the email preview opens on focus and tap too.
- **Code layout:** API schemas live in a workspace package `packages/ui-api-schemas` (imported by daemon and web), not under `src/`. Reuse `src/intake.ts`'s request helpers (body cap, JSON parsing) for the UI API server. New tables get their own modules (`src/conversation/store.ts`, `src/push.ts`), not more of `src/store.ts`. Ask deadlines and timers use an injected clock.
- **shadcn components to add in Task 1:** button, input, textarea, select, switch, checkbox, label, dialog, sheet, drawer, dropdown-menu, context-menu, command, popover, tooltip, sonner, skeleton, scroll-area, resizable, toggle-group, tabs, card, badge, progress, spinner, empty. Icon picker loads its icon list lazily (a generated name list plus dynamic import), never the whole library in the main bundle.
- **Offline page:** the service worker precaches only `/offline` (static, no data) and serves it when a navigation fetch fails: "Connect Tailscale to reach Clots." with a Retry button that reloads.
- **Parser:** Claritee (4b) keeps its hand-written parser; `jsep`/`acorn` were considered and rejected (markup inside expressions, `++` on any variable).
- **Backups:** `deploy/backup.sh` also covers `data/icons` and the conversation tables (already in SQLite).

## Tasks

### Task 1: Workspaces, web scaffold, tokens, access check
**Files:** `package.json`, `web/**` (Next app, shadcn init, `globals.css`, `layout.tsx`, `middleware.ts`), `web/lib/daemon.ts` (empty typed shell)
**Interfaces:** Produces: `npm run web` (dev on :3000), `npm run web:build`.
**Build:**
- npm workspaces; Next.js App Router with TypeScript and Tailwind v4; shadcn init and the components listed under "From the stress test".
- Tokens from the design system in `globals.css` (light `:root`, `.dark`), `next-themes` with `attribute="class"`.
- Middleware: Tailscale identity check against `ui.owner` (read from the daemon settings endpoint, cached 60 s; until Task 2 exists, from an env var in tests).
**Tests (behaviours):**
- request with matching `Tailscale-User-Login` → page renders; mismatched or missing → 403 page; a `Host` other than the configured serve host → 403.
- `npm run web:build` succeeds with no type errors.
**Done when:** `npm run web:build` and `npm test -w web` pass.
- [ ] Task 1 complete

### Task 2: UI API server and event stream
**Files:** `src/ui-api/server.ts`, `src/ui-api/events.ts`, `src/ui-api/schemas.ts`, `src/daemon.ts` (start it), `tests/ui-api/*.test.ts`
**Interfaces:**
- Produces: `EventBus.emit(type: UiEventType, data: unknown): void`; `UiEventType` = `"message.created" | "message.delta" | "message.done" | "activity" | "clot.state" | "ask.opened" | "ask.updated" | "ask.closed" | "workers.updated" | "config.changed" | "clot.build" | "integration.status" | "resync"`.
- Produces: `registerRoute(method, path, handler(req, body) => Promise<Json>)`; handlers validate with schemas from `schemas.ts`.
**Build:**
- Loopback server on 8788 with secret check (constant-time compare); 401 without it.
- SSE at `/api/v1/stream`: replay from `Last-Event-ID` if in the ring, else a `resync` event; heartbeat 20 s.
- Generate `CLOTS_UI_SECRET` into `.env` on first start.
**Tests (behaviours):**
- no secret → 401; wrong secret → 401; right secret → route runs.
- reconnect with a recent id → missed events in order; with an id older than the ring → `resync`.
- port 8787 does not serve `/api/v1`.
**Done when:** `npm test` passes.
- [ ] Task 2 complete

### Task 3: Conversation store replaces Discord
_Execute in two passes with a green test run between them: (a) store, migration, `Conversation`, routes and `asks`/`waiting` call sites; (b) `clot.ts` (about 40 call sites), runner streaming, activity lines, images, deleting `src/chat/`._
**Files:** `src/conversation/{store,conversation,activity-lines}.ts`, `src/store.ts` (migration), `src/clot.ts`, `src/pipeline.ts`, `src/waiting.ts`, `src/workers.ts`, `src/global-memory.ts`, `src/daemon.ts`, `src/agent/runner.ts`, delete `src/chat/**`, remove `discord.js`; tests moved to a fake `Conversation`
**Interfaces:**
- Produces: `interface Conversation { post(clot, text, o?: { kind?: "clot" | "note"; recap?: boolean }): Promise<string>; postActivity(clot, a: TurnActivity): Promise<void>; activityLine(clot, l: { icon: string; text: string }): void; setState(clot, s: "idle" | "working" | "paused" | "failed", reason?: string): void; postAsk(clot, askId): Promise<string>; postWorkers(clot, turnId): Promise<string>; delta(clot, messageId, text): void }`.
- Produces: message row `{ id, clot, sessionId, kind: "user" | "clot" | "activity" | "note" | "ask" | "workers", text, ref: string | null, createdAt }`; `listMessages(clot, before?: string, limit = 50)`.
- Produces routes: `GET /clots`, `GET /clots/:clot`, `GET /clots/:clot/messages?before=`, `POST /clots/:clot/messages` (text, images[] as data URLs ≤ 5 MB each), `GET /commands`.
**Build:**
- Migration dropping channel/category columns (see Key Decisions).
- Every channel post in the listed files goes through `Conversation`; user messages from the API enter the existing queue path (`store.enqueue`) with the Clot as the key.
- Rollover: new session row + `note` with the recap (folded); no channels.
- Runner: partial messages on main-session turns → `delta`; per-tool-call activity lines.
- Images attached to a message reach the session as image content blocks.
- `/` commands (Task 5 finishes the list; parsing moves here).
**Tests (behaviours):**
- a message sent via the API is queued for its Clot and the reply is stored as `clot`, with deltas emitted before `message.done`.
- a rollover adds one `note` and the next message's `sessionId` differs; older messages still page back.
- a worker turn produces no activity lines; a main turn produces one per tool call and one summary.
- the store migrates a database with the old columns without losing sessions or asks.
- no file under `src/` imports `discord.js` (a test that greps the source).
**Done when:** `npm test` and `npm run typecheck` pass.
- [ ] Task 3 complete

### Task 4: Asks answered in the UI, deadlines on every ask
**Files:** `src/asks.ts`, `src/asks/*.ts`, `src/config.ts` (rename, removals), `src/asks-migration.ts`, `src/ui-api/routes/asks.ts`, tests
**Interfaces:**
- Produces: `type AskAnswer = { action: "allow" } | { action: "block" } | { action: "edit"; body: string } | { action: "pick"; option: 0 | 1 }`.
- Produces: `AskKind.onAnswer(ask, answer: AskAnswer, io)`, `AskKind.onFeedback(ask, text, io)`, `AskKind.onDeadline(ask, io)` (required on every kind).
- Produces routes: `GET /asks` (open asks with `{ id, clot, kind, summary, details, deadline, timer: "calm" | "calling" | "urgent", options?, pick? }`), `POST /asks/:id/answer` → `{ outcome }` (already closed → the stored outcome, HTTP 409).
**Build:**
- Remove exact-reply matching; a user message in a Clot's chat while one of its asks is open goes to that ask's `onFeedback` (most recent open ask of the Clot).
- `askTimeoutMinutes` on every ask (config migration renames `choiceTimeoutMinutes`; `sendReview` dropped, ignoring it if present).
- `ask.updated` events when the timer state changes (scheduled at the 5-minute and 1-minute marks).
- Email `edit` (Key Decisions).
**Tests (behaviours):**
- each kind: allow runs it, block declines it, deadline blocks it (merge not merged, email not sent, rule not applied, memory reverted), choice deadline takes the pick.
- answering twice → second gets 409 with the first outcome.
- an edited email sends the edited body and the main session's note lists the changed lines.
- typed text while an email ask is open reaches the main session as feedback and closes the ask as today.
- a restart with a passed deadline closes it at start.
- a config with `choiceTimeoutMinutes: 20` loads as `askTimeoutMinutes: 20`.
**Done when:** `npm test` passes.
- [ ] Task 4 complete

### Task 5: Commands, workers and settings endpoints
**Files:** `src/commands.ts`, `src/workers.ts`, `src/ui-api/routes/{workers,settings}.ts`, `src/conversation/store.ts` (UI preferences), tests
**Interfaces:**
- Produces: `GET /commands` → `[{ name: "effort", options: "low or medium", description: "Sets the effort for your next message" }, …]` for: effort, close, rules (undo), memory (undo), spend, calendar undo, composio undo.
- Produces: `GET /turns/:id/workers` → `[{ id, brief, model, effort, status: "queued" | "running" | "pr-open" | "failed", pr?: string }]`; `workers.updated` events.
- Produces: `GET/PUT /settings/general`, `GET/PUT /settings/ui` (`{ theme, contentWidth: "wide" | "medium" | "narrow", paneWidths: Record<string, number>, notificationsDismissed: boolean }`).
**Build:**
- `/` parsing with the same semantics as `&`; `&` no longer recognised.
- A `workers` message posted once after the turn that dispatched them.
**Tests (behaviours):**
- `/close nosummary` behaves like `&close nosummary` did; `&close` is sent to the model as text.
- worker statuses move queued → running → pr-open and emit events.
- UI preferences persist across a daemon restart.
**Done when:** `npm test` passes.
- [ ] Task 5 complete

### Task 6: Desktop chat, Waiting for you, shell
**Files:** `web/app/(app)/**`, `web/components/clots/**`, `web/lib/{daemon,stream}.ts`, `web/app/api/**`, `web/e2e/fake-daemon.ts`, `web/e2e/chat.spec.ts`, `web/e2e/waiting.spec.ts`
**Interfaces:** Consumes Tasks 2 to 5 routes and events. Produces `useStream(handlers)` client hook (reconnect with backoff 1 s → 30 s, `Last-Event-ID`, `resync` → `router.refresh()`).
**Build:**
- Shell: rail (Clots with icons, active = bold weight or swapped upload, drag to reorder → `POST /clots/order`, "…" menu after three, bell dot), page container, resizable side pane (widths saved to UI prefs; drag to edges = full/close).
- Chat: header (name, Info), messages (markdown, raw HTML off, links new tab), activity lines, notes (recap folded), ask cards (email card with editable body; merge/rule/choice cards), worker card, timestamps rule, infinite scroll up, composer (paste images, Enter/Shift+Enter, slash menu with fuzzy filter and bold prefix), optimistic send with Retry.
- Info pane: repository, connections with real logos (Composio `logo` URL via `next/image` with that host in `remotePatterns`; email → Phosphor `EnvelopeSimple`).
- Waiting for you: grouped by Clot in rail order, summary line, ask actions per kind, hover preview for email body, empty state copy from the spec.
- Content width and theme from UI prefs; banner when the daemon is unreachable.
- Playwright against a fake daemon (an in-process server speaking the API and stream).
**Tests (behaviours):**
- a sent message appears at once, the streamed reply grows and then settles.
- each ask kind answered from the chat card and from Waiting for you; a closed ask shows the outcome toast.
- the slash menu filters `/cl` to close, calendar undo, composio undo with the prefix bold.
- killing the fake daemon shows the banner; restarting it clears it and resyncs.
- axe finds no serious violations on chat and Waiting, in light and dark.
**Done when:** `npm run test:e2e` passes for these specs.
- [ ] Task 6 complete

### Task 7: Phone, install and push
**Files:** `web/app/(app)/**` (responsive variants), `web/components/clots/tab-bar.tsx`, `web/public/{manifest.webmanifest,sw.js,icons/*}`, `src/push.ts`, `src/ui-api/routes/push.ts`, tests
**Interfaces:** Produces `POST /push/subscribe` (subscription JSON), `DELETE /push/subscribe`, `GET /push/key`; `push.notify(event)` called from asks, timer and Clot state.
**Build:**
- Below 768 px: Clots list, chat (back button + edge-swipe back, no header actions, no attach), Waiting (Block/Allow or options only; row tap opens the ask); floating tab bar (Clots, Waiting) hidden in chats and while the keyboard is open (`visualViewport`); safe-area insets; 16 px inputs (no zoom).
- Turn on row (highlight-soft) until granted or dismissed; permission requested only from that button.
- Push sends per the spec's list; "no tab open" = no SSE client connected; 404/410 deletes the subscription.
- Settings, New Clot and integrations routes redirect to Clots on phone widths.
**Tests (behaviours):**
- at 390×844: tab bar visible on Clots and Waiting, hidden in a chat; Waiting rows show two buttons.
- a new ask with no stream client sends one push per subscription; with a client connected, a reply sends none.
- a 410 from the push service deletes that subscription.
- manifest valid (name, icons, `display: standalone`).
**Done when:** `npm test` and `npm run test:e2e` pass.
- [ ] Task 7 complete

### Task 8: Config store, hot reload, settings pages
**Files:** `src/config-store.ts`, `src/config.ts`, `src/config-edit.ts`, `src/env-file.ts`, `src/agent/tool-server.ts` (`set_config` text, no restart), `src/ui-api/routes/{settings,keys,clots}.ts`, `web/app/(app)/settings/**`, tests
**Interfaces:**
- Produces: `configStore.onChange(keys: string[], apply: (next: Config, prev: Config) => Promise<void>)`; `configStore.save(patch)` → `{ applied: string[]; needsRestart: string[] }` or field errors; `config.changed` event.
- Produces: `GET /keys` → `[{ name, last4 }]`, `PUT /keys/:name` (value), `DELETE /keys/:name`.
**Build:**
- Atomic write + backup; watch both files (300 ms debounce); invalid hand edit → keep last good, emit `config.changed` with the error.
- Register apply handlers for every key group in the spec; restart-only keys reported.
- Settings: General (fields and help text as on the canvas, time input custom component with keyboard rules from the design system), Manage Clots (state, Edit → `/new?edit=<clot>`, Delete with typed name; refused for home; volumes and history kept), Integrations (inboxes list, Composio list, Keys list).
- The "Picked up changes to clots.config.json" toast on `config.changed` from a file edit.
**Tests (behaviours):**
- a hand edit changing `maxWorkers` applies without restart; a hand edit with invalid JSON is ignored and reported.
- saving `intake.port` reports it under needsRestart and leaves the running port.
- `GET /keys` never returns a value; `PUT` then `GET` shows the new last 4.
- `.env` comments and order survive a key write.
- deleting home is refused; deleting another Clot stops its container and keeps its volumes.
**Done when:** `npm test` and the settings e2e spec pass.
- [ ] Task 8 complete

### Task 9: New Clot and onboarding
**Files:** `src/onboarding/{create,repo-access,icons,checklist}.ts`, `src/ui-api/routes/clots.ts`, `web/app/(app)/new/**`, `web/components/clots/icon-picker.tsx`, tests
**Interfaces:**
- Produces: `POST /clots/validate` (`{ name, repo }` → field errors or ok; accepts a pending invitation), `POST /clots/icons` (upload → `{ iconId }`), `POST /clots` (create; progress as `clot.build` events `{ clot, step: "cloning" | "building" | "starting" | "done" | "failed", log? }`), `POST /clots/:clot/retry`.
- Produces: checklist items `{ id: "webhook" | "tools" | "push-branch", done: boolean, detail }` stored per Clot; `GET /clots/:clot/webhook-secret` (`{ secret }`, read only when the user presses Copy).
- A Clot's name keeps its capitals (letters, digits, hyphens); `src/clot-name.ts` gives `slugOf` (lower case), which container, volume, rule-file and uniqueness checks use.
**Build:**
- Steps 1 to 3 with slide transitions (`motion`), heading animates to icon + "Creating <name>", Reset, Edit mode with Save.
- Icon picker: all Phosphor icons (regular), search, eight colours, upload or paste; active variant via `sharp`.
- Create writes the config entry through the config store (Task 8), clones, builds, starts; failure shows log + Retry.
- First Clot message = one line plus the checklist card (message kind `onboarding`, data `{ repo, webhookUrl }`, never the secret); the card lists the steps, ticks them live, and puts the webhook address and the secret behind Copy buttons. Webhook item turns done on GitHub's `ping` for that repo; branch item on the first push by the Clot's token.
**Tests (behaviours):**
- a taken name or invalid container name → field error; no access → the invite instructions; pending invitation → accepted.
- a name with capitals is accepted and kept as typed; `Truecast` is taken when `truecast` exists; the container is `clot-truecast`; a lowercase Clot keeps its container.
- the first message's text and data hold no secret; the secret route answers only with the UI secret.
- a two-colour PNG's active variant has its colours swapped; a photo's is inverted.
- a failed build reports `failed` with the log; Retry continues.
- a GitHub ping for the repo marks the webhook item done.
**Done when:** `npm test` and the new-clot e2e spec pass (fake Docker and fake GitHub).
- [ ] Task 9 complete

### Task 10: Connecting services
**Files:** `src/integrations/configurer.ts`, `src/ui-api/routes/integrations.ts`, `web/components/clots/integration-dialog/*`, `web/app/(app)/settings/integrations/**`, tests
**Interfaces:**
- Produces: `GET /integrations/toolkits?q=` (cached 24 h), `POST /integrations/configure` (`{ toolkit, clot | "shared", audience, selfIsUser, events, pollMinutes }` → `{ jobId }`), events `integration.status` `{ jobId, state: "working" | "oauth" | "key" | "active" | "failed", link?, instructions?, keyName?, error? }`, `PUT /integrations/:jobId/key` (value → `.env`), inbox CRUD `GET/POST/PUT/DELETE /inboxes`.
**Build:**
- Dialog steps: pick (two-column grid, skeletons, added state with remove), options, working (skeletons), connect (OAuth link button new tab, Done disabled 5 s; or key field with eye toggle and instructions, Done disabled while empty). No close button in working/connect; Back to options.
- Configurer session as in Key Decisions; `save_integration` writes through the config store.
- OAuth: watch the connection until active; abandoned after an hour → removed from Composio.
- Inbox form with provider detection by domain (gmail.com, googlemail.com → Gmail icon; others → envelope).
- Right-click menu on tool tiles (Edit settings, Reconnect, Remove from <name>).
**Tests (behaviours):**
- `save_integration` with an invalid entry is refused and nothing is written.
- the key value never appears in the configurer's messages (assert on the recorded session input).
- OAuth state reaches active when the fake Composio connection activates; Done enables after 5 s.
- an abandoned connection is removed after the hour (fake clock).
**Done when:** `npm test` and the integration e2e spec pass (fake Composio, fake configurer model responses).
- [ ] Task 10 complete

### Task 11: Deploy, docs and parent design
**Files:** `deploy/update.sh`, `deploy/clots-web.service`, `README.md`, `.superpowers/specs/2026-10-10-clots-design.md` (sections 2, 6, 7, 11, 16 in place, no change notes), `clots.config.example.json`
**Build:**
- `update.sh`: `npm ci`, `npm run web:build`, install/restart `clots-web.service`, ensure `tailscale serve --bg --https=8443 http://127.0.0.1:3000`.
- README: web UI setup (ui.owner, serve, installing on iPhone, notifications), Discord sections removed.
- Example config: `ui.owner`, `askTimeoutMinutes`, no `discord`, no `sendReview`.
**Tests (behaviours):** `bash -n deploy/update.sh`; the example config validates with the schema.
**Done when:** `npm test`, `npm run typecheck`, `npm run web:build` pass.
- [ ] Task 11 complete

## Manual Verification Checklist

**Shared setup:** Docker Desktop running (`docker info` succeeds). `npm ci`; `.env` with the existing keys; `clots.config.json` with `"ui": { "owner": "<your tailscale login>" }`. Start `npm run daemon` in the background and `npm run web:build && npm run web -- --prod` (or `next start -p 3000` in `web/`). `tailscale serve --bg --https=8443 http://127.0.0.1:3000`. Open `https://laptop-nj7mbno6.tailf707aa.ts.net:8443` in the built-in browser.

#### MV-1: Access is tailnet and owner only
- **Steps:** 1. Open the URL above. 2. `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3000/waiting`. 3. `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8788/api/v1/clots`.
- **Expected:** 1 shows Waiting for you. 2 prints `403`. 3 prints `401`.
- **How the executor runs it:** browser + curl.

#### MV-2: Chat streams a real reply
- **Steps:** 1. Click Home in the rail. 2. Type "What's 2 + 2? One line." and press Enter.
- **Expected:** your bubble appears at once on the right; the reply text grows while it streams and ends as one message with a timestamp; no Discord message is sent anywhere.
- **How the executor runs it:** browser.

#### MV-3: Slash command
- **Steps:** 1. In Home's composer type `/`. 2. Type `sp`, press Enter.
- **Expected:** the menu lists all commands with descriptions; after `sp` only `/spend` remains with "sp" bold; this week's spend appears as a note in the chat.
- **How the executor runs it:** browser.

#### MV-4: Email ask allowed after editing
- **Setup:** an email source on the test inbox `lukas@tady.ch`.
- **Steps:** 1. Ask Home: "Draft and ask to send a one-line test email from lukas@tady.ch to lukbicycles.com@gmail.com." 2. In the card, change the body to "Edited test." 3. Click Allow.
- **Expected:** the card shows a calling or calm timer; after Allow it collapses into "Sent an email · you allowed it"; the received email body is "Edited test."; Home's next turn mentions the edit.
- **How the executor runs it:** browser + checking the Gmail inbox in the built-in browser.

#### MV-5: Ask blocks at its deadline
- **Setup:** Settings → General → Ask timeout `00 h 02 m`, Save.
- **Steps:** 1. Ask Home to ask before sending another test email. 2. Wait without answering.
- **Expected:** Waiting for you shows it with the timer turning calling and then urgent ("0:59" … ), then it disappears; the chat shows "Blocked: no answer within 2 minutes."; no email arrives.
- **How the executor runs it:** browser.

#### MV-6: Choice takes the Clot's pick
- **Steps:** 1. Ask encryptify: "Give me a choice between two test runners with ask_choice, then do nothing else." 2. Do not answer for the timeout.
- **Expected:** Waiting for you shows both options with the pick marked; after the deadline the chat says which option it took; it is not "blocked".
- **How the executor runs it:** browser.

#### MV-7: Merge ask answered from Waiting for you
- **Steps:** 1. Ask encryptify to open a trivial pull request and ask to merge it. 2. On Waiting for you click the check (Merge) on that row.
- **Expected:** the row disappears, the pull request is merged on GitHub, the chat shows the outcome note.
- **How the executor runs it:** browser + GitHub in the built-in browser.

#### MV-8: Answering a closed ask
- **Steps:** 1. Open the same ask in two tabs. 2. Click Allow in one, then Block in the other.
- **Expected:** the second tab shows a toast saying it was already allowed; nothing else happens.
- **How the executor runs it:** browser (two tabs).

#### MV-9: Rollover keeps the chat
- **Steps:** 1. In Home, send `/close`. 2. Scroll up.
- **Expected:** a note "Context limit reached…" or the close note and a folded recap appear; earlier messages are still there above it.
- **How the executor runs it:** browser.

#### MV-10: Worker card
- **Steps:** 1. Ask encryptify to fix two trivial things in separate workers.
- **Expected:** one card lists both briefs with model and effort, "2 workers running" in teal; later each row links to its pull request.
- **How the executor runs it:** browser.

#### MV-11: Settings apply live, hand edits picked up
- **Steps:** 1. Settings → General → Workers at once 2 → Save. 2. Edit `clots.config.json` by hand: `rolloverPercent` 70. 3. Edit it again with a syntax error.
- **Expected:** 1 saves with no restart; 2 shows the "Picked up changes to clots.config.json" toast and the page shows 70%; 3 shows an error toast and the daemon keeps running with 70.
- **How the executor runs it:** browser + file edit.

#### MV-12: Keys are write-only
- **Steps:** 1. Settings → Integrations → Keys → Add key `TEST_UI_KEY` = `abcd1234`. 2. `curl -H "X-Clots-UI-Secret: <secret>" http://127.0.0.1:8788/api/v1/keys`.
- **Expected:** the row shows `•••• 1234`; the curl output has `last4: "1234"` and no `abcd1234`; `.env` has the line.
- **How the executor runs it:** browser + curl.

#### MV-13: New Clot end to end
- **Steps:** 1. Click + in the rail. 2. Pick the Sliders icon, name `graphite`, repository `hacker4ofakind/chess-gpt`. Next. 3. No tools; Next/Create graphite.
- **Expected:** progress shows cloning, building, starting; you land in graphite's chat with the onboarding checklist, the webhook address and a Copy button for the secret (the secret is not in the message); after adding the webhook on GitHub, the webhook item turns done.
- **How the executor runs it:** browser + GitHub in the built-in browser. Delete the Clot afterwards (Settings → Manage Clots → Delete, typing the name).

#### MV-14: Connect a Composio toolkit with OAuth
- **Steps:** 1. Settings → Integrations → Add a tool → search "Linear" → arrow. 2. Audience Team, shared off for Home, events on → Finish. 3. Click "Sign in to Linear" (opens a new tab), approve.
- **Expected:** skeletons while the configurer works; the sign-in step has no close button; Done is disabled for 5 s and then enables; after approval the status becomes active and Linear appears in the Composio list.
- **How the executor runs it:** browser (Linear and Composio are logged in).

#### MV-15: Connect a toolkit with an API key
- **Steps:** 1. Add a tool → a key-based toolkit (e.g. PostHog) → Finish. 2. Read the instructions; paste a key; Done.
- **Expected:** step-by-step instructions fit the dialog; Done disabled while empty; the key is in `.env` under `POSTHOG_<ACCOUNT>_KEY`; the configurer's recorded session never contains the key.
- **How the executor runs it:** browser + inspecting the session log.

#### MV-16: Phone layout
- **Steps:** 1. Resize the browser to 390×844. 2. Open Clots, then Home, then Waiting.
- **Expected:** tab bar on Clots and Waiting only; chat has back and no attach; Waiting rows show only two buttons; Settings is not reachable.
- **How the executor runs it:** browser with mobile preset.

#### MV-17: Dark theme
- **Steps:** Settings → General → Theme Dark; visit Waiting, a chat with an ask, New Clot.
- **Expected:** matches the canvas's Dark page; no light-only colours anywhere.
- **How the executor runs it:** browser screenshots.

#### MV-18: Daemon down and back
- **Steps:** 1. Stop the daemon (kill the process on 8787). 2. Watch the page. 3. Start it again.
- **Expected:** the "Can't reach the Clots daemon. Retrying…" banner appears and actions are disabled; after restart the banner goes and the open chat is up to date.
- **How the executor runs it:** browser + process control.

#### MV-19: Install and push on the iPhone
- **Steps:** 1. On the iPhone with Tailscale on, open the URL in Safari, Share → Add to Home Screen. 2. Open the app, Waiting for you → Turn on → Allow. 3. Close the app. 4. Have Home open an ask.
- **Expected:** a notification "Home" with the ask's summary arrives; tapping it opens the ask in Home's chat.
- **How the executor runs it:** `[user-only]`: needs the user's phone.

#### MV-20: Pi deploy
- **Steps:** 1. `npm run deploy`. 2. Open `https://clots.tailf707aa.ts.net:8443` on the tailnet.
- **Expected:** both services active (`systemctl status clots clots-web`); the UI loads with Home and Truecast; webhooks still arrive on 443.
- **How the executor runs it:** CLI + browser.

## Out of Scope

Claritee, inline widgets, Clapboards and the Clapboard header button (4b). Daily todo, voice calls, browser use, computer use, Secret Storage. Importing Discord history. Offline support.

## Implementation Notes

_Filled in by the executor: deviations and why, changed names/interfaces, surprises, notes for the next stage's planner._
