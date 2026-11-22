# Clots

Always-on agents built on Claude Code. Design: `.superpowers/specs/2026-10-10-clots-design.md`.

This repository implements stages 1 and 2:

- **Stage 1**: Clots, each in its own container, reachable through Discord.
- **Stage 2a**: GitHub events reach the Clot, which investigates them (the pipeline).
- **Stage 2b**: the rulebook, with standing rules and global memory.
- **Stage 2c**: more sources: Stripe, email, Google Calendar, Linear, Notion, MCP servers and recipe webhooks.
- **Stage 2d**: gates, digests, the spend log, the sweep and re-grounding.
- **Stage 2e**: Composio: Stripe, Linear, Notion, Google Calendar, PostHog and any other service it has a toolkit for, through one layer, with writes rated by the account's audience. Any toolkit connects from one entry whatever its auth scheme, and the Clots extend the integrations themselves with recipes.

The main session runs at medium effort by default, and at low only for a message it answers without taking any action.

## Requirements

- Node 22.22.3 or later
- Docker (Docker Desktop on Windows; open it before starting)
- A Claude subscription, a Discord bot, and a GitHub account for the Clots with a classic token, invited to each Clot's repository
- Tailscale with Funnel, so GitHub's and Composio's webhooks can reach the daemon
- A Composio account (the free Hobby plan is enough) for Stripe, Linear, Notion, the calendar and PostHog

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
| Email | An app password (Gmail) or the account's password; the folders or Gmail labels to watch. Nothing else is read. On Gmail, add each alias standing replies should come from under Settings → Accounts → Send mail as. | none: IMAP |
| GitHub | The repository's webhook, with the secret in `.env`. | `/webhooks/github` |
| Stripe, Linear, Notion, Google Calendar, PostHog, and any other toolkit (Slack, Reddit, Supabase, ...) | An account under `sources.composio`; see Composio below. A Clot can add a service for you. | `/webhooks/composio` (Notion's events: `/webhooks/notion/<account>`) |
| Any MCP server, or a Composio account | Under `mcpServers`; an OAuth server gets a login link in chat. Watch recipes in the rulebook call a server's read-only tools, or a Composio account's, on a timer. | `/oauth/callback` |
| Any other webhook | A webhook recipe in the rulebook; its secret is an `.env` key beginning `RECIPE_`. | `/webhooks/r/<recipe>` |

Run a source's assumption check before relying on it: `scripts/spike-2c-email.ts`, `scripts/spike-2c-watch.ts`, `scripts/spike-2e.ts` (Composio; see its header), and `scripts/capture-2c.ts <source>` or `scripts/capture-2e.ts` to see deliveries arrive.

A Clot can save email drafts in your Drafts folder, read your calendar, and add, move or remove events without guests, at once; each change is posted, and `&calendar undo` reverses it. A repeating event is never removed. In a turn an outsider's message started, it may only add events (at most 3 a day) and change ones a Clot added. Nothing goes to anyone without your yes: a standing rule you approved, or an email the Clot asks to send (see Asks). Unanswered emails are withdrawn after `sendReview.days` (default 3); `"sendReview": { "enabled": false }` in `clots.config.json` leaves only drafts and standing rules. Sent mail gets a copy in Sent (Gmail files its own). The Clots are told each email account's addresses; set `"tellAddress": false` on an account to show them only its name.

### Composio

Composio holds the connections, sends their events to one webhook and runs their tools. Make a project at composio.dev under the Clots' own address, create a project API key (it needs: Tools read; Session management read and write; Session tool execution write; Connected accounts read and write; Auth configs read and write; Toolkits read; Triggers read and write; Webhooks read and write; Observability read), and put it in `.env` as `COMPOSIO_API_KEY`. Only the daemon reads it; it never enters a container.

```json
"sources": {
  "composio": [
    { "toolkit": "linear", "account": "proton", "clot": "encryptify", "audience": "team", "apiKey": "LINEAR_PROTON_KEY" },
    { "toolkit": "notion", "account": "main", "shared": true, "audience": "private", "apiKey": "NOTION_CONNECTION_API_KEY" },
    { "toolkit": "stripe", "account": "shop", "clot": "encryptify", "audience": "public", "apiKey": "STRIPE_SHOP_KEY" },
    { "toolkit": "googlecalendar", "account": "personal", "shared": true, "audience": "private", "leadTimes": ["24h"], "pollMinutes": 5 },
    { "toolkit": "posthog", "account": "app", "clot": "encryptify", "audience": "public", "apiKey": "POSTHOG_APP_KEY", "connect": { "subdomain": "us" }, "triggers": [{ "slug": "POSTHOG_EVENT_CAPTURED", "config": { "project_id": 123456, "event_names": ["signup"] } }] }
  ]
}
```

`audience` says who sees what happens in an account: `private` (only you and the Clots), `team` (you and people you know well), or `public` (anyone: customers, a community; the default). The Clot can act in every account through `composio_find` and `composio_run`. A tool that only reads always runs. In a private or team account a write runs at once and is posted with `&composio undo`; a destructive write in a team account (or any write in a turn an outsider's text started) may go to a Haiku 5.5 reviewer first. A write in a public account, anything that moves money (every Stripe write), reaches people outside the workspace (email, direct messages, sharing, publishing) or changes who can reach the workspace (webhooks, keys, roles) is an ask you answer in `<clot>-ask`. Calendar changes go through `calendar_write` and `calendar_remove` only.

- **Keys.** Each account's key stays in `.env`; change it there and restart, and the daemon replaces the connection. Stripe's restricted key needs read access, and read and write access to webhook endpoints, which Composio uses to make its destination. PostHog's personal API key needs the `hog_function:write` scope. PostHog is a generic entry: its region is `connect.subdomain` (`us` or `eu`), and the project (`project_id`, the number in the project's URL) and the event names go in a `POSTHOG_EVENT_CAPTURED` trigger's config. The daemon ships the recipe that turns its events into `analytics_event`s, which a Clot can reshape like any recipe.
- **Linear.** The Clots' member's key. Composio polls the team's issues and comments every minute (its webhook triggers need a Linear OAuth app).
- **Notion.** The connection's secret, with the pages shared with it. Its events keep their own webhook: in the connection's Webhooks tab set `<publicUrl>/webhooks/notion/<account>`; the daemon prints the verification token in its log for you to paste back. Composio reads the pages and comments for the enrichment, and sends the comments of standing rules.
- **Google Calendar.** No Google Cloud project and no iCal address. The first time, the daemon posts `Sign in to Google Calendar for the Clots: <link>` in the channel of the Clot the account is bound to (the home Clot's, for a shared account); open it and approve. The monthly polling of all calendars together may not pass 10,000 calls (`43200 / pollMinutes` each).
- **The free plan.** Composio's Hobby plan allows 100,000 tool calls and 50,000 trigger events a month (20,000 and 10,000 on its own apps, which is the calendar), and stops at the limit until the next month. The daemon counts them, says so in the home Clot's channel at 70% and 90%, and once when a limit is reached.
- **When something stops working.** Once a day the daemon checks each connection and trigger and makes again what Composio lost or disabled, and tells the Clot's channel when it cannot. It also tells you, once per start, when a tool it reads answers in a shape it does not expect ("Composio's <tool> answered in an unexpected shape"): what the daemon reads through that tool is then treated as unreadable until the code is updated. One thing it cannot see: a Stripe webhook endpoint deleted in Stripe, since Composio has no tool that lists them. If Stripe's events stop, remove the Stripe account from `sources.composio`, restart, add it back and restart again; that makes the endpoint again.
- **Any other toolkit.** See the next section.

#### Any other toolkit

One entry connects any toolkit Composio has, whatever its auth scheme. The daemon reads from Composio how the toolkit connects and what fields it needs, and the entry says which way:

```json
{ "toolkit": "slack", "account": "work", "shared": true, "audience": "team", "triggers": [{ "slug": "SLACK_CHANNEL_MESSAGE_RECEIVED", "config": { "channel_id": "C0123" } }] },
{ "toolkit": "supabase", "account": "shop", "clot": "encryptify", "audience": "team", "fields": { "full": "SUPABASE_SHOP_URL", "bearer_token": "SUPABASE_SHOP_KEY" } },
{ "toolkit": "slack", "account": "big", "shared": true, "audience": "team", "oauthApp": { "clientId": "SLACK_CLIENT_ID", "clientSecret": "SLACK_CLIENT_SECRET" } }
```

- **No key field** (the Slack entry): Composio's own OAuth app. The daemon posts `Sign in to Slack for the Clots: <link>` in the channel of the Clot the account is bound to (the home Clot's, for a shared account), and says to sign in with the Clots' own account at the service, not yours. Within a minute of approving, the account's identity is read and its triggers are made.
- **`apiKey`**: the `.env` key holding the one required field of a key scheme, under the field's own name. **`fields`**: for a scheme of several fields (Supabase's `full` and `bearer_token`), each field Composio names mapped to its `.env` key. **`scheme`**: which key scheme, when a toolkit has several. Change a value in `.env` and restart: the connection is replaced.
- **`oauthApp`**: your own OAuth app (client ID and secret, each an `.env` key). It counts against Composio's larger allowance instead of the smaller one the calendar shares, which matters for a service that sends more than about 100 events a day. Register Composio's redirect URL in the app: `https://backend.composio.dev/api/v1/auth-apps/add`; the scopes come from the toolkit's auth config in Composio. Not with `apiKey` or `fields`.
- **`selfIsUser`**: `true` when the connection is your own account at the service, not the Clots'. Then your own messages are not dropped as the Clots', and only what the Clots' own writes touched is (`ownWrites` in the recipe).
- **A mismatch** (a key for a toolkit that has only a sign-in, a missing field) is told once per start in the account's channel, naming what the toolkit accepts; nothing else waits on it. The `.env` keys must be ones nothing else uses (not `COMPOSIO_API_KEY`, a Discord or GitHub token or a `RECIPE_` key).
- **`&composio reconnect <toolkit>:<account>`** deletes the account's connection and its learned identity and signs in again (a new link, or the `.env` values for a key account): the way to put right a sign-in made with the wrong account.

