# Clots: design

Date: 2026-10-10
Status: approved in brainstorming. Stages 1, 2a, 2b and 2c (but for Sentry, Vercel
and PostHog), global memory, and the main session and workers (section 4) are
implemented. Autonomy (sections 3 and 7) is the next part, before 2d.

## 1. What Clots is

Clots are always-on agents built on Claude Code, in the spirit of OpenAI's dots and
Grok Bot. Each opted-in project gets one Clot, and an optional "home" Clot takes
what belongs to no project. A Clot:

- is triggered by events from connected services, by the user's chat messages, and
  by a 90-minute clock;
- has one main session that the user talks to and that receives every event. The
  main session never changes anything itself: it triages, investigates under a
  lock, and hands the work to worker sessions, each on its own branch, which carry
  it through to an open pull request;
- acts without asking on whatever is low on all four axes (reversibility,
  visibility, price, committing the user), and asks only for what is high on any
  of them (section 7). When it offers the user a choice and gets no reply within 10
  minutes, it goes with its own pick, as long as that pick is low;
- has its own isolated computer (a container with a repo clone and a browser);
- keeps the main session long, rolled over into a fresh session with a written
  recap when context reaches 65% or when the user closes it;
- keeps its own memory across sessions, and shares the global memories the home
  Clot writes;
- is text only. Voice is out of scope.

The aim is that the user can be busy elsewhere and seldom has to look at the phone
to see whether a Clot is waiting.

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
| Intake | Receive webhooks, hold IMAP IDLE connections, poll calendar feeds, run watch and webhook recipes, fire the 90-minute tick. Verify each delivery, drop repeats, store the event and answer the source at once. Normalise everything into one event format (section 3). | Tunnel, source credentials |
| Rulebook | A folder and git repository of its own, one file for every Clot and one per Clot: pre-filters, routing match rules, triage guidance, urgency markers, standing-rule templates, watch recipes. | None |
| Hold | Keeps automated events (CI runs, anything from a bot account) back for a minute or two and gathers those about the same pull request or branch into one event. | A timer |
| Routing call | Haiku 5.5, medium effort, no tools, fixed output schema. Picks the Clot for an event from a shared source that no routing rule matched. | Each Clot's one-line description |
| MCP client | Connects the daemon to MCP servers of its own, logging in through OAuth where a server needs it, for watch recipes. | Tunnel |
| Triage | Haiku 5.5 (`claude-haiku-5-5`), medium effort, no tools, fixed output schema. | Rulebook |
| Lock | Decides what the main session may do: read, look things up, run a fixed list of read-only commands, and call daemon tools. Asked before every tool call. | None |
| Worker guard | Decides what a worker may do outside its worktree: refuses every shell command that reaches a person or the default branch. Asked before every shell command. | None |
| Gates | Decide whether an event is delivered now or queued, and whether a worker starts now or waits. | Usage events, schedule |
| Router | Haiku 5.5, medium effort, no tools. Picks low or medium effort for each prompt to the main session. | Recent messages |
| Session manager | Start a Clot's process for a turn, resume its session, apply effort, stop the process afterwards. Enforce one heavy job at a time per host. | Agent SDK, Docker |
| Workers | Start a worker session in a new worktree when the main session asks, queue it while the host's limit is reached, pass messages between it and the main session, post its progress lines, remove its worktree when its pull request is merged or closed. | Session manager |
| Axes | A fixed rating, in code, of every daemon tool on the four axes. An action high on any axis becomes an ask. | None |
| Asks | One component for every question put to the user in a temporary channel: standing rules, emails to send, merges and choices. Each kind has its handler; all share the channel, reply matching, closing exactly once, withdrawal and the pinned list in `clots-waiting`. | Chat adapter, axes |
| Clot container | The Clot's computer: repo clone, Chromium with a persistent profile, live view, scoped credentials, its own Claude login, a copy of the user's Claude setup. | Image for arm64 and x64 |
| Commands | Messages that start with `&`. Handled by the daemon before routing; never passed to the model. | Session manager |
| Daemon tools | Custom tools registered with `createSdkMcpServer`. They run in the daemon process, outside the container, and are made for each turn, so each call knows what kind of turn it is in. | Rulebook, chat adapter |
| Global memory | Notices the global memories the home Clot writes, posts each, and copies them into every Clot's memory before its turns. | Chat adapter, Docker |
| Chat adapter | One interface for all chat platforms. Discord is the default and the first built. | Platform bot credentials |
| Sweep | A throwaway session every 90 minutes that reports only what changed. | Recap, rulebook |
| `clots` CLI | `clots add`, secret entry, status. Runs on the PC and talks to the daemon. | Network path to the Pi |

## 3. Event pipeline

1. **Intake** verifies the delivery, drops a repeat, stores the event, stamps the
   arrival time and answers the source. Everything after this happens once the
   source has its answer, so an event that was acknowledged is never lost.
2. **Self-caused drop**: an event the Clots' own account caused is dropped: the
   Clot's own pull requests, comments and reviews. A failed CI run is never
   dropped this way, although the account that pushed is named as its actor. This
   is the only built-in drop.
3. **Pre-filter**: deterministic rulebook rules drop events. Nothing else is
   dropped without a rule (the user's own pull requests, for example, pass
   through).
4. **Routing**: a source bound to a project sends its events there; routing rules
   bind an event from a shared source to a project (section 5). An event no rule
   matches goes to the routing call. If it is not confident, the event goes to the
   home Clot.
5. **Hold**: an automated event waits a short while and is gathered with others
   about the same subject ("Automated events" below). Events written by people
   skip this step.
6. **Enrichment**: what the source left out of the delivery and the Clot will
   need is fetched and added to the event. For GitHub that is a review's inline
   comments, with file, line and the code commented on; for Stripe the customer
   and the products; for Linear the issue and its comments; for Notion the page
   and the comment, since Notion's events only say that something changed.
