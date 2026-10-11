# Clots: design

Date: 2026-10-10
Status: approved in brainstorming. Stage 1 is implemented; stage 2 is next.

## 1. What Clots is

Clots are always-on agents built on Claude Code, in the spirit of OpenAI's dots and
Grok Bot. Each opted-in project gets one Clot, plus one "home" Clot for things that
belong to no project. A Clot:

- is triggered by events from connected services, by the user's chat messages, and
  by a 90-minute clock;
- investigates on its own, proposes one or two actions, and after the user's
  go-ahead carries the work through to an open pull request;
- has its own isolated computer (a container with a repo clone and a browser);
- lives in one long session, rolled over into a fresh session with a written recap
  when context reaches 65% or when the user closes it;
- is text only. Voice is out of scope.

It is not specific to SaaS businesses; the examples in this document are
illustrative.

## 2. Architecture

One daemon runs on a Raspberry Pi 5 (8 GB RAM, 512 GB microSD) and owns everything
that must be always-on: event intake, the clock, the chat bots, the queue, and
control of the Clot containers.

Each Clot is a Docker container. Claude Code runs inside the container, driven by
the daemon through the TypeScript Agent SDK. The intended mechanism is the SDK's
`spawnClaudeCodeProcess` option, pointing at the container, so every built-in tool
(Bash, Read, Edit, Glob, Grep) operates inside the container.

The user's PC is not part of the running system. It is used for the `clots` CLI
and for development.

Each Clot has a `host` setting (the Pi, or another Docker host such as the PC). A
project too heavy for the Pi can be hosted elsewhere with the same image.

### Components

| Component | Responsibility | Depends on |
|---|---|---|
| Intake | Receive webhooks, hold IMAP IDLE connections, run watch recipes, fire the 90-minute tick. Normalise everything into one event format carrying source, arrival time and payload. | Tunnel, source credentials |
| Rulebook | Files under version control, one global and one per Clot: pre-filters, routing match rules, triage guidance, urgency markers, standing-rule templates, watch recipes. | None |
| Triage | Sonnet 5.5 (`claude-sonnet-5-5`), low effort, no tools, fixed output schema. | Rulebook |
| Gates | Decide whether an event is delivered now or queued. | Usage events, schedule, mode |
| Router | Haiku 5.5 (`claude-haiku-5-5`), medium effort, no tools. Picks the effort level for every prompt and detects brainstorm start and stop. | Recent messages |
| Session manager | Start a Clot's process for a turn, resume its session, apply effort and mode, stop the process afterwards. Enforce one heavy job at a time per host. | Agent SDK, Docker |
| Clot container | The Clot's computer: repo clone, Chromium with a persistent profile, live view, scoped credentials, its own Claude login, a copy of the user's Claude setup. | Image for arm64 and x64 |
| Commands | Messages that start with `&`. Handled by the daemon before routing; never passed to the model. | Session manager |
| Daemon tools | Custom tools registered with `createSdkMcpServer`. They run in the daemon process, outside the container. | Rulebook, chat adapter |
| Chat adapter | One interface for all chat platforms. Discord is the default and the first built. | Platform bot credentials |
| Sweep | A throwaway session every 90 minutes that reports only what changed. | Recap, rulebook |
| `clots` CLI | `clots add`, secret entry, status. Runs on the PC and talks to the daemon. | Network path to the Pi |

## 3. Event pipeline

1. **Intake** receives the event and stamps the arrival time.
2. **Pre-filter**: deterministic rulebook rules drop events. Nothing is dropped
   unless a rule says so; there are no built-in drops (the user's own pull requests,
   for example, pass through).
3. **Routing**: match rules bind the event to a project (section 5). Unmatched
   events from shared sources are routed by triage in step 4. If triage is not
   confident, the event goes to the home Clot.
4. **Triage** returns: needs action (yes or no), project, a one-line message for
   the user, urgent (yes or no), suspicious (yes or no). Events that need no action
   stop here.
5. **Gates** deliver the event now or queue it (section 8).
6. The one-line message is posted in the Clot's live channel, for example "Sentry
   just reported a crash – investigating it now."
7. **Router** picks the effort level.
8. **Session manager** resumes the Clot's session, applies the effort level, and
   delivers the event wrapped and labelled as untrusted external data.