##### Asking a Clot to add a service

Tell a Clot "I want Slack messages from #general". It uses the `composio-integration` skill (shipped in `plugin/`, copied into every container at `/opt/clots/plugin` at each start, root-owned so a Clot cannot rewrite its own instructions): it reads the toolkit with `composio_toolkit`, prefers webhook triggers, says what a polled trigger or a watch would cost of the monthly allowance and waits for your yes, asks whether the Clots have an account of their own at the service, and gives you the exact entry and `.env` keys. **You** add them to `clots.config.json` and `.env` and restart: a Clot never edits either. Once the account is connected and a message has arrived (the daemon keeps the last 5 payloads of each trigger for 7 days, 64 KB each), the Clot writes a recipe from it, tries it with `composio_try` on every kept payload and sets it with `rulebook_composio`; you are shown it with `&rules undo`.

##### Composio recipes and watches

A **Composio recipe** (`composio:` in `global.yaml` or a Clot's file) turns a toolkit's trigger payloads into proper events: `kind`, `title`, `actor`, `body`, an `id` for dropping repeats, the actor's ID and the objects the event is about (for dropping what the Clots' own writes caused), and up to 3 read-only `enrich` calls per trigger that fill in names (the channel's and the author's) before the event is routed. It is data checked by a schema, never code the daemon runs; it cannot rate a write or add an undo, and its events are always from an outsider. Reads are cached for 24 hours and skipped, with a line in the body, once 80% of the month's allowance is used. An unlisted trigger is mapped generically. A recipe applies to every account of its toolkit, is addressed by the toolkit, and cannot name a toolkit with built-in support or a name another recipe has.