7. **Triage** returns: needs action (yes or no), a one-line message for
   the user, urgent (yes or no) and suspicious (yes or no). A suspicious event is
   reported to the user and goes no further; this is checked first. Events that
   need no action stop here, silently. If the triage call fails, the event is
   delivered.
8. **Gates** deliver the event now or queue it (section 8).
9. **Queue**: the one-line message is posted in the Clot's live channel, for
   example "Sentry just reported a crash – investigating it now.", and the event
   joins the main session's queue. Events, the user's messages and the workers'
   reports share one queue and are handled in arrival order.
10. **Router** picks low or medium effort.
11. **Session manager** resumes the main session, applies the effort level, and
    delivers the event as a turn of its own, wrapped and labelled as untrusted
    external data.
12. The main session investigates under the lock (section 7) and decides: nothing
    to do, a reply, a choice for the user (section 7), or work. Work that is low
    on every axis goes straight to a worker (section 4). An event about work a
    worker already has, such as a review comment or a failed CI run on its pull
    request, is passed on to that worker.
13. The worker carries the work through to an open pull request and reports. Its
    report is a turn for the main session, which tells the user in a line or two.
    What the user writes on the source itself, such as a comment on GitHub, is an
    event like any other: instructions come only through chat.
14. After each turn the daemon posts a summary of what the turn changed and ran,
    reads the main session's context usage, and rolls it over at 65% or more
    (section 6).

Entry points other than events:

- **User messages** enter at step 10. Triage does not run on them. A message that
  is a command (section 6) is handled by the daemon and goes no further. A message
  sent while the main session is in a turn is fed into that turn.
- **The 90-minute tick** starts a sweep (section 9). It is skipped while the main
  session is in a turn. Sweep findings enter at step 3 as ordinary events.

Whenever several queued events are delivered together, each is shown with its
arrival time in the user's configured timezone.

### The common event

Every source is turned into the same shape before anything else looks at it:

| Field | Meaning |
|---|---|
| `id` | The source's delivery ID. Unique; used to drop repeats. |
| `source` | Where it came from: a built-in source, or a recipe |
| `account` | Which configured account of the source |
| `kind` | What happened. For GitHub: an issue opened, a comment, a review, a pull request opened, a failed CI run. Sources share a kind where it means the same thing. |
| `place` | Where at the source: a repository, a Linear team, the address mail was sent to |
| `actor` | Who caused it |
| `title` | One line: what happened |
| `body` | The relevant text, trimmed to a fixed length |
| `url` | A link to the thing at the source |
| `ref` | The issue or pull request number, or the branch for a CI run |
| `subject` | What the event is about: a pull request, an issue or a branch |
| `automated` | Whether a machine produced it |
| `receivedAt` | When the daemon received it |

One more kind, `batch`, is never produced by a source: the daemon makes it from
several automated events about one subject.

### Automated events

One push often sets off several automated reports within a minute: a failed CI
run, the same failure reported again for the pull request, a comment from each
deploy service. Investigated one by one they would produce the same findings
several times over.

- Automated events are held, grouped by Clot, place and subject. A group is released 60
  seconds after its last event and at most 120 seconds after its first; both are
  configurable.
- Within a group the same CI failure counts once. If one event is left it goes on
  unchanged; several become one `batch` event that lists them.
- From there a batch is an event like any other: one triage call, one notice, one
  question or one investigation.
- Held events are stored. After a restart their wait is over and each group is
  released at once. Storing a batch and marking what it was made from is one
  database transaction.

## 4. Main session, workers, models and effort

### Models and effort

| Role | Model | Effort |
|---|---|---|
| Clot main session | Opus 5.5 (`claude-opus-5-5`) | Low or medium, chosen per prompt by the router |
| Workers | Chosen by the main session (below); Sonnet 5.5 (`claude-sonnet-5-5`) at high by default | |
| Triage | Haiku 5.5 | Medium |
| Routing call (shared sources) | Haiku 5.5 | Medium |
| Router | Haiku 5.5 | Medium |
| Sweep | Opus 5.5 | Low |

The main session's effort level is re-evaluated on every prompt, whether it comes
from the user, an event or a worker. It is applied with
`applyFlagSettings({ effortLevel })`, which takes effect on the next turn. The user
can choose the level for one message with the `&effort` command (section 6).

Router criteria:

- **Low (default)**: replying, deciding what to do with an event, writing a
  worker's brief, reading a worker's report.
- **Medium**: investigating an event, and a question from the user that needs
  digging into code or services.

The main session never runs at high. Work that needs more than medium is a
worker's.

The router sees the new prompt and the last few messages, because a reply such as
"yeah sure" can only be judged against what was proposed.

The sweep reports only what changed, but it decides what counts as a change, so
it runs on a model whose findings the main session takes without checking.

### Main session

Each Clot has one main session. It receives every event, every chat message and
every worker's report, and it is always under the lock (section 7): it reads,
searches, browses, runs the read-only commands and calls daemon tools, and never
edits a file, commits or pushes. It changes things only through workers and the
daemon's tools.

It starts work from chat only when the user asks for something to be done, never
from the user thinking aloud. A conversation about an idea is ordinary chat.

### Workers

A worker is a Claude Code session the daemon starts at the main session's request.
The Clot runs in a container through the Agent SDK, with no other host around it,
so the daemon is the host: it is what starts, resumes and stops the sessions.

The main session's daemon tools:

| Tool | Effect |
|---|---|
| `start_session(title, brief, model, effort)` | Starts a worker. Low on every axis, so it starts at once. |
| `message_worker(id, text)` | Sends a follow-up, a correction or an answer into a worker's session. |
| `stop_worker(id)` | Stops a worker. Its branch and pull request stay. |

