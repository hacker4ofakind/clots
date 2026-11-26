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
- `src/ui-api/server.ts` (create): the loopback HTTP server (`UiApi`, `api.route(method, path, handler, { maxBytes })`), secret check, routing; `src/ui-api/secrets.ts` (`ensureEnvKey`: a key made and saved to `.env` at first start; the VAPID keys are made in `src/daemon.ts` with `newVapidKeys`).
- `packages/ui-api-schemas/src/index.ts` (create): zod request/response schemas, imported by the daemon and `web/` as `@clots/ui-api-schemas`.
- `src/ui-api/routes/*.ts` (create): `clots.ts` (identity, Clots, messages, message images, asks, commands), `clots-admin.ts` (validate, create, retry, build state, edit, icons, webhook secret, onboarding checklist), `settings.ts` (general settings, keys, Clot order, delete), `prefs.ts` (UI preferences), `workers.ts`, `push.ts`, `integrations.ts` (toolkits, jobs, tools, inboxes).
- `src/ui-api/events.ts` (create): the `EventBus` with a 1,000-event replay ring and the SSE writer (`serveStream`).
- `src/conversation/store.ts` (create): message rows, images, paging, ask history, UI preferences.
- `src/conversation/conversation.ts` (create): the `Conversation` interface implementation (replaces `ChatAdapter`).
- `src/conversation/activity-lines.ts` (create): tool call → one line with an icon name.
- `src/chat/`, `src/waiting.ts`, `src/asks-migration.ts`, `src/events/reply.ts` (deleted).
- `src/clot.ts`, `src/pipeline.ts`, `src/workers.ts`, `src/global-memory.ts`, `src/daemon.ts` (modify): post through `Conversation`, no channels.
- `src/asks.ts`, `src/asks/*.ts` (modify): answers instead of reply matching, deadlines on every kind.
- `src/commands.ts` (modify): `/` prefix, `COMMAND_LIST` export.
- `src/agent/runner.ts` (modify): partial messages → text deltas (`TextStreams`, `onTextDelta`); tool calls → `onToolUse`.
- `src/store.ts` (modify): migration dropping `category_id`/`channel_id`, new tables.
- `src/config.ts`, `src/config-edit.ts` (modify); `src/config-store.ts` (create): load, validate, atomic write with backup, watch, apply handlers, keys; `src/live-config.ts` (create): the apply handler of each live key; `src/live-env.ts` (create): the live `.env` map; `src/email-sync.ts` (create): live email accounts; `src/email-providers.ts` (create): default IMAP/SMTP hosts by domain; `src/clot-name.ts` (create): name rule, `slugOf`, `labelOf`.
- `src/push.ts` (create): VAPID, subscriptions, sends. `src/net/safe-fetch.ts` (create): the SSRF-guarded fetch, shared with 4b.
- `src/onboarding/*.ts` (create): New Clot creation, repo access, icon processing (`icons.ts`: sniff by content, sanitise and rasterise SVG, `sharp` for the rest), `ico.ts` (an ICO decoder with no dependency), checklist.
- `src/skipped-notice.ts` (create): announces a skipped Composio entry once per distinct problem, kept in the store's state.
- `src/integrations/{configurer,jobs,apply}.ts` (create): the configurer session and its tools, the connection jobs, the `sources` apply handler.
- `deploy/update.sh` (modify), `deploy/clots-web.service` (create), `README.md` (modify).
- `tests/**` (create/modify) per task.