A **watch recipe** may name `account: reddit:me` in place of an MCP server and one of that toolkit's read tools, for a toolkit with no triggers. It runs every 15 minutes or less often, a tool that is not a read is refused, every run counts against the allowance, and the calendars' polling and all such watches together may not pass 10,000 calls a month (a watch that would is refused, with the reason).

After updating, `&close` each Clot: a resumed session keeps the system prompt and the plugin list it was made with, and learns about the skill only from a new one.

Upgrading from stage 2c's Stripe, Linear, Notion and calendar sources: `sources.stripe`, `.linear`, `.notion` and `.calendar` no longer exist (the daemon names the key and refuses to start); move each into `sources.composio` as above. Delete the Stripe endpoint and the Linear webhook that pointed at `/webhooks/stripe/…` and `/webhooks/linear/…`; the Notion webhook stays. Then `&close` each Clot, since a resumed session keeps the system prompt it was made with, and the Clots only learn about Composio from the new one. `setup/calendar.gs` and `ical.js` are gone.

## Asks and choices

Whatever needs your yes is asked in a temporary channel in the Clot's category, which mentions you once. Answer there; the channel goes once it is carried out. A reply is matched exactly: `yes`, `sure`, `do that` or `yeah`; `no`, `dont` or `not at all`.

| Ask | Channel | What the answers do |
|---|---|---|
| A rule change: any standing rule, or any rulebook edit from a turn an outsider's text started | `<clot>-rule` | yes applies it, no declines it; anything else repeats the question. |
| An email to send | `<clot>-mail` | yes sends it, no drops it, `draft` saves it in Drafts; anything else is feedback, and the revised email comes back in a new channel. |
| A write in a Composio account, from `composio_run`, that the rating sent to you: a public account, money, people outside the workspace, access, or the reviewer's `ask` | `<clot>-ask` | yes runs it exactly as shown (every argument is in the post), no declines it; anything else goes to the Clot as feedback and closes it. It never expires. |
| A merge, from `merge_pull_request` | `<clot>-ask` | yes squash-merges the pull request at the commit shown (GitHub refuses if it moved), no leaves it open; anything else goes to the Clot. New commits or a closed pull request withdraw it. |
| A choice, from `ask_choice` | `<clot>-choice` | `1`/`one`/`first`, `2`/`two`/`second`, or `your pick`/`go ahead` decide it; anything else goes to the Clot as your answer. |
| A global memory the home Clot wrote in a turn an outsider's text started | `<clot>-memory` | yes gives it to every Clot; no puts the home Clot's copy back. |