9. The Clot investigates read-only, using subagents for the digging, then proposes
   one or two options and waits.
10. After the user's go-ahead it works through to an open pull request
    (section 7).
11. After the turn the daemon posts a summary of what the turn changed and ran,
    reads context usage, and rolls the session over at 65% or more (section 6).

Entry points other than events:

- **User messages** enter at step 7. Triage does not run on them. A message that
  is a command (section 6) is handled by the daemon and goes no further.
- **The 90-minute tick** starts a sweep (section 9). It is skipped while the Clot
  is working. Sweep findings enter at step 2 as ordinary events.

Whenever several queued events are delivered together, each is shown with its
arrival time in the user's configured timezone.

## 4. Models and effort

| Role | Model | Effort |
|---|---|---|
| Clot main session | Opus 5.5 (`claude-opus-5-5`) | Chosen per prompt by the router |
| Triage | Sonnet 5.5 | Low |
| Router | Haiku 5.5 | Medium |
| Sweep | Sonnet 5.5 | Medium |
| Subagents | Chosen by the main session; default Sonnet 5.5 at medium | |

The effort level is re-evaluated on every prompt, whether it comes from the user or
from an event. It is applied with `applyFlagSettings({ effortLevel })`, which takes
effect on the next turn. The user can choose the level for one message with the
`&effort` command (section 6); the router still runs on that message to detect a
change of mode.

Router criteria:

- **Low**: simple tasks. A reported broken link where the first step is checking
  for a typo. Reading an inbound enquiry and drafting a reply.
- **Medium (default)**: most tasks, including long multi-step ones, as long as the
  user or the issue supplies most of the decisions. Building a page from supplied
  boilerplate, implementing a specified feature, fixing a well-described issue.
- **High (the maximum used)**: few tasks. Many open decisions, long-term planning,
  technical details to work out, more than 12 files touched. A request with many
  decisions starts at medium so the Clot can put the decisions to the user; it moves
  to high only when the user hands the decisions over ("your call").

The router sees the new prompt and the last few messages, because a reply such as
"yeah sure" can only be judged against what was proposed.

### Subagents

A message sent while the Clot is working is fed into the live turn through
streaming input. Three kinds of message wait for a turn of their own instead, so
that messages always take effect in the order the user sent them:

- one that changes the mode, because a turn's permissions are fixed when it starts;
- one sent after an earlier message that is itself still waiting;
- one that arrives after the turn has stopped accepting input.

The Clot handles a "meanwhile" request by starting a subagent:

- a fresh subagent by default;
- a fork carrying the conversation only when the request depends on it.

The main session chooses the subagent's model and effort itself. There is no
second router.

## 5. Routing and the rulebook

### Routing

- Each source is bound to one project at setup. Sources that belong to no project
  are bound to the home Clot.
- A shared source (one inbox or one Stripe account serving several projects) carries
  several bindings, each with a deterministic match condition: recipient alias,
  sender domain, subject keyword, product or price ID.
- Events that match nothing are routed by the triage call that already runs.
- When the user corrects a routing, the Clot proposes a new match rule.

### Rulebook

- Readable files under version control: one global, one per Clot.
- Contents: pre-filters, routing match rules, plain-language triage guidance,
  urgency markers, standing-rule templates, watch recipes.
- Edits the user asks for in chat are applied immediately and the resulting rule is
  shown.
- Edits the Clot suggests need the user's yes.
- Standing rules always need explicit confirmation, whoever raised them.
- All edits go through a daemon tool, so the Clot cannot change the rulebook from
  inside its container.

### Standing rules

A standing rule lets the Clot send a message without approval. It consists of an
exact template and a named trigger. A send is allowed only if at most 5 words
differ from the template. The `send_from_template` daemon tool fills the template
from fields of the triggering event, counts the changed words, and refuses anything
over the limit or outside the trigger.

## 6. Sessions, recap and chat layout

### Sessions

- A Clot's process runs only while it has a turn. Between turns it is stopped and
  the session is resumed by ID when the next prompt arrives.
- On each host, one heavy job (build, test run, browser) runs at a time. Light
  turns run alongside.
