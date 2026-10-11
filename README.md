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

Rules live in `rulebook/`, a git repository of its own that the daemon creates: `global.yaml` for every Clot and `<clot>.yaml` for one. Edit them by hand; changes apply when a file is saved.

## Commands

A message that starts with `&` is handled by the daemon and never reaches the model.

| Command | What it does |
|---|---|
| `&close` | Closes the session and starts a new one in a new channel, seeded with a recap, as a context rollover does. |
| `&close nosummary` | Starts a new session from scratch: no recap, action mode. |
| `&effort low\|medium\|high` | Sets the effort for your next message only. |
| `&effort low\|medium\|high <message>` | Sends the message at that effort. |

## Test

```bash
npm test
npm run typecheck
```

## Running in a Claude Code cloud environment

Run `npm run preflight` first. If it fails, the environment cannot run a Clot; use a local machine.