A choice not answered within 10 minutes (`choiceTimeoutMinutes` in `clots.config.json`, 1 to 1440) is decided by the Clot's pick: it says which it took, and an answer in its live channel switches it. Every open ask and choice is listed in one pinned message in `clots-waiting`, at the top of the server, with a link to where it is answered and, for a choice, when it decides. The bot needs the Pin Messages permission to pin it.

Global memories the home Clot writes apply to every Clot at once and are posted with `&memory undo`; only one written in a turn an outsider's text started is asked first.

## Gates, digests and spend

During the hours you keep for your own Claude use, the Clots step back. In **scarce** windows (default 15:00–18:00, Monday to Friday, in `timeZone`) and in a **lead-in** window (default 10:00–15:00) while the account's five-hour usage is at or above `leadInPercent` (default 50), an ordinary event gets its one-line notice ending "(waiting until 18:00)" and waits. When the gate lifts, what waited arrives as one digest turn of at most ten events (a single event runs as an ordinary investigation). Your messages, urgent events, workers' reports, choice timeouts and workers asked for in your own messages still run at once; a worker asked for anywhere else waits in the queue. While a gate holds, the main session is told to pick one step cheaper models for workers. The usage-limit pause (stage 1) is separate and always wins. The usage is the whole account's, yours included; it is read from each turn's rate-limit events, and from the SDK's usage call in a container logged in with `claude /login` (a container using the `claude setup-token` token has no plan limits to read, so the lead-in never holds there).

```json
"gates": {
  "scarce": { "mon": "15:00-18:00", "tue": "15:00-18:00", "wed": "15:00-18:00", "thu": "15:00-18:00", "fri": "15:00-18:00" },
  "leadIn": { "mon": "10:00-15:00", "tue": "10:00-15:00", "wed": "10:00-15:00", "thu": "10:00-15:00", "fri": "10:00-15:00" },
  "leadInPercent": 50
},
"sweep": { "enabled": true, "everyMinutes": 180 },
"spend": { "weeklyWarnUsd": 50 }
```

Giving `scarce` or `leadIn` replaces its whole default; `{}` means no windows. A window is `HH:MM-HH:MM`, start before end, and ends the same day. `spend: {}` turns the warning off.

The daemon logs what every model call costs, per Clot and worker, with the SDK's estimate in USD (on a subscription an estimate of API prices, not a bill; stopped turns may go uncounted, so it is a floor). `&spend` shows this week. A Clot that passes `spend.weeklyWarnUsd` in a week is reported once in its channel.

Every `sweep.everyMinutes` (at least 15) one read-only sweep looks at the connectors of the claude.ai login (Claude Docs and the like) in the home Clot's container, or the first with its own login, and turns what changed into events from the source `sweep`, kind `finding` (usable in rule files). It skips the sources the daemon already hears from, and is skipped while a gate or the usage limit holds. Log in once with `docker exec -it clot-home claude /login`. The first sweep only records a baseline.

Claude Code keeps a session's prompt cache for one hour on a subscription (five minutes on usage credits or an API key). So that a Clot's next message does not pay to read its whole context again, the daemon sends the Clot's session a small "keeping the cache warm" message 55 minutes after that Clot's last turn, whatever the turn was, and again 55 minutes after each ping. The ping and the Clot's one-word reply go to the daemon's log only, never to Discord, the ping runs at low effort (other turns keep theirs), and the Clot may not use any tool in it. Each ping is a short turn that shows in `&spend`.