- **Worktree**: the daemon creates a git worktree on a new branch from the default
  branch, inside the Clot's container, and starts the worker's session there with
  the worker's own system prompt: the worker guard (section 7), commit authorship
  and the pull request attribution line, and the report it ends with.
- **Choosing the model**. The main session picks, by these rules, which are in its
  instructions:

  | Work | Model and effort |
  |---|---|
  | Most work | Sonnet 5.5 high |
  | Complex coding, 7 files or fewer estimated | Opus 5.5 medium |
  | More than 7 files estimated, or more than 3 decisions to make | Opus 5.5 high |
  | High has missed after a few rounds of feedback | Opus 5.5 xhigh, sparingly |
  | A known edit with no planning ("rename X to Y in these files") | Haiku 5.5 low or medium |

  Haiku is never run at high: work that would need it goes to Sonnet 5.5 high.
- **Trust**: Sonnet 5.5 high is reliable, and its work is not redone or checked in
  a scratchpad. The main session reads the report and the summary of changes, and
  reopens the work only when a check failed or the report does not add up.
- **Overlap**: a task that touches the same area as a running worker goes to that
  worker as a follow-up, not to a second one. The main session knows each worker's
  area from the brief it wrote. When two pull requests conflict anyway, the worker
  whose pull request is still open rebases it once the other has merged.
- **Asking**: a worker that is stuck calls `ask_main(question)`, which ends its
  turn. The main session answers with `message_worker`, or turns the question into
  a choice for the user (section 7).
- **Report**: a worker ends with what changed, the checks it ran and their
  results, the pull request's link and anything it is unsure of. The report is
  queued as a turn for the main session, which tells the user in a line or two.
  That turn carries none of the user's authority: the daemon's tools treat it as
  they treat an event's turn, because a report can quote outside text.
- **Later events**: a review comment or a failed CI run on a worker's pull request
  is triaged in the main session and passed to the same worker. A commit that
  answers a review is low; a reply comment on GitHub is high.
- **Lifetime**: a worker's session can be resumed until its pull request is merged
  or closed. Then the daemon removes the worktree; the transcript stays on disk.
  The daemon learns of the pull request from GitHub (its webhook, and an hourly
  check with `gh`, since a missed delivery is not sent again), never from the
  worker's text, and ignores a pull request from a fork. A home Clot worker's
  report link only tells the hourly check which repository to ask, and GitHub's
  answer decides. The usage limit's reset is kept across a restart, and every
  worker that was waiting is queued again. A worker idle for 7 days
  with no open pull request is closed the same way. A Clot has at most 20 workers
  listed at once.
- **The main session's clone** is brought up to date with the default branch
  before each of its turns, by the daemon: the main session cannot pull, and would
  otherwise investigate old code. Uncommitted changes found there are stashed
  first, never discarded.
- **Progress**: the worker posts nothing itself. The daemon posts in the Clot's
  live channel when a worker starts (title, model and effort), every 20 minutes
  with its latest step (a tool's name, or a command's program and, for a few
  known programs, its subcommand, never its arguments), and when it ends, followed by the turn summary.
- **Limit**: 3 workers run at once per host, across all its Clots, or the number in
  `CLOTS_MAX_WORKERS`. Others wait, urgent first, then in the order they were
  started. One heavy job at a time per host still holds.
- **Time limit**: a worker's turn is stopped after 90 minutes and reported to the
  main session like a failure, so a stuck worker never keeps its place.
- **Workers start no workers.** A worker may use subagents for searching.
- **Failure**: a worker cut off by a restart is resumed and told so. The usage
  limit pauses every worker. A worker whose session fails is reported to the main
  session, which may start the work again on a stronger model by the rules above.

## 5. Routing and the rulebook

### Routing

- Each account of a source is set up either bound to one Clot or shared. A GitHub
  repository is bound to the Clot whose `repoUrl` names it; an event from a
  repository no Clot is bound to goes to the home Clot, and is discarded when
  there is none.
- A shared account (one inbox, one calendar, one Linear workspace serving several
  projects) is routed by routing rules in `global.yaml`, each a deterministic
  match on source, account, place (an email alias, a Linear team), actor or a
  word in the title. Email aliases are routing rules, any number per account.
- Events that match no rule go to the routing call, which sees each Clot's
  one-line description. When it is not confident they go to the home Clot.
- When the user says an event belongs to another Clot, the Clot hands it over
  with a daemon tool, and adds a routing rule when there is a pattern.

### Rulebook

- Readable files in a folder and git repository of their own, apart from the
  Clots code: `global.yaml` for every Clot and `<clot>.yaml` for one. The daemon
  creates the folder and its starter files when they are missing.
- Contents: pre-filters, routing rules (in `global.yaml` only), triage guidance as
  a list of plain-language lines, urgency markers, standing rules, watch recipes
  and webhook recipes. A pre-filter drops an event when every field it names
  matches: source, account, kind, place (such as a repository), actor, and text
  the title contains.
- The daemon reloads a file when it changes. A file that cannot be read or does
  not fit the schema is ignored: its last good version stays in force and the user
  is told once.
- All edits from chat go through daemon tools, so the Clot cannot change the
  rulebook from inside its container. The files can still be edited by hand.

### Editing the rulebook from chat

The daemon decides whether an edit is applied or put to the user, by the axes
(section 7). The Clot cannot choose.

- **Applied at once:** pre-filters, triage lines, urgency markers and routing
  rules, in the Clot's own file or in `global.yaml`, whoever raised them, in any
  kind of turn, and watch and webhook recipes. Each is reversible with
  `&rules undo` and seen only by the user. The exception is a turn started by an
  outsider's event (section 7): there every rulebook edit is an ask, so a
  stranger's text cannot silence the alerts the user relies on. The daemon posts the resulting rule in the Clot's live channel with a
  reminder of `&rules undo`. After a pre-filter is applied, the daemon also posts
  the first event it drops, so a filter that hides too much is seen without being
  looked for.
