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

The Clot looks into an event in a locked turn: it can read files, run read-only commands and use the web, and it cannot change anything until you answer in chat. Brainstorm mode uses the same lock.

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

A Clot can save email drafts in your Drafts folder, read your calendar, add or move events without guests, and remove one only after you say yes in chat and again in a `-cal` channel. Nothing is sent to anyone except a standing rule you approved.

## Commands

A message that starts with `&` is handled by the daemon and never reaches the model.

| Command | What it does |
|---|---|
| `&close` | Closes the session and starts a new one in a new channel, seeded with a recap, as a context rollover does. |
| `&close nosummary` | Starts a new session from scratch: no recap, action mode. |
| `&effort low\|medium\|high` | Sets the effort for your next message only. |
| `&effort low\|medium\|high <message>` | Sends the message at that effort. |
| `&rules`, `&rules undo` | Lists the rules in force for this Clot, routing rules included; undoes the latest edit made from chat. |
| `&memory`, `&memory undo` | Lists the global memories; undoes the latest change. |

## Test

```bash
npm test
npm run typecheck
```

## Running in a Claude Code cloud environment

Run `npm run preflight` first. If it fails, the environment cannot run a Clot; use a local machine.