- A turn is over at the result that leaves nothing outstanding. The SDK's
  `queued_turn_count` says whether another result will follow; the bookkeeping
  messages the SDK sends after a result do not keep a turn open. A result marked as
  an error counts as a failed turn even when its subtype is success.
- After every turn the daemon calls `getContextUsage()`. At 65% or more it tells
  the user at once that the session is being closed, asks the session for a recap,
  starts a new session seeded with the recap, and runs a sweep so the new session
  re-grounds itself before continuing. The new session is saved, with its recap,
  before anything about it is announced, so a failed chat call or a restart
  mid-handoff loses nothing.
- The new session is told why it was started: the context limit, or the user's
  request.

The recap covers:

- what happened;
- what was done;
- what was declined, and the user's reason;
- proposals still awaiting an answer;
- work in progress, with branch names.

### Discord layout

- One server.
- One category per Clot.
- One channel per session, named `project-DDMM` (for example `graphite-1010`). A
  second rollover on the same day adds a suffix: `graphite-1010-2`.
- The recap is the first message of the new channel, so the user can read and
  correct what the new session knows.
- On rollover the old channel gets a closing link to the new one and becomes
  read-only. The Clot mentions the user in the new channel and keeps it at the top
  of the category.
- Read-only applies to the server's ordinary members. The bot keeps its own
  permission to post there. Discord ignores channel permissions for the server owner
  and administrators, so a message from them in a closed channel is answered with a
  pointer to the live one.
- While a turn runs, or a recap is being written, the Clot shows as typing.
- When a category approaches Discord's channel limit, the oldest session channels
  are deleted. Full transcripts remain on disk.
- No threads in the first version.
- Sweeps have no channel.

Slack has no categories, so the same structure becomes a channel-name prefix
(`clot-graphite-1010`).

### Turn summary

After each turn that changed a file or ran a command, the daemon posts one embed:

- each file changed, with the number of lines added and removed, colour-coded;
- the commands run, first line only.

It shows counts, not diff contents. File counts come from the Clot's edit and write
tools, so a file changed only by a shell command appears as that command. The
summary is posted by the daemon: it never enters the Clot's session or the router's
context.

### Commands

A message that starts with `&` followed by a word is a command. The daemon handles
it; it never reaches the model. A mistyped or unknown command gets a usage reply.

| Command | Effect |
|---|---|
| `&close` | The same handoff as a context rollover: recap, new session, new channel, old channel closed. The user and the new session are both told it was at the user's request. |
| `&close nosummary` | A new session and channel with nothing carried over: no recap, brainstorm mode off, the router's recent-message context cleared. On a new session that still holds an unused recap, it discards the recap in place. |
| `&effort low\|medium\|high <message>` | Sends the message at that effort level. |
| `&effort low\|medium\|high` | Sets the level for the next message only. It is spent on the next message delivered, and kept if that delivery is refused. |

A `&close` sent during a turn waits for the turn to end. On a session with no turns
yet and no recap, it does nothing.

### Brainstorm mode

- The router detects the user asking to start or stop brainstorming.
- While brainstorming, the daemon runs the session in plan mode and refuses every
  tool request that needs permission. The Clot can read code, browse and look
  things up; it cannot change anything.
- A mode instruction tells the Clot that brainstorm mode and plan mode are the same
  thing here, to stay in ideation, and not to close replies with offers to act. The
  user usually reads on a phone and cannot open files, so thinking and plans go in
  the reply; a plan file is written only when the user asks for one.
- The Clot asks questions as plain text. The interactive question tool cannot reach
  the chat, so it is disabled in every mode.
- The Clot posts a one-line marker when the mode changes.
- The mode ends when the user says to start working, or gives a direct instruction
  to create, make, build, implement, write down or do something, even at the end of
  a message that is otherwise discussion. A question or an idea about making
  something does not end it. It stays off until the user asks to brainstorm again.

## 7. Permissions and safety

### Approval scope

- Read-only investigation never needs permission.
- The user's go-ahead on a proposal covers editing, testing, committing to a branch
  and opening a pull request.
- Each of these needs its own explicit yes: merging to the main branch, deploying,
  spending money, deleting data.
- Anything addressed to a person is written as a draft and never sent, except
  through a standing rule.

### Enforcement

- **Identity**: each Clot has its own least-privilege credentials scoped to its
  project. On GitHub, a token that can push branches and open pull requests on the
  bound repository. Elsewhere, read-only keys unless a standing rule needs more.