- **An ask, needing the user's yes:** any standing rule added, replaced or
  removed, because a standing rule lets the Clot send to other people. The ask is
  answered like every ask (section 7), in a temporary channel (`<clot>-rule`) that
  shows the exact edit. The reply never reaches the model.
- **What the Clot learns:** the tool returns at once and the Clot does not wait.
  The outcome of an ask is posted in its live channel and placed as a note in
  front of the main session's next turn. A note starts no turn.
- **Limits:** an ask about a rule stays open until the user answers it, across
  rollovers: the rule does not depend on the session. A Clot may have three open,
  or the number in `CLOTS_MAX_PROPOSALS`.
- **When a Clot adds a rule unasked:** only on a clear pattern (the same kind of
  event dismissed more than once, or a stated standing preference), with the
  reason in one line, and never again once undone.
- **History:** every applied edit is checked against the schema, written so that
  comments and hand-written parts survive, committed in the rulebook's
  repository, and logged with the edit that undoes it (`&rules undo`, section 6).

### Standing rules

A standing rule lets the Clot send a message without approval. It consists of a
named trigger, an exact template and a way of sending.

- **Trigger:** matched like a pre-filter; it must name a kind of event.
- **Template:** exact text, with fields filled from the triggering event: who
  caused it, its title, its reference, its repository and its link.
- **Way of sending** (`via`): how the message leaves, which also fixes where it
  goes. The Clot never names a destination. For GitHub it is a comment on the
  issue or pull request the event is about; for email, a reply to the sender in
  the thread, from the address the mail came to; for Linear and Notion, a comment
  on the issue or page. Stripe and the calendar have none.
- **Who sends:** the Clot, with the `send_from_template` daemon tool, in the
  turn that investigates the event. The rules that apply are named in that turn's
  prompt, and the Clot may leave one unsent. A batch triggers a rule when any
  report in it matches.
- **What the daemon enforces:** the turn is the investigation of an event the
  rule's trigger matches; the rule has not been sent for that event before; and
  at most 5 words differ from the filled-in template, counting each word added,
  removed or replaced. Filled-in values never count.
- **Mentions:** an `@` notifies someone only where the template itself wrote it,
  never from a filled-in value or a word the Clot changed.
- Adding, replacing or removing a standing rule always needs the user's yes,
  whoever raised it.

## 6. Sessions, recap and chat layout

### Sessions

- A session's process runs only while it has a turn, for the main session and for
  each worker alike. Between turns it is stopped and the session is resumed by ID
  when the next prompt arrives.
- On each host, one heavy job (build, test run, browser) runs at a time. Light
  turns run alongside.
- A turn is over at the result that leaves nothing outstanding. The SDK's
  `queued_turn_count` says whether another result will follow; the bookkeeping
  messages the SDK sends after a result do not keep a turn open. A result marked as
  an error counts as a failed turn even when its subtype is success.
- After every main session turn the daemon calls `getContextUsage()`. At 65% or
  more it tells the user at once that the session is being closed, asks the session for a recap,
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
- asks and choices still awaiting an answer;
- workers running or waiting to be resumed, each with its brief in a line, its
  branch and its pull request.

Workers are not rolled over: each ends with its pull request.

### Memory

Each Clot keeps Claude Code's own auto memory in its container: one file per
memory and a `MEMORY.md` index, written by the Clot and read by every session,
including one that is resumed.

Global memories apply to every Clot, as `global.yaml` does for rules. The full
design is in `.superpowers/specs/2026-10-14-clots-global-memory-design.md`.

- **Only the home Clot writes them**, as files named `global-clot-…` in its own
  memory folder: when the user asks, or on its own for what clearly applies to all
  of the user's work. Project Clots cannot suggest one.
- **Applied at once:** a global memory is seen only by the user's Clots and is
  reversible with `&memory undo`, so it needs no yes. The exception is a memory
  written in a home Clot turn that an outsider's text started: every Clot would
  trust it from then on, so it is put to the user as an ask first. The daemon notices a new,
  changed or deleted file after each home Clot turn, applies it, and posts it in
  the home Clot's live channel with a reminder of `&memory undo`.
- **Delivery:** before each turn, the daemon copies the global files into the
  Clot's memory folder, removes any other `global-clot-` file, and keeps a block of
  index lines at the top of its `MEMORY.md`. Each change also leaves the Clot a
  note.
- **Clots are told** not to edit or remove global memories or the daemon's block.
  This is an instruction only; the next sync undoes any change.

### Discord layout

- One server.
- One channel at the top of the server, `clots-waiting`, holding one pinned
  message the daemon keeps current: every ask and every open choice from every
  Clot, each with its Clot, a line on what it is and a link to where it is
  answered; an open choice also shows the time it will be decided without the
  user. The message is edited only when the list changes, and it pings no one: the
  ask or choice itself mentions the user once. One look at it shows whether
  anything is waiting.
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
- While a main session turn runs, or a recap is being written, the Clot shows as
  typing. Workers show only through their progress lines (section 4).
- A post pings only the users the daemon mentions itself. Posts carry text from
  emails, issues and other outsiders, whose `@everyone` or `<@id>` stays text.
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
| `&close nosummary` | A new session and channel with nothing carried over: no recap, the router's recent-message context cleared. Running workers carry on and report to the new session. On a new session that still holds an unused recap, it discards the recap in place. |
| `&effort low\|medium <message>` | Sends the message to the main session at that effort level. |
| `&effort low\|medium` | Sets the level for the next message only. It is spent on the next message delivered, and kept if that delivery is refused. |
| `&rules` | Lists the rules in force for this Clot, each with its file, and its open asks. Answered at once, also during a turn. |
| `&rules undo` | Reverts the most recent rulebook edit made from chat through this Clot and shows what it reverted. Sent again, it steps one edit further back. It needs no further yes. |
| `&memory` | Lists the global memories in force. Works in every Clot's channel, also during a turn. |
| `&memory undo` | Reverts the most recent global memory change: an addition, a change or a deletion. Sent again, it steps one further back. |
| `&calendar undo` | Reverses this Clot's most recent calendar change: removes an event it added, puts back what it changed, or recreates one it removed from the copy the daemon kept. Sent again, it steps one further back. |

