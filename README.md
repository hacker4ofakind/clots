# Clots

Always-on agents built on Claude Code. Design: `.superpowers/specs/2026-10-10-clots-design.md`.

This repository currently implements stage 1 (one Clot, in a container, reachable through Discord) and stage 2a (GitHub events reach the Clot, which investigates them without being able to change anything).

## Requirements

- Node 22 or later
- Docker (Docker Desktop on Windows; open it before starting)
- A Claude subscription, a Discord bot, and a GitHub account for the Clots with a classic token, invited to each Clot's repository
- Tailscale with Funnel, so GitHub's webhooks can reach the daemon

## Setup

```bash
npm install
npm run preflight     # checks CPU, memory, disk and Docker
npm run image         # builds the Clot image
cp .env.example .env  # then fill in the three tokens and the webhook secret
cp clots.config.example.json clots.config.json  # then fill in the IDs, time zone and repository
```

`CLAUDE_CODE_OAUTH_TOKEN` comes from running `claude setup-token`.

## Run

```bash
npm run daemon
```

## Events

GitHub sends webhooks to the daemon through a tunnel:

```bash
tailscale funnel --bg 8787
```

On each Clot's repository, add a webhook with the Funnel address followed by `/webhooks/github`, content type `application/json`, the secret from `.env`, and these events: Issues, Issue comments, Pull requests, Pull request reviews, Workflow runs.

The main session is locked in every turn: it reads files, runs read-only commands and uses the web, and code work goes to workers, which open pull requests. What it does is rated on four axes (undoable, seen only by you, under $5, commits you to nothing). Anything low on all four it does in any turn, without asking, and posts with its undo. Anything else becomes an ask (see below).

Automated reports about the same pull request or branch (failed CI runs, comments from deploy bots) are held for a minute or two and reach the Clot as one event. The timings are `hold.quietSeconds` and `hold.capSeconds` in `clots.config.json`. A review reaches the Clot together with its inline comments.

Rules live in `rulebook/`, a git repository of its own that the daemon creates: `global.yaml` for every Clot and `<clot>.yaml` for one. Edit them by hand, or ask a Clot; changes apply when a file is saved.

## Sources

Every source is set up under `sources` in `clots.config.json`, one entry per account. An account is bound to one Clot (`"clot": "name"`) or shared (`"shared": true`); events from a shared account are routed by the `routing` rules in `rulebook/global.yaml`, then by a routing call, then to the home Clot. A credential is never written in the configuration file: it names the `.env` key that holds it. `publicUrl` is the Funnel address. `clots.config.example.json` shows every source.

| Source | Set up | Webhook address |
|---|---|---|
| Stripe | An endpoint in the Stripe dashboard for the events in the spec, and a restricted key with read access. | `/webhooks/stripe/<account>` |
| Email | An app password (Gmail) or the account's password; the folders or Gmail labels to watch. Nothing else is read. On Gmail, add each alias standing replies should come from under Settings → Accounts → Send mail as. | none: IMAP |
| Google Calendar | The calendar's secret iCal address; for changes, the Apps Script in `setup/calendar.gs`, deployed by you. No Google Cloud project. | none: polled |
| Linear | A member for the Clots with its own API key, and a webhook for issues and comments. | `/webhooks/linear/<account>` |
| Notion | A connection (an internal integration) added to your pages, and a webhook subscription; the daemon prints the verification token in its log. | `/webhooks/notion/<account>` |
| Any MCP server | Under `mcpServers`; an OAuth server gets a login link in chat. Watch recipes in the rulebook call its read-only tools on a timer. | `/oauth/callback` |
| Any other webhook | A webhook recipe in the rulebook; its secret is an `.env` key beginning `RECIPE_`. | `/webhooks/r/<recipe>` |

Run a source's assumption check before relying on it: `scripts/spike-2c-email.ts`, `scripts/spike-2c-calendar.ts`, `scripts/spike-2c-watch.ts`, and `scripts/capture-2c.ts <source>` to see deliveries arrive.

A Clot can save email drafts in your Drafts folder, read your calendar, and add, move or remove events without guests, at once; each change is posted, and `&calendar undo` reverses it. A repeating event is never removed. In a turn an outsider's message started, it may only add events (at most 3 a day) and change ones a Clot added. Nothing goes to anyone without your yes: a standing rule you approved, or an email the Clot asks to send (see Asks). Unanswered emails are withdrawn after `sendReview.days` (default 3); `"sendReview": { "enabled": false }` in `clots.config.json` leaves only drafts and standing rules. Sent mail gets a copy in Sent (Gmail files its own). The Clots are told each email account's addresses; set `"tellAddress": false` on an account to show them only its name.

Redeploy `setup/calendar.gs` after updating: newer versions report repeating and missing events, which the daemon checks before removing or putting back an event.

## Asks and choices

Whatever needs your yes is asked in a temporary channel in the Clot's category, which mentions you once. Answer there; the channel goes once it is carried out. A reply is matched exactly: `yes`, `sure`, `do that` or `yeah`; `no`, `dont` or `not at all`.

| Ask | Channel | What the answers do |
|---|---|---|
| A rule change: any standing rule, or any rulebook edit from a turn an outsider's text started | `<clot>-rule` | yes applies it, no declines it; anything else repeats the question. |
| An email to send | `<clot>-mail` | yes sends it, no drops it, `draft` saves it in Drafts; anything else is feedback, and the revised email comes back in a new channel. |
| A merge, from `merge_pull_request` | `<clot>-ask` | yes squash-merges the pull request at the commit shown (GitHub refuses if it moved), no leaves it open; anything else goes to the Clot. New commits or a closed pull request withdraw it. |
| A choice, from `ask_choice` | `<clot>-choice` | `1`/`one`/`first`, `2`/`two`/`second`, or `your pick`/`go ahead` decide it; anything else goes to the Clot as your answer. |
| A global memory the home Clot wrote in a turn an outsider's text started | `<clot>-memory` | yes gives it to every Clot; no puts the home Clot's copy back. |

A choice not answered within 10 minutes (`CLOTS_CHOICE_TIMEOUT_MINUTES`, 1 to 1440) is decided by the Clot's pick: it says which it took, and an answer in its live channel switches it. Every open ask and choice is listed in one pinned message in `clots-waiting`, at the top of the server, with a link to where it is answered and, for a choice, when it decides. The bot needs the Pin Messages permission to pin it.

Global memories the home Clot writes apply to every Clot at once and are posted with `&memory undo`; only one written in a turn an outsider's text started is asked first.

## Commands

A message that starts with `&` is handled by the daemon and never reaches the model.

| Command | What it does |
|---|---|
| `&close` | Closes the session and starts a new one in a new channel, seeded with a recap, as a context rollover does. |
| `&close nosummary` | Starts a new session from scratch: no recap, action mode. |
| `&effort low\|medium\|high` | Sets the effort for your next message only. |
| `&effort low\|medium\|high <message>` | Sends the message at that effort. |
| `&rules`, `&rules undo` | Lists the rules in force for this Clot, routing rules included; undoes the latest edit made from chat. |
| `&memory`, `&memory undo` | Lists the global memories in force; undoes the latest change. |
| `&calendar undo` | Reverses this Clot's latest calendar change: removes an event it added, puts back what it changed, or creates again one it removed. Sent again, it steps further back. |

## Test

```bash
npm test
npm run typecheck
```

## Running in a Claude Code cloud environment

Run `npm run preflight` first. If it fails, the environment cannot run a Clot; use a local machine.