- **Merges**: GitHub cannot tell a Clot from the user when the token belongs to the
  user's own account, and the permission that pushes a branch also merges a pull
  request. Blocking merges therefore needs the Clot to have its own GitHub account,
  added as a collaborator, and a branch rule that requires an approving review.
  GitHub enforces branch rules on private repositories only on paid plans. Without
  these, the Clot's instructions are the only gate on merging.
- **Authorship**: commits are authored as `<name>-clot`, with the no-reply address
  of the GitHub account that owns the Clot's token. Hosts such as Vercel refuse to
  build a commit whose email matches no GitHub account. Pull request descriptions
  end with "Created with a Clot." linked to the Clots repository, in place of
  Claude Code's own attribution line.
- **Sign-in**: each container is logged in to Claude once (section 10). Without that
  login the daemon falls back to a token from `claude setup-token`.
- **Isolation**: the Claude Code process and all its built-in tools run inside the
  container. Inside the container, tool calls are auto-approved; the container and
  the scoped credentials are the boundary.
- **Privileged actions** (sending from a template, editing the rulebook, posting to
  chat) exist only as daemon tools, outside the container.
- **Secrets** are entered through the `clots` CLI, never through chat.

### Untrusted input

- Triage and the router have no tools and return a fixed schema.
- Their system prompts instruct them to treat event content as data and to
  disregard instructions inside it.
- Event payloads are wrapped and labelled as untrusted when passed to the main
  session. The Clot's system prompt states that instructions come only from the
  user through chat.
- A suspected injection is flagged to the user. The Clot takes no action on it.

## 8. Gates

An event that needs action passes these checks in order.

1. **Usage limit reached**: queue. The Clot tells the user once, with the reset
   time. Work resumes when the limit resets.
2. **Brainstorm mode on**: triage also receives the last two user messages and the
   last two Clot messages, and judges whether the event is relevant to the
   discussion. Relevant events are delivered now. Others are queued silently and
   delivered as one batch when brainstorming ends. Exception: an event marked urgent
   still gets its one-line notice immediately, with no investigation.
3. **Scarce mode** (15:00–18:00, Monday to Friday by default, configurable per
   weekday): urgent events and the user's direct messages run normally. Other events
   get their one-line notice and are queued until the window ends. Sweeps are
   skipped.
4. **Lead-in** (10:00–15:00 on the same days): Clots are held to 50% of the
   five-hour usage window, configurable.
5. **Otherwise**: first come, first served.

When usage is running low, the order of priority is: urgent events, the user's
direct messages, ordinary events, sweeps. Several low-priority events for one Clot
are delivered as a single digest turn.

Usage is read from the SDK's rate-limit events (fraction used, reset time). The
daemon keeps a spend log per Clot and warns the user when a Clot's weekly spend
passes a configured threshold.

## 9. Intake

| Source | Mechanism | Target latency |
|---|---|---|
| Sentry, Stripe, GitHub, Vercel | Webhook | Seconds |
| Email | IMAP IDLE | Seconds |
| PostHog | Webhook destination, plus a poll | Seconds to 5 minutes |
| Google Calendar | Poll with a sync token | 1 to 5 minutes |
| Any other MCP connector | Watch recipe | 1 to 5 minutes |
| Connectors that exist only in the user's claude.ai account | Sweep | Up to 90 minutes |

- **Webhooks** reach the Pi through a tunnel: Cloudflare Tunnel on a subdomain of
  the user's domain if its DNS can be hosted on Cloudflare, otherwise Tailscale
  Funnel. Signatures are verified per source and duplicates are dropped by delivery
  ID.
- **Watch recipes**: the daemon acts as an MCP client. On a timer it calls one
  read-only tool on a connector and diffs the result against the previous result.
  No model is involved. A recipe names the tool, its arguments, the field that
  identifies an item, and the interval. When a new connector appears, the Clot
  inspects its tools and proposes a recipe for the user to approve.
- **Sweep**: every 90 minutes the daemon starts a fresh Sonnet 5.5 medium session
  with the current recap, the rulebook and a record of what was last seen. It checks
  the connectors and reports only changes. Its transcript is deleted once the
  findings are handed over. A quiet sweep posts nothing.