A `&close` sent during a turn waits for the turn to end. On a session with no turns
yet and no recap, it does nothing.

The user usually reads on a phone and cannot open files, so thinking and plans go
in the reply. The Clot asks questions as plain text, or as a choice (section 7);
the interactive question tool cannot reach the chat, so it is disabled.

## 7. Permissions and safety

### The four axes

Every action is rated on four axes. A Clot does whatever is low on all four without
asking, and asks only for what is high on any one.

| Axis | Low | High |
|---|---|---|
| Reversibility | Undoing it is free, such as a calendar event entered ahead of a client's confirmation | Hard to undo: a text message sent, a payment to a shop that gives no refunds |
| Visibility | Only the user sees it | It reaches another person, who may see it before it could be taken back |
| Price | Less than $5 at stake | $5 or more at stake |
| Committing the user | Nothing | Terms accepted or promises made in the user's name |

- **The daemon rates, not the model.** Every daemon tool declares its rating on
  the four axes in code. A call that is high on any axis is never carried out
  directly: it becomes an ask. The model cannot argue an action down.
- **Who started the turn does not matter.** A low action runs in every kind of
  main session turn: one the user's message started, an event's, or a worker's
  report. So a client's email can get a tentative event in the user's calendar
  with no question asked. The one exception is a rulebook edit in a turn started
  by an outsider's event, which is an ask (section 5).
- **The Clot knows the axes too.** The main prompt carries a short version: do
  without asking whatever is free to undo, seen only by the user, under $5 and
  commits them to nothing; anything else the daemon puts to the user; prepare
  everything up to that step, then wait. This is guidance; the ratings enforce it.
- **Low, done without asking:**
  - investigating, under the lock;
  - starting, messaging and stopping workers;
  - in a worker: editing, testing, committing, pushing its own branch, opening a
    pull request, pushing further commits to it, rebasing it, and closing it;
  - drafts, including an email draft saved in the user's own Drafts folder;
  - sending under a standing rule the user approved;
  - rulebook edits other than standing rules, and recipes (section 5), and global
    memories (section 6), each posted with its undo;
  - in the user's calendar, adding events, moving or changing them, and removing
    them, never one with guests. A repeating event is never removed, and its
    series is changed only in a turn the user's message started. In a turn an
    outsider's text started, the Clot may only add events, at most 3 a day per
    Clot, and change or remove only events a Clot added. Every add, change and
    removal is logged with what it replaced and posted, and `&calendar undo`
    reverses the most recent one.
- **High, an ask:**
  - adding, replacing or removing a standing rule;
  - sending an email, through send review: the daemon shows the email and sends it
    only on the user's yes. A daemon-wide switch turns send review off, leaving
    drafts and standing rules;
  - a comment, review or reply that reaches a person on any source;
  - merging to the default branch, and deploying. A Clot commits straight to the
    default branch only when the user asks for it in chat, which is then the ask's
    answer. A pull request is merged with the daemon tool
    `merge_pull_request(number)`, which only the main session has. It may call it
    on its own, for example to suggest shipping a pull request once the user has
    checked it; the daemon then opens the ask, showing the pull request's title,
    link, checks and head commit, and on the user's yes there squash-merges it
    under the Clots' account. A refusal from GitHub, such as a branch rule, is
    posted as it came. The tool refuses a pull request that is not on one of the
    Clot's own `clot/` branches or is a draft;
  - anything that spends $5 or more, and anything that accepts terms or makes a
    promise in the user's name.

### Asks

One component puts every question to the user. Each ask has a kind, and the kind
decides its channel, what an exact reply does, what any other reply does, and when
it is withdrawn:

| Kind | Channel | Exact yes | Exact no | Any other reply | Withdrawn when |
|---|---|---|---|---|---|
| Rule change (a standing rule, or any edit from an outsider's turn) | `<clot>-rule` | applies it | declines it | repeats the question | never |
| Email to send | `<clot>-mail` | sends it | drops it; `draft` saves it as a draft instead | goes to the main session as the user's feedback, and the review closes | its review window passes |
| Merge | `<clot>-ask` | merges | declines | goes to the main session as the user's feedback, and the ask closes | the pull request gets a new commit, or closes |
| Choice | `<clot>-choice` | `1`, `2`, `one`, `two`, `first` or `second` decide it; `your pick` or `go ahead` take the Clot's pick | none | goes to the main session as a turn of the user's own, with the choice attached, and the choice closes | never: the timeout decides it |

What every ask shares:

- The daemon opens the channel in the Clot's category, mentions the user once and
  shows exactly what would be done. The ask is listed in `clots-waiting`
  (section 6).
- A reply is matched exactly, after lowercasing and removing punctuation. A yes is
  `yes`, `sure`, `do that` or `yeah`; a no is `no`, `dont` or `not at all`. An
  exact reply never reaches the model.
- The tool returns at once and the Clot does not wait. The outcome is posted in
  the live channel and placed as a note in front of the main session's next turn.
  The channel is deleted when the answer has been carried out, and the ask leaves
  `clots-waiting`.
- An ask is closed exactly once, whichever comes first: the reply, the timeout, or
  the withdrawal.
- **Silence never approves an ask.** An ask is withdrawn when what it would act on
  changes, so a yes always means what the user saw. A withdrawn ask leaves
  `clots-waiting`, its channel is deleted, and the main session gets a note, so it
  can ask again if that still makes sense.
- Open asks survive a restart. One whose channel is gone is closed as withdrawn.

### Choices

When there are meaningfully different ways to do something, the main session puts
two options to the user with the daemon tool `ask_choice(question, options, pick)`,
naming its own pick.

- The daemon opens a choice ask, which lists the deadline in `clots-waiting`. The
  main session's turn ends, so it stays free for other events.
- **No reply within 10 minutes** (or `CLOTS_CHOICE_TIMEOUT_MINUTES`): the daemon
  starts a turn telling the main session the user appears to be busy, and to go
  with its pick. The Clot posts which option it took and that a reply switches it.
- **The daemon rates no option.** An option is a sentence the model wrote, so
  there is nothing to rate. The axes hold at each tool call instead: when the pick
  leads to a high step, such as sending an email or merging, that call becomes an
  ask, and the Clot has done everything up to it.
- That timeout turn carries none of the user's authority, as a worker's report
  does not.
- **A late answer for the other option**, in the live channel, is an ordinary
  message: the main session redirects or replaces the worker, and closes the pull
  request made for the first option.
- After a restart, a choice whose deadline has passed is decided by the timeout
  at once.

### Enforcement

- **Identity**: the Clots act under credentials of their own, never the user's.
  On GitHub, one machine account serves all of a user's Clots. It is invited as a
  collaborator to each bound repository and holds a classic token with the `repo`
  scope, which reaches exactly the repositories it was invited to. (A fine-grained
  token cannot reach a repository its account is only a collaborator on.)
  On Linear the Clots have a member of their own, as on GitHub. Elsewhere,
  read-only keys unless a standing rule needs more. The one exception is email:
  the daemon reads the user's own mailboxes, and sends as the user only text the
  user approved word for word: a standing `email_reply`, from the address the
  mail came to, or an email the user approved in its review channel.
- **Knowing its own work**: the daemon reads the account's login from the token
  at startup. That is how an event the Clot caused itself is recognised (section
  3).
- **Merges**: the permission that pushes a branch also merges a pull request.
  Because the Clots have their own account, a branch rule that requires an
  approving review blocks them from merging. GitHub enforces branch rules on
  private repositories only on paid plans. Without such a rule, the worker guard
  is the gate on merging.
- **Authorship**: commits are authored as `<name>-clot`, with the no-reply address
  of the GitHub account that owns the Clot's token. Hosts such as Vercel refuse to
  build a commit whose email matches no GitHub account. Pull request descriptions
  end with "Created with a Clot." linked to the Clots repository, in place of
  Claude Code's own attribution line.
- **Sign-in**: each container is logged in to Claude once (section 10). Without that
  login the daemon falls back to a token from `claude setup-token`.
- **Isolation**: every Claude Code process and all its built-in tools run inside the
  container. The main session runs under the lock, which decides every call. A
  worker's calls inside its worktree are approved; the worker guard decides every
  shell command that could reach outside it.
- **Privileged actions** (sending from a template, editing the rulebook, posting to
  chat, saving an email draft, asking to send an email, changing the calendar,
  handing an event to another Clot, starting and messaging workers, asking a
  choice) exist only as daemon tools, outside the container, each with its rating
  on the axes. They are the main session's; a worker has only `ask_main`.

### The worker guard

A hook is asked before every shell command a worker runs, ahead of Claude Code's
own permission rules, and nothing can pre-approve a call past it. It refuses:

- `gh` commands that comment, review, merge, close or reopen an issue, release, or
  change a repository's settings; a worker's own pull request is the exception:
  creating it, editing its description, and closing it;
- every `git push` except to the worker's own branch, named explicitly; a forced
  push other than `--force-with-lease`; pushing a tag; and changing git's
  configuration or remotes;
- commands that send mail or messages.

A command it must read closely has to be written plainly: a wrapper such as `env`
or `sudo` with options of its own, or a pull request named on `gh pr edit` or
`gh pr close`, wherever it stands among the flags, is refused.

It also refuses every MCP tool other than the worker's own `ask_main`, since a
connector brought in by the container's login could send unchecked.

A refusal tells the worker why and that the action belongs to the main session.
The guard's lists, and the ways of hiding a command it refuses, are tested against
a table of commands that must pass and a table that must be refused, as the lock
is. What the guard cannot see, such as a `curl` to an address of the worker's
choosing, rests on the worker's instructions (section 18).
- **Secrets** are entered through the `clots` CLI, never through chat.

### The lock

The main session is always locked: it cannot change anything inside the
container. Editing, committing and pushing are workers' work; sending goes through
daemon tools and the axes. The main session reads untrusted text all day (emails,
issues, webhooks), so keeping it unable to change anything limits what an
instruction hidden in that text can do.

- **Enforced by the daemon, not by instruction.** A hook is asked before every
  tool call of the turn, ahead of Claude Code's own permission rules, and refuses
  whatever the lock does not approve. Nothing can pre-approve a call past it: not
  an allow rule in the repository's settings, and not Claude Code's own list of
  commands it considers read-only. The turn also runs in the default permission
  mode with a callback that gives the same answer, and the tools that edit and
  write files are removed from it.
- **What is approved**: reading, searching and listing files; writing and editing
  files inside the Clot's own memory folder, and nowhere else, so the Clot keeps its
  memory (section 6); web search and web fetch; subagents and skills; the daemon's
  own tools, each of which enforces its own rating on the axes; and a
  fixed list of shell commands that only read, plus the project's own test
  command, given exactly. The list, and the flags and
  shell features that are refused because they would make a reader write or run
  something, are in the stage 2a specification.
- **Refused when in doubt.** A command line is approved only when every command in
  it is approved. Redirection, substitution, variables, subshells and background
  execution are refused. Anything the checker cannot parse with confidence is
  refused, and the refusal tells the Clot why, so it can say what it could not
  check.
- **Known limit**: web fetch, web search and `ping` send a request to an address
  of the Clot's choosing, so a Clot hijacked by an event's text could leak a short
  secret through them. This is accepted: an investigation often needs the web.

### Untrusted input

- Triage, the routing call and the router have no tools and return a fixed
  schema.
- Their system prompts instruct them to treat event content as data and to
  disregard instructions inside it.
- Event payloads are wrapped and labelled as untrusted when passed to the main
  session. The Clot's system prompt states that instructions come only from the
  user through chat.
- An event from an outsider is still acted on: people who don't know how the
  project is meant to be used find bugs the user would not. An outsider is the
  author of a GitHub issue, comment or review whose association with the
  repository is not owner, member or collaborator, or the sender of an email from
  an address that is not one of the user's own. The event is marked as from an
  outsider, and the main session is told to be more cautious with it: confirm the
  problem in the code before starting a worker, keep the work to the problem
  reported, and do nothing else the text asks for. The worker's brief says the
  report came from an outsider.
- A worker's brief is written by the main session. Text from an event that the
  brief quotes stays wrapped and labelled as untrusted, and the worker's system
  prompt states that its instructions are the brief's own words.
- A suspected injection is flagged to the user in the Clot's channel and never
  reaches the Clot.
- Text from an event that looks like a command is not one: an event cannot close
  a session or set an effort level.

## 8. Gates

An event that needs action passes these checks in order.

1. **Usage limit reached**: queue. The Clot tells the user once, with the reset
   time. Work resumes when the limit resets.
2. **Scarce mode** (15:00–18:00, Monday to Friday by default, configurable per
   weekday): urgent events and the user's direct messages run normally. Other events
   get their one-line notice and are queued until the window ends. Sweeps are
   skipped.
3. **Lead-in** (10:00–15:00 on the same days): Clots are held to 50% of the
   five-hour usage window, configurable.
4. **Otherwise**: first come, first served.

The same gates apply to starting a worker: in scarce mode only work for an urgent
event or a direct request from the user starts; other workers wait until the window
ends. A worker already running is not stopped by a gate.

When usage is running low, the order of priority is: urgent events, the user's
direct messages, ordinary events, sweeps. Several low-priority events for one Clot
are delivered as a single digest turn.

Usage is read from the SDK's rate-limit events (fraction used, reset time). The
daemon keeps a spend log per Clot, with each worker's spend on its own line, and
warns the user when a Clot's weekly spend passes a configured threshold.

## 9. Intake

| Source | Mechanism | Target latency |
|---|---|---|
| GitHub, Stripe, Linear, Notion, Sentry, Vercel | Webhook | Seconds |
| Email (Gmail or any IMAP server) | IMAP IDLE | Seconds |
| PostHog | Webhook destination with a token header | Seconds |
| Google Calendar | Poll of the calendar's secret iCal address; changes through an Apps Script the user deploys | 1 to 5 minutes |
| Any service that sends webhooks | Webhook recipe | Seconds |
| Any other MCP server | Watch recipe | 1 to 5 minutes |
| Connectors that exist only in the user's claude.ai account | Sweep | Up to 90 minutes |

- **Webhooks** reach the daemon through Tailscale Funnel, which gives the machine
  a stable public HTTPS address without touching the user's DNS. The intake server
  listens on localhost only (port 8787 by default, one path per source, such as
  `/webhooks/github`). Signatures are verified per source and duplicates are
  dropped by delivery ID. The source is answered as soon as the event is stored.
- **GitHub** sends five kinds of event: an issue opened or reopened, a comment on
  an issue or pull request, a review submitted, a pull request opened or reopened,
  and a workflow run that failed or timed out. Every other delivery is
  acknowledged and discarded. What each other source sends, and how it is
  verified, is in the stage 2c specification.
- **No Google Cloud project**: the calendar is read through its secret iCal
  address and changed through an Apps Script that runs as the user, so the user's
  own Google account is all it needs.
- **Watch recipes**: the daemon acts as an MCP client of servers set in its own
  configuration, logging in through OAuth with a link it posts in chat when a
  server needs it. On a timer it calls one read-only tool and diffs the result
  against the previous result. No model is involved. A recipe names the tool, its
  arguments, where the items are, the field that identifies an item, and the
  interval. When a new server appears, the Clot is told, inspects its tools and
  adds a recipe, posted with its undo (section 5).
- **Webhook recipes**: a service with no built-in support is described in the
  rulebook: how its signature is checked, which payloads are kept and which fields
  give the event. The Clot adds one with its undo (section 5); the user sets up
  the webhook and puts its secret in `.env`.
- **Sweep**: every 90 minutes the daemon starts a fresh Opus 5.5 low session
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

Each container holds its own clone of the repository, and each worker works in a
worktree of that clone on its own branch. The user and the Clot do not share a
working directory; the Clot's work appears as branches and pull requests.
The home Clot has no repository of its own: it looks into things through `gh` and
the web, and clones a repository into its workspace when the work needs it.

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
  are in SQLite with write-ahead logging. Sessions resume from disk. An event that
  was stored is picked up from the step it had reached; events that were being
  held are released at once; open asks stay open and can still be answered; a
  choice whose 10 minutes passed while the daemon was down is decided by the
  timeout at once; workers that were in a turn are resumed, and those waiting for a
  place keep their order.
- **Daemon starting**: the intake port is taken before anything else is read or
  changed, and deliveries are stored from that moment. A second daemon finds the
  port taken, says so and stops, having touched nothing.
- **Triage call fails**: the event is delivered as needing action.
- **A worktree cannot be created** (the branch exists, the disk is full): the
  worker does not start, and the main session is told why.
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
- Plain YAML files in a git repository of their own for the rulebook.
- Node's built-in HTTP server for intake, behind Tailscale Funnel.
- discord.js for Discord, behind the chat adapter interface.
- An IMAP library with IDLE support.
- Docker; one image built for arm64 and x64, on Debian trixie with Node 24 and
  npm for the Clot's own work. Claude Code comes from its native installer and
  lives outside the Clot's home volume, so rebuilding the image is what updates
  it: at startup the daemon recreates any container made from an older build,
  keeping its volumes. gh comes from GitHub's own apt repository.
- Playwright with Chromium.

## 14. Testing

- Unit tests for pure logic: pre-filters, routing, gates, the five-word check,
  schedules, channel naming, reply matching, the hold's timing, each daemon tool's
  rating on the axes, the gates by kind of turn with the outsider exception, reply
  matching for each kind of ask, closing an ask exactly once when a reply races
  the timeout or a withdrawal, a merge ask withdrawn by a new commit, the choice's
  timeout on a fake clock, the worker queue and
  its limit, the `clots-waiting` message, and the undo of every action that is
  applied with one.
- The lock's command checker and the worker guard are each tested against two
  tables: commands that must pass and commands that must be refused. A command
  added to an approved list brings its ways of writing, executing or sending into
  the second table.
- Source adapters tested against recorded real payloads.
- Model steps sit behind an interface. The pipeline is tested with fakes. A small
  labelled set of events scores the triage and router prompts whenever they change.
- End-to-end tests with a fake chat adapter, fake worker sessions and a fake
  source.
- Live checks: a GitHub issue reaches an open pull request with no reply from the
  user; a choice times out and the Clot goes with its pick; an ask is listed in
  `clots-waiting`, answered, and leaves the list.
- On the Pi: a memory and build-time check with three Clots and three workers
  running, and Chromium open.

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
2. **Intake, triage and rulebook**, built in four parts, with global memory
   between 2b and 2c, each with its own specification and plan:
   - **2a. Pipeline with one source**: the event format, intake, the self-caused
     drop, pre-filter, routing, holding automated events, triage, the steering
     question, the lock for investigations and for brainstorm mode, the Clots' own
     GitHub account, a rulebook edited by hand, and GitHub as the only source
     (`.superpowers/specs/2026-10-11-clots-stage-2a-pipeline-design.md`).
   - **2b. Rulebook editing and standing rules**, and the home Clot: the daemon
     tools, edits applied or proposed, proposals, `&rules`, standing rules sent
     as GitHub comments, and the home Clot for repositories no Clot is bound to
     (`.superpowers/specs/2026-10-12-clots-stage-2b-rulebook-design.md`).
   - **Global memory**, built after 2b as a part of its own: memories the home
     Clot writes, the user approves and every Clot receives, and `&memory`
     (`.superpowers/specs/2026-10-14-clots-global-memory-design.md`).
   - **2c. More sources**: Stripe, email, Google Calendar, Linear and Notion, watch
     recipes with the daemon's MCP client, and webhook recipes; with them, shared
     sources, routing rules, the routing call and routing corrections, each
     source's way of sending a standing rule, email drafts, send review and the
     calendar tools.
     Sentry, Vercel and PostHog are specified there and built later, once each can
     be checked live
     (`.superpowers/specs/2026-10-14-clots-stage-2c-sources-design.md`).
   - **Main session and workers**, built after 2c as a part of its own: the main
     session always under the lock, the router's low or medium, the worker tools,
     worktrees, the worker guard, the model rules, progress lines and the worker
     limit, and triage and the routing call on Haiku 5.5.
   - **Autonomy**, built after that: the axes and each daemon tool's rating, asks,
     the actions applied with an undo (rulebook edits, global memories, removing a
     calendar event and `&calendar undo`), low actions in every kind of turn, one
     component for every ask (replacing the separate proposal, send review and
     memory question channels), `merge_pull_request`, choices with their timeout,
     and `clots-waiting`.
   - **2d. Gates and sweep**, with the spend log and rollover re-grounding. The
     gates also hold back worker starts.
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
- brainstorm mode: detection, mode instruction, marker, and the lock in its first
  form: a locked turn runs in the default permission mode, is refused everything
  that needs permission, and has no tools that edit or write files;
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
the container, a separate GitHub account for the Clots (stage 2a; until then the
Clot uses a scoped token of the user's), the lock's list of approved read-only
commands and the hook that asks it before every tool call (stage 2a, where the
lock also starts to serve investigations), pruning old channels. The container
login is done by hand in stage 1.

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
- A resumed turn in the default permission mode, with a callback that refuses
  everything put to it, cannot write a file. (Plan mode is not an alternative: it
  never consults the callback.)

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
- Nothing on GitHub's side stops the Clots' account from merging unless a branch
  rule requires an approving review; and on a free plan, branch rules on a private
  repository are not enforced at all.
- A locked turn can still send data out through the web tools and `ping`
  (section 7).
- A worker can reach another person in ways the worker guard cannot see: a
  `curl` to an address of its choosing, and, once the browser is built, a click
  that posts or accepts terms. Only the worker's instructions stand in the way.
- A worker's branch runs the repository's CI with its Actions secrets, as any
  collaborator's pull request does. The Clots' token cannot change workflow files,
  but the scripts CI runs are the worker's to change.
- Three workers per host, plus Chromium, on an 8 GB Pi is unmeasured, and the
  containers have no memory cap. Stage 3's
  check on the Pi runs exactly that load.
- Acting without asking means a wrong low action is noticed later: a pre-filter
  that drops too much, a pull request built on the wrong option. Each is posted
  with its undo, which is what keeps this acceptable.
- Agent SDK billing terms changed three times in 2026. As of 2026-10-07, SDK usage
  draws from subscription limits.