After every rollover that carries a recap (`&close` and the context limit), a short re-grounding session checks what the recap says is open against the current state; what differs is posted under "Since the recap was written:" and handed to the new session. `&close nosummary` skips it. A session started before this version keeps its old system prompt: send `&close` in each Clot once after updating.

## Commands

A message that starts with `&` is handled by the daemon and never reaches the model.

| Command | What it does |
|---|---|
| `&close` | Closes the session and starts a new one in a new channel, seeded with a recap, as a context rollover does. |
| `&close nosummary` | Starts a new session from scratch: no recap, action mode. |
| `&effort low\|medium` | Sets the effort for your next message only. |
| `&effort low\|medium <message>` | Sends the message at that effort. |
| `&rules`, `&rules undo` | Lists the rules in force for this Clot, routing rules included; undoes the latest edit made from chat. |
| `&memory`, `&memory undo` | Lists the global memories in force; undoes the latest change. |
| `&calendar undo` | Reverses this Clot's latest calendar change: removes an event it added, puts back what it changed, or creates again one it removed. Sent again, it steps further back. |
| `&composio undo` | Reverses this Clot's latest Composio write that can be undone: archives what it created, or puts back the fields an update changed (unless someone changed them since). Sent again, it steps further back. |
| `&composio reconnect <toolkit>:<account>` | Deletes that Composio account's connection and learned identity and signs in again: a new link, or a fresh connection from the `.env` values for a key account. Answered `No Composio account <name>.` for an unknown one. |
| `&spend` | This week's estimated spend per Clot and worker, the gate in force, and the five-hour and seven-day usage. Answered at once, even during a turn. |

## Deploy on a server

A Clots server runs the daemon as a systemd service, started at boot and restarted if it stops. It assumes Ubuntu Server (arm64 or x64) with a `clots` user (key-only SSH, `sudo` allowed), the host named `clots`, and Tailscale installed and joined to your tailnet. The checkout lives at `/home/clots/clots`.

1. On the server, clone the repository and run the setup script from the clone. It is safe to run again.

   ```bash
   git clone https://github.com/hacker4ofakind/clots.git ~/clots && cd ~/clots && sudo ./deploy/setup-pi.sh
   ```

   It installs Docker and Node.js 26.13.1 (held at that version; change `NODE_VERSION` in the script to move), builds the Clot image, installs the systemd units and a sudoers rule that lets `clots` run `systemctl restart clots`, turns on Tailscale Funnel for port 8787, and prints which config files are still missing.

2. Create `~/clots/.env` (`chmod 600`) with `DISCORD_BOT_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, `CLOT_GITHUB_TOKEN` and `GITHUB_WEBHOOK_SECRET`, and `~/clots/clots.config.json` from `clots.config.example.json` (`publicUrl` is the Funnel address). If a development daemon also runs somewhere, the server needs a Discord bot and server of its own, and its own webhook secret: two daemons on one bot token both receive every message.

3. Run `sudo ./deploy/setup-pi.sh` again. It starts the service once both files exist.

4. Log each container in to Claude once: `docker exec -it clot-<name> claude /login`, then `sudo systemctl restart clots`. The daemon looks for a login only when it prepares a container, so until the restart it keeps using the token from `.env`.

To deliver new code, push it to GitHub and run `npm run deploy` on your computer. It runs `deploy/update.sh` on the server over SSH (`CLOTS_HOST` overrides the default `clots@clots`): pulls, runs `npm ci` and rebuilds the image only when the lockfile or `docker/` changed, restarts the service and prints its state. A deploy during a turn interrupts it; the daemon resumes it after the restart. If the checkout has local changes, or the service is not active afterwards, it exits non-zero, and the next deploy redoes every step.

Logs: `journalctl -u clots`. Backups: `~/clots-backups/<date>.tar.gz`, one per night at 03:30 (the database, the rulebook and each Clot's home volume, which holds its Claude login), the 7 newest kept. They sit on the same disk as the data.

Moving to another machine: Tailscale names a second machine that joins as `clots` `clots-1`, and the suffix sticks. Rename the old one first (`sudo tailscale set --hostname=clots-pi`), join the new one as `clots`, then remove the old one from the tailnet; `publicUrl` and the GitHub webhook keep working.

## Test

```bash
npm test
npm run typecheck
```

## Running in a Claude Code cloud environment

Run `npm run preflight` first. If it fails, the environment cannot run a Clot; use a local machine.

<!-- mid-turn deploy test -->