The mechanisms for individual sources are to be confirmed against current
documentation when stage 2 is specified. Vercel webhooks may require a paid plan.

## 10. The Clot's computer

In scope:

1. Browsing as the user: a browser with its own persistent profile and logins.
2. Testing its own work: running the project, clicking through changes, attaching
   screenshots or a recording to the pull request.
3. Isolation: the Clot cannot touch anything outside its container.

Each container holds its own clone of the repository. The user and the Clot do not
share a working directory; the Clot's work appears as branches and pull requests.

The browser is Chromium driven by Playwright. It starts on demand and stops when
idle. A web-based live view lets the user watch, and take over for logins, captchas
and two-factor prompts.

Each container is logged in to Claude once, with `claude /login` run inside it.
That login is what brings the account's connectors, such as Claude Docs, into the
Clot's sessions. A token from `claude setup-token` is enough to run sessions, but
it carries no connectors, and it overrides the container's login if both are
supplied; the daemon passes the token only when the container has no login.

The user's Claude setup is copied into the container. Skills and plugins are files
and copy directly: a skill folder placed in the container's `~/.claude/skills` is
picked up by the next session. A skill that drives a command-line tool also needs
that tool installed and signed in inside the container. MCP servers launched by
Windows-specific commands will not run in the Linux container.

Out of scope: driving native desktop applications.

## 11. Onboarding

A Clot is opt-in per project. `clots add`, run inside a project folder on the PC,
registers the repository with the daemon. The daemon clones it, builds the
container and creates the Discord category and first channel.

The new Clot then walks the user through a fixed checklist in its channel:
bindings for each source, webhook URLs to paste into each service, scoped
credentials, watch recipes, browser logins, the usage schedule.