Web (`web/` workspace):
- `web/app/layout.tsx`, `web/app/globals.css` (the design tokens, mapped in `@theme inline`), `web/proxy.ts` (the Tailscale check and the CSP; Next 16's name for middleware).
- `web/app/(app)/…` routes: `/` (redirects to Waiting), `/waiting`, `/clots` (the phone's list), `/c/[clot]`, `/settings/{general,clots,integrations}`, `/new`; `/offline` outside the group.
- `web/app/api/stream/route.ts` (SSE proxy), `web/app/api/d/[...path]/route.ts` (every action, proxied to the daemon through `guard`).
- `web/lib/`: `daemon.ts` (server-side client with the secret), `api-client.ts` (browser calls to `/api/d`), `guard.ts`, `access.ts`, `identity.ts`, `stream.ts` (client hook with reconnect), `use-unsaved-guard.ts`, `images.ts`, `draft.ts`, `edge-swipe.ts`, `viewport.ts`, `integrations.ts`, `readable-error.ts` (`readableError`, `readableReasons`: the daemon's sentence if a person can read it, else a plain line), `setting-labels.ts` (settings named by their page labels in toasts).
- `web/components/ui/*` (shadcn), `web/components/clots/*` (`rail`, `chat-view`, `composer`, `slash-menu`, `ask-card`, `ask-actions`, `timer`, `worker-card`, `onboarding-card`, `time-input`, `side-pane`, `info-pane`, `markdown`, `logo`, `tab-bar`, `waiting-view`, `clots-list`, `new-clot*`, `icon-picker`, `integration-dialog/*`, `tool-tile`, `settings/*`, and the shared pieces `segmented`, `stepper`, `list-card`, `icon-tile`, `status-dot`, `confirm-dialog`, `connection-icon`, `field-row`). The Clapboard icon is 4b's.
- `web/components/clots/status-page.tsx` (create): the shared tile, heading, text, actions and Reference layout; `framed` or inside the shell.
- `web/components/clots/not-found-page.tsx` (create): the 404 content.
- `web/app/not-found.tsx`, `web/app/(app)/not-found.tsx` (create): unknown addresses (framed); `notFound()` inside the shell (unframed).
- `web/app/error.tsx`, `web/app/global-error.tsx` (create): the client error boundary (Try again with `retry`, console only) and the root-layout fallback with its own document.
- `web/lib/status-document.tsx`, `web/lib/static-html.ts` (create): the proxy's 403 and 503 pages as HTML text from `StatusPage` (no `react-dom/server` in the proxy), with a token-mirroring stylesheet; `web/proxy.ts` (modify): uses them, access logic untouched.
- `web/app/e2e/error/page.tsx` (create): test-only failing route, a 404 unless `CLOTS_E2E_HARNESS=1`.
- `web/components/clots/{icon-upload.ts,curated-icons.ts}` (create): the icon picker's upload handling and its curated opening grid.
- `web/public/manifest.webmanifest`, `web/public/sw.js`, icons from the logo mark.
- `web/e2e/*.spec.ts` (Playwright; `error-pages.spec.ts` covers the status pages, `web/tests/status-document.test.tsx` the proxy's HTML), `web/e2e/fake-daemon.mts`, `web/e2e/fake-integrations.mts`, `web/e2e/helpers.ts`.

## Key Decisions & Gotchas

- **`Conversation` keeps the adapter's verbs but is keyed by Clot, not channel.** Every `chat.post(channelId, …)` becomes `conv.post(clot, …)`; categories, channel creation, read-only, pins, `channelExists`, `mention`, `channelLink` disappear. A rollover creates a new session row and a `note` message; it no longer creates anything else. `sessionByChannel` is replaced by "active session of a Clot". Read every call site in `clot.ts` (about 40) and `asks.ts` before starting: the order of "save, then announce" in `rollover` must be kept (the comment at "Saved before anything is announced").
- **Store migration** (`user_version` 1): `sessions` and `user_asks` hold a UNIQUE on a channel column, which SQLite cannot drop, so the migration rebuilds those two tables, copying only the columns the new table has (a column an older version left behind, such as `steered`, is dropped); `clots.category_id`, `inbox.channel_id` and the asks' channel columns are removed. Inbox rows that need a "where to answer" use the Clot. It runs inside the schema-version step so a restart mid-migration is safe.
- **Asks**: replace `onReply(ask, text, io)` with `onAnswer(ask, answer, io)` for buttons and an optional `onFeedback(ask, text, io)` for chat text (today's "any other reply" branch of each kind, moved unchanged; the rule, memory and restart kinds have none, so a typed message reaches the Clot as an ordinary message). Each kind also gives an `AskView` (heading, rows, body, labels, options, pick) that the UI draws. Delete the exact-word matchers. `AskIo.repeat` and `dropChannel` go; `close` posts a `note` and an `ask.closed` event. Kinds `config` and `restart` stay (a config key that needs a restart still asks). `onDeadline` is on every kind: choice keeps its timeout turn; others close as blocked with the note "Blocked: no answer within N minutes." `stale()` withdrawals are unchanged.
- **Email edit**: the answer `{ action: "edit", body }` replaces the payload's body, then runs the same path as allow; the note to the main session quotes the user's changed lines (a simple line diff, removed and added).
- **Waiting summary** comes from open asks; `clots-waiting` pin logic in `waiting.ts` is removed, but its list-building (summary, deadline) is reused by the API.
- **Streaming**: `includePartialMessages: true` on main-session turns only (when the turn has `onTextDelta`); `TextStreams` (runner.ts) turns `stream_event` text deltas into `message.delta` under a key `<message id>:<n>`, and the final text is posted exactly as `onText` does today (the stored message is the final text, under the same id). Workers stay non-streaming.
- **Activity lines**: the runner's `onToolUse` callback gives each tool call to `activityLine()` (activity-lines.ts), producing `{ icon, text }` (`Read issue #31`, `Searched the code for "delete"`, `Asking to send an email`). Icon names are Phosphor component names, rendered by the web app from a fixed map.
- **SSE through Next.js**: the route handler must return a streaming `Response` (`ReadableStream`), set `export const dynamic = "force-dynamic"`, and pipe the daemon's body through with the secret added; disable compression for that route. Heartbeat every 20 s keeps `tailscale serve` from closing it.
- **shadcn on Tailwind v4**: run `npx shadcn@latest init` in `web/` (choose Neutral, CSS variables), then replace its generated variables with the design system tokens (`tokens.json` from the design system; names are already shadcn's). Map extras (`highlight`, `calling`, `primary-soft`, `primary-ink`, `foreground-soft`, `muted-strong`, `tile`, `brand`, `scrim`) in `@theme inline`. shadcn `accent` = the value of `muted`. A pattern used twice is a component (`Segmented` on ToggleGroup, `Stepper`, `ListCard`/`ListRow`, `IconTile`, `StatusDot`, `ConfirmDialog`, `ConnectionIcon`, `FieldRow`/`PageHeader`).
- **Status pages**: the 404, error, 403 and setup pages are one presentational `StatusPage` (no providers, no client code), so the same element tree serves the app and the proxy. The proxy answers before the app's stylesheet can load and Next refuses `react-dom/server` there, so `static-html.ts` writes the tree to HTML itself and `status-document.tsx` carries a small stylesheet for the component's `data-slot`s, built from a token table (a unit test keeps every colour in it equal to `globals.css`, light and dark). `error.tsx` recovers with `retry()` (it re-fetches; `reset` would not), logs with `console.error` and never shows `error.message`; `global-error.tsx` has its own `<html>` and reads the theme from next-themes' stored key, else the device's. The 403 and setup pages follow the device's colour scheme. Layouts: canvas artboards `NotFound` and `Error` (light, dark, phone); the 403 and setup pages are the same component and are not drawn there.
- **Fonts**: `next/font/google` for Rethink Sans and Red Hat Mono, as `--font-sans` / `--font-mono`.
- **Phosphor in RSC**: import from `@phosphor-icons/react/dist/ssr` in server components, `@phosphor-icons/react` in client components.
- **Clot icons**: a Clot's icon is either `{ phosphor: "Sliders", color }` or an uploaded file; the active variant of an upload is precomputed with `sharp` (count opaque-pixel colour clusters: exactly 2 → swap, else negate) and stored beside it.
- **Side pane**: `useSidePane().open({ clot, label, render, width? })`. It opens at `PANE_WIDTH` (300 px) unless the caller gives a width (4b's Clapboard), every time, with no remembered width. Dragging right narrows it continuously (no dead zone); letting go narrower than `CLOSE_BELOW` (12 % of the space beside the rail, never under `CLOSE_FLOOR`, 96 px) closes it; dragging left widens it up to the full width.
- **Hot reload apply handlers**: register per top-level key (`registerLiveConfig`, `configStore.onChange`); a handler may return `{ restart: true }` to be reported under `needsRestart`. Live: time zone, hold, rollover, workers, proposals, ask timeout, gates, sweep, spend, `sources.email` (`EmailSync`), generic Composio toolkits (`Composio.setAccounts`), MCP servers, Clots added or removed, a Clot's test command, recipes' secrets. Saved and reported, not applied (read once at start): `intake`, `image`, `ui`, `rulebookDir`, `home`, `publicUrl`, the built-in toolkits (linear, notion, stripe, googlecalendar), the `.env` tokens. A key with no handler is reported under `needsRestart`, never ignored.
- **`.env` writing**: reuse `src/env-file.ts` for reading; writing keeps comments and order, replaces a key's line in place, appends new keys; atomic write like the config.
- **Configurer**: a throwaway Agent SDK session in the daemon (not in a container), `model: "claude-sonnet-5-5"`, effort medium, with the existing `plugin/skills/composio-integration` skill content in its system prompt and only these tools: `toolkit_info`, `trigger_types`, `web_fetch`, `save_integration` via `createSdkMcpServer`, plus the SDK's built-in `WebSearch` (the repo has no search backend). No Bash, no file tools (`canUseTool` allow-list). `save_integration` validates with the `sources.composio` entry schema; the API key value is never in its context. The daemon, not the configurer, decides how a toolkit connects: `authFor(info)` looks only at what Composio says about the toolkit (managed OAuth that asks for nothing first: sign-in; otherwise a key scheme: key; no auth: none; anything else: refused), with no table of special cases, so Linear, Notion and Stripe are decided like any other; the configurer is told the result and cannot change it, and editing a tool keeps its way (`authOfEntry`: an entry that names a key stays a key). `apiKey` is optional in the built-in toolkits' entries (a key entry needs it). A connection from the dialog holds one secret (the generated key name); a toolkit needing its own OAuth app is refused at Finish with a pointer to the config file. The configurer cannot write recipes, so a generic toolkit's events are the generic `trigger` kind.
- **Connection jobs** (`IntegrationJobs`, in memory): `working → oauth | key → active | failed`; the config entry is written only when the connection is ready (OAuth: the Composio connection is active; key: right after the key is in `.env`); an entry for a Clot that does not exist yet is held in the job and written by `POST /clots` with `toolJobs`; a `tick()` every 3 s (from `daemon.ts`) watches sign-ins and the 1 h abandon.
- **OAuth link**: made directly through `ComposioApi` (`ensureAuthConfig` + `linkManaged`, Composio user id `<toolkit>:<account>`), never from the configurer.
- **Discord leftovers**: `config.ts` must accept a file that still has `discord` (ignore with one log line) so the Pi does not fail to start after deploy; `ui.owner` missing → the web app shows a setup page naming the key.
- **Tests that used `src/chat/fake.ts`** move to a fake `Conversation` with the same recording style.

### From the stress test (apply all)
- **Access:** `tailscale serve` sets `Tailscale-User-Login` only for tailnet users; `web/proxy.ts` checks `Tailscale-User-Login` == `ui.owner` and `Host` == the configured serve host (from `GET /identity`: `ui.owner` and the host of `publicUrl`); `web/lib/daemon.ts` and `web/lib/guard.ts` re-check the owner on every server-side call (defence in depth against proxy bypasses); missing `ui.owner` fails closed to the setup page. The test-only owner env vars (`CLOTS_UI_DEV_OWNER`, `CLOTS_UI_DEV_HOST`) are ignored when `NODE_ENV=production`.
- **CSRF:** every mutating route handler goes through one wrapper requiring `Origin` == own origin, `Content-Type: application/json` (multipart only for uploads), and the owner check. One catch-all proxy route (`web/app/api/d/[...path]/route.ts`) forwards to the daemon through that wrapper, plus the separate stream route; no per-action route files.
- **Pin and audit:** pin Next.js and React to patched versions (CVE-2025-29927, CVE-2025-55182); `npm audit --omit=dev` clean in Task 1 and Task 11.
- **CSP:** site-wide CSP (`default-src 'self'`, `img-src 'self' data:` plus the proxy, no inline script beyond Next's nonce); `X-Content-Type-Options: nosniff` on every daemon-served file.
- **Clot icons:** the daemon reads an upload's own bytes (`sniff`; the name and declared type are never used) from a base64 or percent-encoded data URL (`bytesOfDataUrl`). An SVG is sanitised (no script, `foreignObject`, iframe, object, embed, animation, event handlers, `<!ENTITY`, `@import`, or `url()` that is not `#id`; only `#id` and small embedded PNG/JPEG/WebP `href`s) and rasterized by `sharp` at a density that gives about 512 px on the longest side; an ICO is decoded by `src/onboarding/ico.ts` (the biggest frame; PNG frames as they are, 1/4/8/24/32 bpp bitmaps decoded, RLE and bitfield-with-masks refused; the next frame is tried when one is unreadable); JPEG EXIF rotation is applied. Only a PNG is stored or served. Limit 2 MB, checked in the browser and in the daemon. A file input is cleared after each pick so the same file can be chosen again. The picker is a fixed 480 x 560 dialog with the footer pinned and the results scrolling, and opens on a curated 3 x 8 grid.
- **Markdown:** images in markdown (`![]()`) are not loaded directly: they render as a link, or through the 4b proxy once it exists. Widgets render only in `clot` messages (4b), never in notes, asks or user text.
- **Keys:** names must match `^[A-Z][A-Z0-9_]{0,63}$`; values may not contain `\r` or `\n`; `CLOTS_UI_SECRET`, `VAPID_*` and `CLAUDE_CODE_OAUTH_TOKEN` are not writable from the UI. Removing a key still named by the config is refused, naming the users of it.
- **Runtime env:** the daemon was started with `node --env-file`, so keys written at runtime are not in `process.env`. Every secret lookup goes through the config store's live `.env` map, never `process.env`. The API-key connect flow writes the key **before** the entry (or saves the entry only once the key exists), because `loadConfig` requires every named key.
- **Clot-made config changes:** hot reload removes today's de facto gate (changes took effect only after `daemon_restart`). So `set_config` from a Clot always goes through the existing `config` ask (no SAFE_KEYS shortcut); add `ui` to `BLOCKED_KEYS`. The UI's own saves apply directly.
- **Configurer:** the daemon overwrites audience, scope and owning Clot in the saved entry with the user's Options choices; its `web_fetch` uses the same SSRF guard as the 4b image proxy (shared module `src/net/safe-fetch.ts`, built here).
- **Push:** subscription endpoints must be https on known push hosts (`*.push.apple.com`, `fcm.googleapis.com`, `updates.push.services.mozilla.com`, `*.notify.windows.com`); `notificationclick` opens only same-origin paths. "No tab open" means no client that was **visible and active in the last 2 minutes** (the client reports `visibilitychange` over a tiny POST), so a desktop tab left open at home does not suppress the phone's pushes; the SSE proxy aborts its upstream when the browser disconnects.
- **Web service env:** `clots-web.service` gets its own env file with only `CLOTS_UI_SECRET` and the daemon URL, never the full `.env`.
- **Input hardening:** per-route body limits (messages 24 MB: up to 6 images of 5 MB as data URLs, which are a third larger as base64; icon uploads 4 MB; others 256 KB); Clot names are letters, digits and hyphens, starting with a letter, up to 31 characters, capitals allowed (the slug, the name in lower case, names the container, volumes and rule file); repo as `owner/name` validated; `docker`/`git` via argv arrays only; the token scrubbed from clone logs.
- **Message idempotency:** the client generates the message id (UUID) and reuses it on Retry; the API keeps `INSERT OR IGNORE` semantics (today Discord's id did this). Same for ask answers (idempotency key).
- **Event ids:** `<bootId>-<seq>`; a `Last-Event-ID` with another boot id gets `resync`. The stream route forwards `Last-Event-ID`; the page subscribes before its server data is considered fresh (or refetches after `open`).
- **Phone resume:** on `visibilitychange` to visible and on stream reconnect, refetch the open screen and asks. Timers compute from the server deadline; a card past zero reads "Closing…" until `ask.closed` arrives.
- **Asks UI:** buttons disable with a spinner until the daemon replies; failure keeps the card with Retry; the closed outcome shows on the card itself, exactly once (no separate note message), and an answer to an already closed ask also gives a toast. Retry sends the answer the user chose, with the same key. An email edit that hits 409 keeps the edited text in the card with the outcome. `/commands`, widget submits and image-only messages are **not** feedback to an open ask. Answering a busy ask returns `{ outcome: "in progress" }`.
- **Option numbering:** choices are stored with pick 1|2; the API uses 0|1. Convert in one place (`src/asks/choice.ts`) and test it.
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
**Files:** `package.json`, `web/**` (Next app, shadcn init, `globals.css`, `layout.tsx`, `proxy.ts`), `web/lib/daemon.ts` (empty typed shell)
**Interfaces:** Produces: `npm run web` (dev on :3000), `npm run web:build`.
**Build:**
- npm workspaces; Next.js App Router with TypeScript and Tailwind v4; shadcn init and the components listed under "From the stress test".
- Tokens from the design system in `globals.css` (light `:root`, `.dark`), `next-themes` with `attribute="class"`.
- Proxy (`web/proxy.ts`, Next 16's middleware): Tailscale identity check against `ui.owner` (read from `GET /identity`, cached 60 s; until Task 2 exists, from `CLOTS_UI_DEV_OWNER` in tests).
**Tests (behaviours):**
- request with matching `Tailscale-User-Login` → page renders; mismatched or missing → 403 page; a `Host` other than the configured serve host → 403.
- `npm run web:build` succeeds with no type errors.
**Done when:** `npm run web:build` and `npm test -w web` pass.
- [x] Task 1 complete

### Task 2: UI API server and event stream
**Files:** `src/ui-api/server.ts`, `src/ui-api/events.ts`, `packages/ui-api-schemas/src/index.ts`, `src/daemon.ts` (start it), `tests/ui-api/*.test.ts`
**Interfaces:**
- Produces: `EventBus.emit(type: UiEventType, data: unknown): UiEvent` (ids `<bootId>-<seq>`); `UiEventType` = `"message.created" | "message.delta" | "message.done" | "activity" | "clot.state" | "ask.opened" | "ask.updated" | "ask.closed" | "workers.updated" | "config.changed" | "clot.build" | "integration.status" | "resync"`.
- Produces: `UiApi.route(method, path, handler(req: ApiRequest) => unknown, { maxBytes }?)` (`req.params`, `req.query`, `req.body` already parsed; `ApiResult(status, body)`, `RawResult`, `ApiError(status, message)`); handlers validate with `parseBody(schema, req.body)` and the schemas in `@clots/ui-api-schemas`.
**Build:**
- Loopback server on 8788 with secret check (constant-time compare); 401 without it.
- SSE at `/api/v1/stream`: replay from `Last-Event-ID` if in the ring, else a `resync` event; heartbeat 20 s.
- Generate `CLOTS_UI_SECRET` into `.env` on first start.
**Tests (behaviours):**
- no secret → 401; wrong secret → 401; right secret → route runs.
- reconnect with a recent id → missed events in order; with an id older than the ring → `resync`.
- port 8787 does not serve `/api/v1`.
**Done when:** `npm test` passes.
- [x] Task 2 complete

### Task 3: Conversation store replaces Discord
_Execute in two passes with a green test run between them: (a) store, migration, `Conversation`, routes and `asks`/`waiting` call sites; (b) `clot.ts` (about 40 call sites), runner streaming, activity lines, images, deleting `src/chat/`._
**Files:** `src/conversation/{store,conversation,activity-lines}.ts`, `src/store.ts` (migration), `src/clot.ts`, `src/pipeline.ts`, `src/workers.ts`, `src/global-memory.ts`, `src/daemon.ts`, `src/agent/runner.ts`, delete `src/chat/**`, `src/waiting.ts`, `src/asks-migration.ts`, remove `discord.js`; tests moved to a fake `Conversation`
**Interfaces:**
- Produces: `interface Conversation { post(clot, text, o?: { kind?: "clot" | "note" | "onboarding"; data?; recap?: boolean; id?: string }): Promise<string>; addUser(clot, { id, text, images?, at }): { message, created }; postActivity(clot, a: TurnActivity): Promise<void>; activityLine(clot, l: { icon: string; text: string }): void; setState(clot, s: "idle" | "working" | "paused" | "failed", reason?: string): void; stateOf(clot); postAsk(clot, askId): Promise<string>; postWorkers(clot, turnId): Promise<string>; delta(clot, messageId, text): void }`.
- Produces: message row `MessageView { id, clot, sessionId, kind: "user" | "clot" | "activity" | "note" | "ask" | "workers" | "onboarding", text, ref: string | null, data: object | null, createdAt, images: number }`; `ConversationStore.list(clot, before?: string, limit = 50)`.
- Produces routes: `GET /identity`, `GET /clots`, `GET /clots/:clot`, `GET /clots/:clot/messages?before=` (an `ask` message carries its card, a `workers` message its workers), `POST /clots/:clot/messages` (`{ id, text, images[] }`, images as data URLs ≤ 5 MB each, at most 6; a repeated `id` answers `duplicate: true`), `GET /clots/:clot/messages/:id/images/:n`, `POST /clots/:clot/read`, `GET /commands`.
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
- [x] Task 3 complete

### Task 4: Asks answered in the UI, deadlines on every ask
**Files:** `src/asks.ts`, `src/asks/*.ts`, `src/config.ts` (rename, removals), `src/ui-api/routes/clots.ts` (the asks routes), tests
**Interfaces:**
- Produces: `type AskAnswer = { action: "allow" } | { action: "block" } | { action: "edit"; body: string } | { action: "pick"; option: 0 | 1 }`.
- Produces: `AskKind.onAnswer(ask, answer: AskAnswer, io)`, `AskKind.onFeedback?(ask, text, io)` (optional), `AskKind.onDeadline(ask, io)` (required on every kind); `Asks.answer(id, answer, key?)`, `Asks.onUserMessage(clot, text)`, `Asks.list()`, `Asks.snapshot(ask)`.
- Produces routes: `GET /asks` (open asks as `AskSnapshot { id, clot, kind, summary, view, deadline, timer: "calm" | "calling" | "urgent", state: "open" | "busy", openedAt, outsider, messageId }`; `view` carries heading, rows, body, labels, `options` and `pick`), `POST /asks/:id/answer` (`{ answer: AskAnswer, key? }`) → `{ outcome }` (already closed → the stored outcome, HTTP 409; busy → `{ outcome: "in progress" }`). The asks restructure (answers, feedback, deadlines) landed with Task 3, since the conversation had to replace the reply path at once.
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
- a config with `choiceTimeoutMinutes: 20` loads as `askTimeoutMinutes: 20`, and a file that still has it applies live (no restart message).
- every closed ask leaves its outcome in the session's pending notes (the restart ask too), and the `/close` recap turn gets them and clears them once the recap is written.
- a skipped Composio entry is announced once; a restart does not repeat it; a fixed entry is forgotten.
**Done when:** `npm test` passes.
- [x] Task 4 complete

### Task 5: Commands, workers and settings endpoints
**Files:** `src/commands.ts`, `src/workers.ts`, `src/ui-api/routes/{workers,settings}.ts`, `src/conversation/store.ts` (UI preferences), tests
**Interfaces:**
- Produces: `GET /commands` → `[{ name: "effort", options: "low or medium", required: true, description: "Sets the effort for your next message" }, …]` (`COMMAND_LIST` in `src/commands.ts`), in this order, with the canvas `Slash` artboard's hints and descriptions: effort, close (optionally without summary), rules (optionally undo), memory (optionally undo), spend, calendar undo, composio undo, composio reconnect (tool:account). `required` is true for effort and composio reconnect only; the composer runs any other command on a single Enter. `/close without summary` parses like `/close nosummary`.
- Produces: `GET /turns/:id/workers` → `[{ id, brief, model, effort, status: "queued" | "running" | "pr-open" | "done" | "failed", pr?: string }]`; `workers.updated` events.
- Produces: `GET/PUT /settings/general`, `GET/PUT /settings/ui` (`{ theme: "system" | "light" | "dark", contentWidth: "wide" | "medium" | "narrow", notificationsDismissed: boolean }`).
**Build:**
- `/` parsing with the same semantics as `&`; `&` no longer recognised.
- A `workers` message posted once after the turn that dispatched them.
**Tests (behaviours):**
- `/close nosummary` behaves like `&close nosummary` did; `&close` is sent to the model as text.
- worker statuses move queued → running → pr-open and emit events.
- UI preferences persist across a daemon restart.
**Done when:** `npm test` passes.
- [x] Task 5 complete

### Task 6: Desktop chat, Waiting for you, shell
**Files:** `web/app/(app)/**`, `web/components/clots/**`, `web/lib/{daemon,stream,guard}.ts`, `web/app/api/**`, `web/e2e/fake-daemon.mts`, `web/e2e/chat.spec.ts`, `web/e2e/waiting.spec.ts`
**Interfaces:** Consumes Tasks 2 to 5 routes and events. Produces `useStream({ onEvent, onOpen })` client hook returning `"connecting" | "up" | "down"` (reconnect with backoff 1 s → 30 s, `Last-Event-ID`); `AppStateProvider` (`useAppState()`: Clots, asks, prefs, `subscribe`, `onResync`, `answer`) opens it once, and a `resync` event or a reopened stream makes each screen refetch.
**Build:**
- Shell: rail (no logo; Home, every Clot with its icon, New Clot, then Waiting with the bell dot and Settings at the bottom; the Clots scroll when they do not fit; active = bold weight or swapped upload; drag to reorder → `POST /clots/order`), page container, side pane (`useSidePane().open({ clot, label, render, width? })`; its own grip, no X or full-screen button; a fixed default width on every opening, no saved width; drag right narrows it continuously and past a threshold closes it, drag left reaches full width; see Key Decisions).
- Chat: header (name, an icon-only Info button), messages (markdown, raw HTML off, links new tab), activity lines, notes (recap folded), ask cards (email card with editable body; merge/rule/choice cards), worker card, timestamps under the Clot's messages only, infinite scroll up, composer (a `+` attach button, paste images, Enter/Shift+Enter, slash menu as wide as the composer with fuzzy filter and bold prefix), optimistic send with Retry.
- Info pane: repository (Phosphor `GithubLogo`), connections with real logos (`ConnectionIcon`: Composio's logo for the toolkit via `next/image` with `logos.composio.dev` in `remotePatterns`; a Gmail address uses Composio's `gmail` logo; another inbox → Phosphor `EnvelopeSimple`).
- Waiting for you: grouped by Clot in rail order, summary line, ask actions per kind, hover preview for email body, empty state copy from the spec.
- Content width and theme from UI prefs (in the chat at "wide" the horizontal padding equals the vertical); banner "Can't reach the Clots daemon. Retrying…" when the daemon is unreachable, with the actions and composer disabled and the page resynced on return.
- Playwright against a fake daemon (`web/e2e/fake-daemon.mts`: a separate process speaking the API and stream, with a control server on its port + 1).
**Tests (behaviours):**
- a sent message appears at once, the streamed reply grows and then settles.
- each ask kind answered from the chat card and from Waiting for you; a closed ask shows the outcome toast.
- the slash menu lists every command on `/`; `/cl` leaves close and calendar undo with the matched letters bold; `/sp` leaves spend.
- killing the fake daemon shows the banner; restarting it clears it and resyncs.
- axe finds no serious violations on chat and Waiting, in light and dark.
**Done when:** `npm run test:e2e` passes for these specs.
- [x] Task 6 complete

### Task 7: Phone, install and push
**Files:** `web/app/(app)/**` (responsive variants), `web/components/clots/tab-bar.tsx`, `web/public/{manifest.webmanifest,sw.js,icons/*}`, `src/push.ts`, `src/ui-api/routes/push.ts`, tests
**Interfaces:** Produces `POST /push/subscribe` (subscription JSON), `DELETE /push/subscribe`, `GET /push/key`, `POST /push/visibility` (a device reports itself visible or not), `POST /push/test`, `GET /push/status`; `Push.notify(n)` called from asks, timer and Clot state (`src/push.ts`: `Push`, `PushStore`, `allowedEndpoint`, `webPushSender`).
**Build:**
- Below 768 px: Clots list, chat (back button + edge-swipe back, no header actions, no attach), Waiting (Block/Allow or options only; row tap opens the ask); floating tab bar (Clots, Waiting) hidden in chats and while the keyboard is open (`visualViewport`); safe-area insets; 16 px inputs (no zoom).
- On Waiting for you only: a Turn on row (highlight-soft, one button) until granted or dismissed; permission requested only from that button, and "on" means a real push subscription exists.
- Push sends per the spec's list; "no tab open" = no device visible and in use in the last 2 minutes (`POST /push/visibility`); 404/410 deletes the subscription.
- Settings, New Clot and integrations routes redirect to Clots on phone widths.
**Tests (behaviours):**
- at 390×844: tab bar visible on Clots and Waiting, hidden in a chat; Waiting rows show two buttons.
- a new ask sends one push per subscription; a reply sends none while a device has been visible in the last 2 minutes.
- a 410 from the push service deletes that subscription.
- manifest valid (name, icons, `display: standalone`).
**Done when:** `npm test` and `npm run test:e2e` pass.
- [x] Task 7 complete

### Task 8: Config store, hot reload, settings pages
**Files:** `src/config-store.ts`, `src/live-config.ts`, `src/live-env.ts`, `src/config.ts`, `src/config-edit.ts`, `src/env-file.ts`, `src/email-sync.ts`, `src/agent/tool-server.ts` (`set_config` text, no restart), `src/ui-api/routes/{settings,clots-admin}.ts`, `web/app/(app)/settings/**`, `web/lib/use-unsaved-guard.ts`, tests
**Interfaces:**
- Produces: `configStore.onChange(keys: string[], apply: (next: Config, prev: Config) => void | { restart: boolean } | Promise<…>)`; `configStore.save(patch)` → `{ ok: true, applied, needsRestart }` or `{ ok: false, errors }`; `configStore.reapply()` (re-reads `.env`; `PUT`/`DELETE /keys` call it); `config.changed` event `{ keys, needsRestart, fromFile?, error? }`.
- Produces: `GET /keys` → `[{ name, last4, protected }]`, `PUT /keys/:name` (value), `DELETE /keys/:name`; `POST /clots/order`, `DELETE /clots/:clot`.
**Build:**
- Atomic write + backup; watch both files (300 ms debounce); invalid hand edit → keep last good, emit `config.changed` with the error.
- Register apply handlers for every key group in the spec; restart-only keys reported.
- Settings: General (fields and help text as on the canvas, time input custom component with keyboard rules from the design system), Manage Clots (state, Edit → `/new?edit=<clot>`, Delete with typed name; refused for home; volumes and history kept), Integrations (inboxes list, Composio list, Keys list). Leaving a page with unsaved edits asks first (`useUnsavedGuard`: in-app links and Back, plus the browser's own warning on close).
- The "Picked up changes to clots.config.json" toast on `config.changed` from a file edit.
**Tests (behaviours):**
- a hand edit changing `maxWorkers` applies without restart; a hand edit with invalid JSON is ignored and reported.
- saving `intake.port` reports it under needsRestart and leaves the running port.
- `GET /keys` never returns a value; `PUT` then `GET` shows the new last 4.
- `.env` comments and order survive a key write.
- deleting home is refused; deleting another Clot stops its container and keeps its volumes.
**Done when:** `npm test` and the settings e2e spec pass.
- [x] Task 8 complete

### Task 9: New Clot and onboarding
**Files:** `src/onboarding/{create,repo-access,icons,checklist}.ts`, `src/clot-name.ts`, `src/ui-api/routes/clots-admin.ts`, `web/app/(app)/new/**`, `web/components/clots/{new-clot,new-clot-tools,build-progress,onboarding-card,icon-picker}.tsx`, tests
**Interfaces:**
- Produces: `POST /clots/validate` (`{ name, repo }` → field errors or ok; accepts a pending invitation), `POST /clots/icons` (upload → `{ iconId }`), `POST /clots` (`{ name, repo, icon, toolJobs? }` → 202; progress as `clot.build` events `{ clot, step: "cloning" | "building" | "starting" | "done" | "failed", log? }`; `toolJobs` are the connection jobs held for this Clot, Task 10), `GET /clots/:clot/build` (`{ step, log? }`, 404 when nothing is being built; a reload mid-build reads it), `POST /clots/:clot/retry`, `PUT /clots/:clot` (Edit: `{ icon?, repo? }`; a changed repository is checked like a new Clot's, refused with 409 while a turn runs, then moved in the background → 202 `{ ok, moving: true }` with `clot.build` events, the entry changing only after it worked; the icon alone saves at once).
- Produces: checklist items `{ id: "webhook" | "tools" | "push-branch", done: boolean, detail }` from `GET /clots/:clot/onboarding` (`{ items }`; the marks are kept in the store, so a restart does not untick them); `GET /clots/:clot/webhook-secret` (`{ secret }`, read only when the user presses Copy).
- A Clot's name keeps its capitals (letters, digits, hyphens); `src/clot-name.ts` gives `slugOf` (lower case), which container, volume, rule-file and uniqueness checks use.
**Build:**
- Steps 1 to 3 with slide transitions (`motion`), heading animates to icon + "Creating <name>", Reset, Edit mode with Save. The step, name, repository, icon and held tools live in the address (`history.replaceState`), so a reload keeps them. Step 2 (Tools) lists shared accounts, the Clot's own tools and an Add tile that opens the integration dialog for a Clot that does not exist yet; the tools it makes are held (Task 10) and sent as `toolJobs`.
- Icon picker: all Phosphor icons (regular), search, eight colours, upload or paste; active variant via `sharp`.
- Create writes the config entry through the config store (Task 8), clones, builds, starts; failure shows log + Retry.
- First Clot message = one line plus the checklist card (message kind `onboarding`, data `{ repo, webhookUrl }`, never the secret); the card lists the steps, ticks them live, and puts the webhook address and the secret behind Copy buttons. Webhook item turns done on GitHub's `ping` for that repo; branch item on a GitHub `push` event whose sender is the Clots' login, or a worker's pull request; tools item when every Composio tool of the Clot is active (done when there is none). A failed build removes the config entry (and the Clot's tools with it), so the name is free again; Retry re-adds them from the failed build's record.
**Tests (behaviours):**
- a taken name or invalid container name → field error; no access → the invite instructions; pending invitation → accepted.
- a name with capitals is accepted and kept as typed; `Truecast` is taken when `truecast` exists; the container is `clot-truecast`; a lowercase Clot keeps its container.
- the first message's text and data hold no secret; the secret route answers only with the UI secret.
- a two-colour PNG's active variant has its colours swapped; a photo's is inverted.
- a failed build reports `failed` with the log; Retry continues.
- a GitHub ping for the repo marks the webhook item done.
**Done when:** `npm test` and the new-clot e2e spec pass (fake Docker and fake GitHub).
- [x] Task 9 complete

### Task 10: Connecting services
**Files:** `src/integrations/{configurer,jobs,apply}.ts`, `src/composio/{component,api}.ts`, `src/ui-api/routes/integrations.ts`, `web/components/clots/integration-dialog/*`, `web/components/clots/{tool-tile,tool-logo}.tsx`, `web/components/clots/settings/{integrations,inbox-dialog,connection-row}.tsx`, tests
**Interfaces:**
- Produces: `GET /integrations` (`{ inboxes, tools }`: each tool with `status` and `restartNeeded`), `GET /integrations/toolkits?q=` (`{ toolkits: [{ slug, name, logo?, description?, auth, webhooks? }] }`, cached 24 h, at most 60), `POST /integrations/configure` (`{ toolkit, clot?, audience, selfIsUser, events, pollMinutes?, jobId?, replaces? }`, no `clot` = shared with every Clot; 201 `{ jobId }`), `GET /integrations/jobs/:jobId`, events `integration.status` `{ jobId, toolkit, state: "working" | "oauth" | "key" | "active" | "failed", link?, oauthReadyAt?, instructions?, keyName?, error?, needsRestart? }`, `PUT /integrations/jobs/:jobId/key` (`{ value }` → `.env`), `POST /integrations/jobs/:jobId/abandon`, `POST /integrations/tools/:id/reconnect` (`:id` is `toolkit:account`), `DELETE /integrations/tools/:id`, inbox routes `POST /inboxes`, `PUT /inboxes/:account`, `DELETE /inboxes/:account` (the list is in `GET /integrations`). Without `COMPOSIO_API_KEY` at daemon start, routes that need Composio answer 503.
**Build:**
- Dialog steps: pick (two-column grid, skeletons, added state with remove), options (audience as a Select with icons; own account; every Clot or this one; events; polling time shown when events are on and the toolkit has no webhook), working (skeletons), connect (OAuth link button new tab, Done disabled 5 s; or key field with eye toggle and instructions, Done disabled while empty). No close button in working/connect; Back to options. Props: `clot?`, `edit?`, `resume?`, `retool?`, `added?`.
- Configurer session as in Key Decisions; `save_integration` writes through the config store.
- OAuth: watch the connection until active; abandoned after an hour → removed from Composio.
- Inbox form with provider detection by domain (gmail.com, googlemail.com → Gmail icon; others → envelope); IMAP/SMTP hosts default from the domain (`src/email-providers.ts`), an unknown domain asks for them.
- Right-click menu on tool tiles (Edit settings, Reconnect, Remove from <name>).
**Tests (behaviours):**
- `save_integration` with an invalid entry is refused and nothing is written.
- the key value never appears in the configurer's messages (assert on the recorded session input).
- OAuth state reaches active when the fake Composio connection activates; Done enables after 5 s.
- an abandoned connection is removed after the hour (fake clock).
**Done when:** `npm test` and the integration e2e spec pass (fake Composio, fake configurer model responses).
- [x] Task 10 complete

### Task 11: Deploy, docs and parent design
**Files:** `deploy/update.sh`, `deploy/clots-web.service`, `README.md`, `.superpowers/specs/2026-10-10-clots-design.md` (sections 2, 6, 7, 11, 16 in place, no change notes), `clots.config.example.json`
**Build:**
- `update.sh`: `npm ci`, `npm run web:build` (when `web/`, `packages/` or the lockfile changed), write `data/web.env` (only `CLOTS_UI_SECRET` and the daemon URL), install/restart `clots-web.service`, ensure `tailscale serve --bg --https=8443 http://127.0.0.1:3000`.
- README: web UI setup (ui.owner, serve, installing on iPhone, notifications, developing behind `tailscale serve` with `CLOTS_UI_DEV_ORIGINS`), Discord sections removed.
- Example config: `ui.owner`, `askTimeoutMinutes`, no `discord`, no `sendReview`.
**Tests (behaviours):** `bash -n deploy/update.sh`; the example config validates with the schema.
**Done when:** `npm test`, `npm run typecheck`, `npm run web:build` pass.
- [x] Task 11 complete

## Manual Verification Checklist

**Shared setup:** Docker Desktop running (`docker info` succeeds). `npm ci`; `.env` with the existing keys; `clots.config.json` with `"ui": { "owner": "<your tailscale login>" }`. Start `npm run daemon` in the background and `npm run web:build && npm run web:start` with `CLOTS_UI_SECRET` (from `.env`) and `CLOTS_DAEMON_URL=http://127.0.0.1:8788` in the environment. `tailscale serve --bg --https=8443 http://127.0.0.1:3000`. Open `https://laptop-nj7mbno6.tailf707aa.ts.net:8443` in the built-in browser.

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
- **Steps:** 1. Ask Home: "Draft and ask to send a one-line test email from lukas@tady.ch to lukbicycles.com@gmail.com." 2. In the card, change the body to "Edited test." 3. Click Send.
- **Expected:** the card shows a calling or calm timer; after Send it collapses into "Sent an email · you allowed it"; the received email body is "Edited test."; Home's next turn is given a note listing the edit (whether the model mentions it is its own call).
- **How the executor runs it:** browser + checking the Gmail inbox in the built-in browser.

#### MV-5: Ask blocks at its deadline
- **Setup:** Settings → General → Ask timeout `00 h 02 m`, Save.
- **Steps:** 1. Ask Home to ask before sending another test email. 2. Wait without answering.
- **Expected:** Waiting for you shows it with the timer turning calling and then urgent ("0:59" … ), then it disappears; the ask's card in the chat shows "Blocked: no answer within 2 minutes." once, with no separate note; no email arrives.
- **How the executor runs it:** browser.

#### MV-6: Choice takes the Clot's pick
- **Steps:** 1. Ask encryptify: "Give me a choice between two test runners with ask_choice, then do nothing else." 2. Do not answer for the timeout.
- **Expected:** Waiting for you shows both options with the pick marked; after the deadline the card says which option it took; it is not "blocked".
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
- **Steps:** 1. Click + in the rail. 2. Pick the Sliders icon, name `graphite`, repository `hacker4ofakind/chess-gpt`. Next. 3. No tools; Create graphite.
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

All eleven tasks are built and ticked. The daemon's suite is `npm test` (111 files, 1,843 tests passed, 1 skipped); the web app has vitest (`npm test -w web`) and Playwright against the fake daemon, in both themes and at desktop and phone sizes, with axe. What has not run against the real services is listed under "Not live-verified". The builders' and fixers' working notes are in `.superpowers/handoffs/` (not committed).

### Deviations, and why
- **Rail**: lists every Clot and scrolls when they do not fit; there is no "…" menu after three (the user's fix list and the canvas show none). Order: Home, each Clot, New Clot, spacer, Waiting, Settings; no logo.
- **Next 16**: `middleware.ts` is `web/proxy.ts` (Next 16.4.6, React 19.3.1). The side pane (`side-pane.tsx`) is built on the shadcn `resizable` panels with its own grip, opens at a fixed width, and keeps no width between openings; the UI preferences schema still carries an unused optional `paneWidths` map.
- **Schemas** live in the workspace package `packages/ui-api-schemas` (`@clots/ui-api-schemas`), not `src/ui-api/schemas.ts`.
- **The asks restructure landed in Task 3**, not Task 4 (the conversation had to replace the reply path at once). `onFeedback` is optional (rule, memory and restart kinds leave typed text to the Clot). The email "draft" answer is gone. `needsAsk` is always true.
- **Message body limit 24 MB** (spec 20): up to 6 images of 5 MB are a third larger as base64 in JSON. Icon uploads 4 MB, everything else 256 KB.
- **Message kind `onboarding`** (data `{ repo, webhookUrl }`) joins the six kinds. Clot names keep capitals; `slugOf` (lower case) names everything on disk and in Docker.
- **Integration dialog**: audience is a Select, not segmented; the polling time shows when events are on and the toolkit has no webhook; one secret per connection (the generated `<TOOLKIT>_<ACCOUNT>_KEY`), a toolkit that needs its own OAuth app is refused at Finish; the daemon decides how a toolkit connects (`authFor`), never the configurer; `web_search` is the SDK's built-in `WebSearch`; the configurer cannot write recipes.
- **Live apply**: email accounts, generic Composio toolkits, MCP servers, gates, sweep, spend, hold, time zone and the other keys apply at once. Built-in toolkits (linear, notion, stripe, googlecalendar) and `intake`, `image`, `ui`, `rulebookDir`, `home`, `publicUrl` and the `.env` tokens need a restart (`needsRestart`, and `restartNeeded` on a tile). A hand-edited `repoUrl` is not re-cloned (logged; use Edit).
- **Held tools**: a tool added for a Clot that does not exist yet is held in its job and written by `POST /clots` with `toolJobs`.
- **Extra routes** beyond the plan: `GET /identity`, `GET /clots/:clot/build`, `PUT /clots/:clot`, `GET /clots/:clot/onboarding`, `POST /clots/:clot/read`, `POST /push/visibility`, `POST /push/test`, `GET /push/status`, `POST /integrations/jobs/:id/abandon`.
- **Push "no tab open"** means no device visible and in use for 2 minutes, not "no SSE client".
- **Email asks** use Edit, Don't send, Open in chat and Send (the spec's words, not the canvas's Block and Allow); the phone shows the same two answers as icon buttons.
- **Settings**: the Keys list shows the daemon's own keys with their buttons disabled and the reason; the New Clot tools step's Add tile keeps its "Add" caption; the settings column is 680 px wide on General and 720 on Manage Clots and Integrations, left aligned, whatever the content width.
- **Small ones**: `composio reconnect` joined the commands; worker status gained `done`; the phone's Clots list keeps an unread dot (not on the canvas); the stage is committed in checkpoints, not once. Planned items (todo, voice, browser, computer, Secret Storage, the Clapboard icon) are absent. The 403 and setup pages are drawn on no artboard; they use the status-page component of `NotFound` and `Error`.

### Names the 4b planner needs
Daemon
- UI API: `UiApi` (`src/ui-api/server.ts`; `127.0.0.1:8788`, `/api/v1`, header `X-Clots-UI-Secret`; `api.route(method, path, handler, { maxBytes })`, `ApiRequest`, `ApiResult`, `RawResult`, `ApiError`, `parseBody`). Routes in `src/ui-api/routes/{clots,clots-admin,settings,prefs,workers,push,integrations}.ts`.
- `EventBus` (`events.ts`; ring of 1,000; ids `<bootId>-<seq>`; heartbeat 20 s). Event types are `UI_EVENT_TYPES` in the schemas package: message.created, message.delta, message.done, activity, clot.state, ask.opened, ask.updated, ask.closed, workers.updated, config.changed, clot.build, integration.status, resync.
- `Conversation` (`src/conversation/conversation.ts`: `post`, `addUser`, `postActivity`, `activityLine`, `setState`, `postAsk`, `postWorkers`, `delta`) and `ConversationStore` (`store.ts`: messages, message_images, ask_history, ui_prefs). `MessageView { id, clot, sessionId, kind, text, ref, data, createdAt, images }`; kinds are in `MESSAGE_KINDS` (schemas) and `MessageKind` (`store.ts`; the column has no CHECK). `PostOptions.data` carries structured messages; `PostOptions.id` keeps a streamed reply's delta id.
- Asks: `Asks` (`src/asks.ts`: `answer`, `onUserMessage`, `list`, `snapshot`), `AskKind { onAnswer, onFeedback?, onDeadline, view }`, `AskAnswer`, `AskSnapshot`; choice numbers 0/1 in the API and 1/2 stored, converted in `src/asks/choice.ts`.
- Config: `ConfigStore` (`src/config-store.ts`: `onChange`, `save`, `reapply`, `reload`, `watch`, `keys`, `setKey`, `removeKey`, `usersOf`; `RESTART_KEYS`, `PROTECTED_ENV_KEYS`), `registerLiveConfig` and `LiveTargets` (`src/live-config.ts`), `LiveEnv` (`src/live-env.ts`; secrets are read from it, never from `process.env`).
- Connecting: `IntegrationJobs` (`src/integrations/jobs.ts`), `Configurer`, `sdkConfigurerModel`, `keyNameFor` (`configurer.ts`), `sourcesApplier` (`apply.ts`), `ComposioApi.listToolkits`.
- `safeFetch(url, { maxBytes, timeoutMs, maxRedirects, headers })`, `BlockedError`, `isPrivateAddress` in `src/net/safe-fetch.ts` (the configurer's `web_fetch` uses it; use it for the image proxy). Push: `Push`, `PushStore`, `allowedEndpoint` in `src/push.ts`. Runner hooks: `TurnBase.onText(text, key)`, `onTextDelta`, `onToolUse`, `images`; `TextStreams`.

Web
- Proxy route `web/app/api/d/[...path]/route.ts` and `web/app/api/stream/route.ts`, both through `guard` (`web/lib/guard.ts`: owner re-check, Origin equals the serve host, JSON content type, so every non-DELETE call, even a bodiless one, sends `{}`). Browser calls use `api()` from `web/lib/api-client.ts`; server code uses `daemon()`.
- Stream: `useStream({ onEvent, onOpen })` (`web/lib/stream.ts`) runs once inside `AppStateProvider`; screens use `useAppState().subscribe(fn)` and `onResync(fn)`.
- Markdown: `web/components/clots/markdown.tsx` (not a `chat/` folder); images render as links. The CSP `img-src` is `'self' data: blob: https://logos.composio.dev` (`web/proxy.ts`), so 4b's image proxy needs a same-origin route.
- Side pane: `useSidePane().open({ clot, label, render, width? })` (`side-pane.tsx`; `PANE_WIDTH` is the default, a caller such as the Clapboard passes its own `width`); the Info pane is its first user. The Clapboard header button goes beside the Info button in `chat-view.tsx`.
- Shared components in `web/components/clots/`: `segmented`, `stepper`, `list-card` (`ListCard`, `ListRow`), `icon-tile`, `status-dot`, `confirm-dialog`, `connection-icon` (`composioLogo()`), `field-row` (`FieldRow`, `PageHeader`), `time-input`, `timer`, `tool-tile`, `tool-logo`, `slash-menu`, `skeletons`. `IntegrationDialog` takes `clot?`, `open`, `onOpenChange`, `onAdded`, `edit?`, `resume?`, `retool?`, `added?`. Tokens are in `web/app/globals.css`.
- Fake daemon and e2e: `web/e2e/fake-daemon.mts` (port `FAKE_DAEMON_PORT`, default 8791; its control server is on that port + 1), `fake-integrations.mts`, `helpers.ts` (`gotoLive` waits for the stream; use it, not `goto`). Env: `E2E_WEB_PORT` (3100), `E2E_DAEMON_PORT` (8791), `NEXT_DIST_DIR` (a moved web port gets `.next-e2e-<port>`), and for the web app `CLOTS_DAEMON_URL`, `CLOTS_UI_SECRET`, `CLOTS_UI_DEV_OWNER`, `CLOTS_UI_DEV_HOST` (both ignored in production), `CLOTS_UI_DEV_ORIGINS` (dev behind `tailscale serve`).

### Surprises and traps
- A key tool is reported `active` when its entry is saved, not when Composio accepts the key (a wrong key shows as `unknown` or `waiting` and retries with backoff). `config.current` holds key values: `setKey` alone does not refresh them, so anything that changes a key under a live account calls `configStore.save({})` or `reapply()`.
- Jobs are in memory: a daemon restart drops them; `tick()` (every 3 s, from `daemon.ts`) is the only watcher of sign-ins and of the 1 h abandon. `Composio` exists only when `COMPOSIO_API_KEY` is in `.env` at start. Held tools that never become a Clot are dropped after an hour; the web abandons them on Reset and Remove, not on leaving the page. `PUT /inboxes/:account` writes the new password before the save, so a refused save loses the old one. A failed move after the container swap leaves the Clot on the new volume with the old entry.
- SQLite cannot drop a UNIQUE column, so the store migration rebuilds `sessions` and `user_asks` (regression test in `tests/store-migration.test.ts`). `choiceTimeoutMinutes` is renamed (`renamedKeysIn`); `discord` and `sendReview` are ignored (`legacyKeysIn`). The loader silently skips an entry it cannot use (for example no `publicUrl`), so a connection job checks `configStore.skipped` after saving and rolls back.
- **Lint is broken here**: the root TypeScript is 7.0.2 and typescript-eslint refuses it, so `npm run lint -w web` crashes. Builders linted through a TS 5 preload, which reported React-compiler rule errors in `app-state.tsx`, `clot-icon.tsx`, `onboarding-card.tsx`, `new-clot.tsx` and `integration-dialog`; they were not rechecked.
- **Icon uploads**: the browser reads a file as a base64 data URL, so the daemon decodes base64 and percent-encoded data URLs alike (`bytesOfDataUrl`); an `image/svg+xml` URL is not always percent-encoded text. The daemon never trusts the name or declared type, and the browser does not convert ICO.
- **Connection path**: `authFor` has no table of key-only built-ins and the config schema does not require `apiKey` for Linear, Notion or Stripe entries, because either would make a sign-in impossible for them; a built-in's sign-in entry carries no `apiKey`.
- **Asks in the session's context**: notes only reach a session through the next turn's prompt, so the `/close` recap turn is given the pending notes itself; an ask that closes with no note still leaves one. An email edit's note lists the removed and added lines and goes in front of the very next turn; whether the model mentions it is its own call.
- **`choiceTimeoutMinutes`**: the config store compares the old and new file after the legacy rename, so a file that still has the old key is read and saved as `askTimeoutMinutes` and applies live.
- **The onboarding card** asks the daemon for its steps every few seconds while one is open, because GitHub's ping reaches the daemon without any stream event.
- **The 403 and setup pages** are rendered by `web/proxy.ts` from the static HTML of `StatusPage`; Next refuses `react-dom/server` in the proxy.
- **Next's generated files**: a dev server with its own `NEXT_DIST_DIR` rewrites `web/tsconfig.json` (`include`), so run `git checkout web/tsconfig.json` before committing. Stale `web/.next*/types/**/validator.ts` naming a deleted page break typecheck and build (delete them). `web/AGENTS.md` and `web/next-env.d.ts` are generated and ignored.
- **Tests under a cold `next dev`** flake (a route's first compile outruns the timeouts). Parallel sessions collide on 8791 and 3100 and one wipes `web/test-results`: use your own ports and `--output`. Timers need `suppressHydrationWarning` (they read the clock on both sides). The browser pane blocks `_next` scripts on the tailnet URL (`ERR_BLOCKED_BY_CLIENT`): check through `next dev` with `CLOTS_UI_DEV_OWNER` behind a header-adding proxy, or the fake daemon. Without `CLOTS_UI_DEV_ORIGINS` a dev page behind `tailscale serve` never hydrates.
- Windows: Python rewrites LF files as CRLF (run `scripts/fix-eol.py` before committing; `src/store.ts` and `tests/composio-component.test.ts` have mixed endings in git: leave them). `web-push` 4 is ESM (named imports). `components/ui/label.tsx` sets `text-sm font-medium leading-none` and beats `text-label`, so callers use `!` overrides. Dark `--primary-hover` gives 3.9:1 with white text while hovered (the design's token; the e2e moves the pointer away). SSR paints a chat at its top until hydration scrolls it down.

### Not live-verified
- `ComposioApi.listToolkits` (`composio.toolkits.get({ sortBy: "usage", limit: 1000 })`) against the real Composio; if the limit is capped the list is shorter than the catalogue.
- The configurer model and `authFor` against the real Composio's answers for Linear, Notion and Stripe (the unit tests use the recorded fixtures `tests/fixtures/composio/meta/*.json`), the real sign-in, and that Linear's polled private-team triggers work on a managed-OAuth connection (they are connection-agnostic in the code).
- A tool added in the dialog making its key appear in Keys (the fake Composio does not write `.env`); ICO files from the wild beyond the generated ones (RLE and bitfield-with-masks bitmaps are refused).
- `sdkConfigurerModel` (Sonnet 5.5, medium effort, `createSdkMcpServer` plus `WebSearch`, 5 minutes, 30 turns) has not run against the real Anthropic API. The daemon wiring of jobs and the creator was type-checked and unit-tested; Docker was not started for it.
- Push on iOS (MV-19, user-only); the service worker registering in the installed app (it did not register in the built-in browser; try Chrome first); `tailscale serve` and the deploy on the Pi (MV-20).

### For the 4b planner
- Widgets render only in `clot` messages, never in notes, asks, onboarding or user text; the pane takes any `render()`.
- A new message kind touches `MESSAGE_KINDS`, `MessageKind`, the chat renderer and `activity-lines.ts`. The Clapboard icon is the one custom icon.
- Main turns stream through `TextStreams` and workers do not, so a widget in a streaming reply must tolerate a half-written body until `message.done`.
- Reuse `safeFetch` for the image proxy and add its route to the CSP; markdown images are links today.
