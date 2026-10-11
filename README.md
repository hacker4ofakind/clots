# Clots

Always-on agents built on Claude Code. Design: `.superpowers/specs/2026-10-10-clots-design.md`.

This repository currently implements stage 1: one Clot, in a container, reachable through Discord.

## Requirements

- Node 22 or later
- Docker (Docker Desktop on Windows; open it before starting)
- A Claude subscription, a Discord bot, and a GitHub fine-grained token for the Clot's repository

## Setup

```bash
npm install
npm run preflight     # checks CPU, memory, disk and Docker
npm run image         # builds the Clot image
cp .env.example .env  # then fill in the three tokens
cp clots.config.example.json clots.config.json  # then fill in the IDs, time zone and repository
```

`CLAUDE_CODE_OAUTH_TOKEN` comes from running `claude setup-token`.

## Run

```bash
npm run daemon
```

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