Onboarding must leave the Clot fully set up. Each item is verified by a real test
(a test webhook received, a test email seen, a branch pushed and a pull request
opened with the Clot's own token, a login confirmed in its browser). The Clot does
not declare itself ready until every item passes. Checklist state is saved so
onboarding can be resumed.

## 12. Failure handling

- **Daemon crash or power loss**: systemd restarts the daemon. The queue and state
  are in SQLite with write-ahead logging. Sessions resume from disk.
- **Turn interrupted**: the session is resumed and told its last turn was cut off.
  A session interrupted during its very first turn already has a transcript, so it
  is resumed, not created again.
- **Paused at restart**: a usage-limit pause that expired while the daemon was down
  is resumed at startup like one that expires while it is running.
- **Limit during a handoff**: a usage limit hit while the recap is being written
  pauses the Clot like any other. A `&close` is retried after the reset; a context
  rollover is retried after the next turn.
- **Failing watch**: back off, then report to the user after repeated failures.
- **Chat platform unreachable**: outbound messages queue.
- **Usage limit**: section 8, gate 1.

## 13. Stack

- TypeScript on Node. TypeScript is required: live effort switching
  (`applyFlagSettings`) exists only in the TypeScript Agent SDK.
- `@anthropic-ai/claude-agent-sdk`.
- SQLite for the queue, events, bindings and spend log.
- Plain files in a git repository for the rulebook.
- discord.js for Discord, behind the chat adapter interface.
- An IMAP library with IDLE support.
- Docker; one image built for arm64 and x64.
- Playwright with Chromium.

## 14. Testing

- Unit tests for pure logic: pre-filters, routing, gates, the five-word check,
  schedules, channel naming.
- Source adapters tested against recorded real payloads.
- Model steps sit behind an interface. The pipeline is tested with fakes. A small
  labelled set of events scores the triage and router prompts whenever they change.
- End-to-end tests with a fake chat adapter and a fake source.
- On the Pi: a memory and build-time check with three Clots running.

## 15. Development environments

Development happens off the Pi. There are two possible environments.

### Local (the default)

The user's PC: Windows 11, 32 GB RAM, a 20-core 13th-generation Intel CPU, WSL2
with Ubuntu, and Docker Desktop. Capacity is not a concern.

Steps:

1. Remind the user to open Docker Desktop before any work starts, and confirm that
   `docker info` succeeds.
2. Build the Clot image for x64.
3. Run the daemon locally and start one Clot container through Docker Desktop.
4. Run the test suite and the end-to-end tests against that container.

### Claude Code cloud environment (only if the user says so)

The user may run a session in a Claude Code cloud environment. They will say so at
the start of that session. In that case, use the cloud environment in place of
WSL2.

Before any implementation work in a cloud session:

1. Measure the environment: CPU count, memory, free disk, and whether Docker (or
   another container runtime) is available and can start a container.
2. Compare against what one Clot needs in development: the daemon, one container
   running Claude Code, a project build, and Chromium.
3. If the environment falls short on any of these, stop and tell the user before
   starting work. The user will restart the session locally.

Every implementation plan must carry both sets of steps and begin with this check.

## 16. Stages

Each stage gets its own specification and plan.

1. **Runtime and Discord.**
2. **Intake, triage and rulebook.**
3. **Pi deployment and onboarding.**
4. **Browser and live view.**
5. **Slack adapter.**

### Stage 1 scope

In scope:

- the daemon process, running in a development environment;
- one Clot in a container, with Claude Code driven through the Agent SDK;
- stop-between-turns and resume by session ID;
- the Discord adapter with the category and `project-DDMM` channel layout, and a
  typing indicator while a turn runs;
- the router: effort level per prompt, and brainstorm detection;
- brainstorm mode: plan mode, mode instruction, marker;
- approval scope, enforced by the Clot's system prompt and a scoped GitHub token;
- commit authorship and the pull request attribution line;
- the turn summary;
- the `&close` and `&effort` commands;
- sign-in through the container's own Claude login, with the token as fallback;
- side subagents for messages sent during a turn;
- recap and rollover at 65%, including the new channel and read-only old channel;
- the usage-limit pause, driven by rate-limit events;
- crash-safe state in SQLite.

Out of scope for stage 1: event intake, triage, the rulebook, the gates other than
the usage-limit pause, the sweep (so rollover re-grounding is added in stage 2), the
browser, the `clots` CLI, running on the Pi, copying the user's Claude setup into
the container, a separate GitHub account for the Clot, pruning old channels. The
container login is done by hand in stage 1.

Stage 1 is done when, in a development environment:

- the user can message a Clot in Discord and get replies from a session running
  inside the container;
- a Bash call made by the Clot demonstrably runs inside the container;
- the same session continues after the daemon is restarted;
- the effort level changes between prompts according to the router;
- brainstorm mode blocks changes and lifts on the user's go-ahead or direct
  instruction;
- a session forced past 65% produces a recap, a new session, a new channel and a
  read-only old channel;
- a message sent mid-turn results in a side subagent without derailing the turn;
- each turn that changed or ran something is followed by its summary;
- `&close`, `&close nosummary` and `&effort` behave as section 6 describes;
- with the container logged in, the Clot can create a Claude Doc.

### Assumptions to verify at the start of stage 1

- `spawnClaudeCodeProcess` can run the Claude Code process inside a container while
  daemon tools stay in the daemon process.
- A token from `claude setup-token` is enough to run a session in the container
  without an interactive login. (Connectors need the one-time container login.)
- A message pushed during a turn is accepted, and the turn can still be told apart
  from the next one: by `queued_turn_count` on the result, and by ignoring the
  bookkeeping messages that follow a result.
- Closing a turn's input while the turn is running lets the turn finish.
- Resuming a session after its process was stopped preserves the ability to apply
  effort and mode changes.

If any of these fails, stop and bring the finding to the user before continuing.

## 17. Not in the first stable release

- Native desktop applications.
- Voice.
- A web dashboard.
- iMessage: it needs a Mac to relay, and the Pi cannot do it. The chat adapter
  interface leaves room for it.
- Waking the PC over the network: unnecessary now that the Pi hosts the Clots.

## 18. Known risks

- How far a Pro plan's allowance stretches across four Clots is unmeasured. Usage
  is shared with the user's own Claude Code sessions.
- microSD speed and wear under container workloads. An NVMe or USB SSD is the
  planned upgrade.
- Chromium's memory use on an 8 GB Pi.
- Until a Clot has its own GitHub account, nothing on GitHub's side stops it from
  merging; and on a free plan, branch rules on a private repository are not enforced
  at all.
- Agent SDK billing terms changed three times in 2026. As of 2026-10-07, SDK usage
  draws from subscription limits.
