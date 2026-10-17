# Clots: design

Date: 2026-10-10
Status: approved in brainstorming. Stages 1, 2a, 2b and 2c (but for Sentry, Vercel
and PostHog) and global memory are implemented.

## 1. What Clots is

Clots are always-on agents built on Claude Code, in the spirit of OpenAI's dots and
Grok Bot. Each opted-in project gets one Clot, and an optional "home" Clot takes
what belongs to no project. A Clot:

- is triggered by events from connected services, by the user's chat messages, and
  by a 90-minute clock;
- investigates on its own, under a lock that lets it change nothing, proposes one
  or two actions, and after the user's go-ahead carries the work through to an open
  pull request;
- has its own isolated computer (a container with a repo clone and a browser);
- lives in one long session, rolled over into a fresh session with a written recap
  when context reaches 65% or when the user closes it;
- keeps its own memory across sessions, and shares the global memories the user
  approves through the home Clot;
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
| Intake | Receive webhooks, hold IMAP IDLE connections, poll calendar feeds, run watch and webhook recipes, fire the 90-minute tick. Verify each delivery, drop repeats, store the event and answer the source at once. Normalise everything into one event format (section 3). | Tunnel, source credentials |
| Rulebook | A folder and git repository of its own, one file for every Clot and one per Clot: pre-filters, routing match rules, triage guidance, urgency markers, standing-rule templates, watch recipes. | None |
| Hold | Keeps automated events (CI runs, anything from a bot account) back for a minute or two and gathers those about the same pull request or branch into one event. | A timer |
| Routing call | Sonnet 5.5, low effort, no tools, fixed output schema. Picks the Clot for an event from a shared source that no routing rule matched. | Each Clot's one-line description |
| MCP client | Connects the daemon to MCP servers of its own, logging in through OAuth where a server needs it, for watch recipes. | Tunnel |
| Triage | Sonnet 5.5 (`claude-sonnet-5-5`), low effort, no tools, fixed output schema. | Rulebook |
| Steering | Asks the user, in a temporary channel, whether an event that bears on the running turn should be fed into it. The question is written by the explainer: Haiku 5.5, medium effort, no tools. | Chat adapter |
| Lock | Decides what a locked turn may do: read, look things up, and run a fixed list of read-only commands. Asked before every tool call. | None |
| Gates | Decide whether an event is delivered now or queued. | Usage events, schedule, mode |
| Router | Haiku 5.5 (`claude-haiku-5-5`), medium effort, no tools. Picks the effort level for every prompt and detects brainstorm start and stop. | Recent messages |
| Session manager | Start a Clot's process for a turn, resume its session, apply effort and mode, stop the process afterwards. Enforce one heavy job at a time per host. | Agent SDK, Docker |
| Clot container | The Clot's computer: repo clone, Chromium with a persistent profile, live view, scoped credentials, its own Claude login, a copy of the user's Claude setup. | Image for arm64 and x64 |
| Commands | Messages that start with `&`. Handled by the daemon before routing; never passed to the model. | Session manager |
| Daemon tools | Custom tools registered with `createSdkMcpServer`. They run in the daemon process, outside the container, and are made for each turn, so each call knows what kind of turn it is in. | Rulebook, chat adapter |
| Proposals | Puts a rule change to the user in a temporary channel and carries out the answer. | Chat adapter, rulebook |
| Global memory | Notices the global memories the home Clot writes, asks the user about each, and copies the approved ones into every Clot's memory before its turns. | Chat adapter, Docker |
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
   the user, urgent (yes or no), suspicious (yes or no), and, when a turn is
   running for that Clot, whether the event bears on that turn right now. A
   suspicious event is reported to the user and goes no further; this is checked
   first. Events that need no action stop here, silently. If the triage call
   fails, the event is delivered.
8. **Gates** deliver the event now or queue it (section 8).
9. **Steering question**, only when a turn is running and triage said the event
   bears on it ("Steering" below). The user decides: feed it into the turn, queue
   it, or drop it.
10. **Queue**: the one-line message is posted in the Clot's live channel, for
    example "Sentry just reported a crash – investigating it now.", and the event
    joins the Clot's queue. Events and the user's messages share one queue and are
    handled in arrival order.
11. **Router** picks the effort level.
12. **Session manager** resumes the Clot's session, applies the effort level, and
    delivers the event as a turn of its own, wrapped and labelled as untrusted
    external data.
13. The Clot investigates under the lock (section 7), using subagents for the
    digging, then proposes one or two options and waits.
14. The user answers in chat, which starts a normal turn. After the go-ahead the
    Clot works through to an open pull request (section 7). What the user writes
    on the source itself, such as a comment on GitHub, is an event like any other:
    instructions come only through chat.
15. After the turn the daemon posts a summary of what the turn changed and ran,
    reads context usage, and rolls the session over at 65% or more (section 6).

Entry points other than events:

- **User messages** enter at step 11. Triage does not run on them. A message that
  is a command (section 6) is handled by the daemon and goes no further.
- **The 90-minute tick** starts a sweep (section 9). It is skipped while the Clot
  is working. Sweep findings enter at step 3 as ordinary events.

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

### Steering

An event never joins a running turn by itself. When triage says an event bears on
the turn that is running, whatever kind of turn it is:

- the daemon opens a temporary channel in the Clot's category (`<clot>-ask`),
  mentions the user, and says what happened and how it bears on the work, in the
  explainer's words;
- the user's reply is matched exactly, after lowercasing and removing
  punctuation: `yes`, `sure`, `do that` or `yeah` feeds the event into the turn;
  `after`, `not rn` or `once youre done` queues it; `dont`, `not at all` or `no`
  drops it; anything else repeats the question;
- the channel is deleted when the outcome has been carried out;
- an unanswered question lapses to "queue" when the turn ends, and at startup,
  when no turn is running; each question is closed exactly once;
- a steered event is still untrusted data: the user's yes lets it into the turn
  and does not make its text an instruction.

## 4. Models and effort

| Role | Model | Effort |
|---|---|---|
| Clot main session | Opus 5.5 (`claude-opus-5-5`) | Chosen per prompt by the router |
| Triage | Sonnet 5.5 | Low |
| Routing call (shared sources) | Sonnet 5.5 | Low |
| Router | Haiku 5.5 | Medium |
| Explainer (steering questions) | Haiku 5.5 | Medium |
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
streaming input. Four kinds of message wait for a turn of their own instead, so
that messages always take effect in the order the user sent them, and in a turn
that can do what they ask:

- one that changes the mode, because a turn's permissions are fixed when it starts;
- one sent in action mode while an investigation is running: the investigation is
  locked, and the message is owed a working turn;
- one sent after an earlier message that is itself still waiting;
- one that arrives after the turn has stopped accepting input.

The Clot handles a "meanwhile" request by starting a subagent:

- a fresh subagent by default;
- a fork carrying the conversation only when the request depends on it.

The main session chooses the subagent's model and effort itself. There is no
second router.

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
  with a daemon tool, and proposes a routing rule when there is a pattern.

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

The daemon decides whether an edit is applied or put to the user. The Clot cannot
choose.

- **Applied at once:** a pre-filter or a triage line in the Clot's own file, in a
  working turn the user started that no steered event has joined. The daemon
  posts the resulting rule in the Clot's channel.
- **A proposal, needing the user's yes:** any edit made in an investigation, in a
  brainstorm turn, or in a turn a steered event has joined; any edit to
  `global.yaml`; and any standing rule added, replaced or removed. These are the
  turns that are locked or that hold text the user did not write, and the edits
  that reach beyond one Clot or let it send.
- **How a proposal is answered:** like a steering question (section 3). The
  daemon opens a temporary channel in the Clot's category (`<clot>-rule`),
  mentions the user and shows the exact edit. `yes`, `sure`, `do that` or `yeah`
  applies it; `no`, `dont` or `not at all` declines it; anything else repeats the
  question. The reply never reaches the model. The channel is deleted when the
  answer has been carried out.
- **What the Clot learns:** the tool returns at once and the Clot does not wait.
  The outcome is posted in its live channel and placed as a note in front of its
  next turn. A note starts no turn.
- **Limits:** a proposal lasts as long as its session and is closed as unanswered
  when the session closes or rolls over. A Clot may have three open, or the
  number in `CLOTS_MAX_PROPOSALS`.
- **When a Clot suggests a rule unasked:** only on a clear pattern (the same kind
  of event dismissed more than once, or a stated standing preference), with the
  reason in one line, and never again once declined.
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

### Memory

Each Clot keeps Claude Code's own auto memory in its container: one file per
memory and a `MEMORY.md` index, written by the Clot and read by every session,
including one that is resumed.

Global memories apply to every Clot, as `global.yaml` does for rules. The full
design is in `.superpowers/specs/2026-10-14-clots-global-memory-design.md`.

- **Only the home Clot writes them**, as files named `global-clot-…` in its own
  memory folder: when the user asks, or on its own for what clearly applies to all
  of the user's work. Project Clots cannot suggest one.
- **The user's yes:** the daemon notices a new or changed file after each home
  Clot turn and asks in a temporary channel (`home-memory`), as for a rule
  proposal. A no puts the home Clot's copy back. A deletion is applied at once.
- **Delivery:** before each turn, the daemon copies the approved files into the
  Clot's memory folder, removes any other `global-clot-` file, and keeps a block of
  index lines at the top of its `MEMORY.md`. Each change also leaves the Clot a
  note.
- **Clots are told** not to edit or remove global memories or the daemon's block.
  This is an instruction only; the next sync undoes any change.

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
| `&close nosummary` | A new session and channel with nothing carried over: no recap, brainstorm mode off, the router's recent-message context cleared. On a new session that still holds an unused recap, it discards the recap in place. |
| `&effort low\|medium\|high <message>` | Sends the message at that effort level. |
| `&effort low\|medium\|high` | Sets the level for the next message only. It is spent on the next message delivered, and kept if that delivery is refused. |
| `&rules` | Lists the rules in force for this Clot, each with its file, and its open proposals. Answered at once, also during a turn. |
| `&rules undo` | Reverts the most recent rulebook edit made from chat through this Clot and shows what it reverted. Sent again, it steps one edit further back. It needs no further yes. |
| `&memory` | Lists the global memories in force and those waiting for the user's answer. Works in every Clot's channel, also during a turn. |
| `&memory undo` | Reverts the most recent global memory change that spread: an approval or a deletion. Sent again, it steps one further back. |

A `&close` sent during a turn waits for the turn to end. On a session with no turns
yet and no recap, it does nothing.

### Brainstorm mode

- The router detects the user asking to start or stop brainstorming.
- While brainstorming, every turn runs under the lock (section 7), the same one
  that holds during an investigation. The Clot can read code, run read-only
  commands, browse and look things up; it cannot change anything. Claude Code's
  plan mode is not used for this: it never consults the daemon, so only the
  model's restraint would hold.
- A mode instruction tells the Clot what it can and cannot do, to stay in
  ideation, and not to close replies with offers to act. The user usually reads on
  a phone and cannot open files, so thinking and plans go in the reply.
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
- Nothing addressed to a person goes out without the user's yes. It is written
  as a draft, sent under a standing rule the user approved, or, for email, put to
  the user with send review: the daemon shows the email in a temporary channel
  and sends it only on the user's yes there. A daemon-wide switch turns send
  review off, leaving drafts and standing rules. An email draft can be saved in
  the user's own Drafts folder, for the user to send.
- In the user's calendar a Clot may add events and move or change them, never
  one with guests and never a repeating one. Removing an event needs two yeses:
  the user's in chat, then the user's in a temporary channel where the daemon
  shows the event.

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
  private repositories only on paid plans. Without such a rule, the Clot's
  instructions are the only gate on merging.
- **Authorship**: commits are authored as `<name>-clot`, with the no-reply address
  of the GitHub account that owns the Clot's token. Hosts such as Vercel refuse to
  build a commit whose email matches no GitHub account. Pull request descriptions
  end with "Created with a Clot." linked to the Clots repository, in place of
  Claude Code's own attribution line.
- **Sign-in**: each container is logged in to Claude once (section 10). Without that
  login the daemon falls back to a token from `claude setup-token`.
- **Isolation**: the Claude Code process and all its built-in tools run inside the
  container. In a working turn, tool calls inside the container are auto-approved;
  the container and the scoped credentials are the boundary. In a locked turn the
  lock decides every call.
- **Privileged actions** (sending from a template, editing the rulebook, posting to
  chat, saving an email draft, asking to send an email, changing the calendar,
  handing an event to another Clot) exist only as daemon tools, outside the
  container. Under the lock, the tools that only read (the calendar, the daemon's
  MCP servers) are allowed, rulebook edits are only proposed, an email can be put
  to the user only as the answer to the email being looked into, and the rest are
  refused.
- **Secrets** are entered through the `clots` CLI, never through chat.

### The lock

A locked turn cannot change anything. Two kinds of turn are locked: a turn started
for an event, and every turn while brainstorm mode is on. Editing, committing,
pushing and sending are impossible until the lock is off: for an event, when the
user replies; for brainstorming, when the mode ends.

- **Enforced by the daemon, not by instruction.** A hook is asked before every
  tool call of the turn, ahead of Claude Code's own permission rules, and refuses
  whatever the lock does not approve. Nothing can pre-approve a call past it: not
  an allow rule in the repository's settings, and not Claude Code's own list of
  commands it considers read-only. The turn also runs in the default permission
  mode with a callback that gives the same answer, and the tools that edit and
  write files are removed from it.
- **What is approved**: reading, searching and listing files; web search and web
  fetch; subagents and skills; the daemon's own tools, each of which enforces its
  own limits (a rulebook edit made under the lock is only ever proposed); and a
  fixed list of shell commands that only read, plus the project's own test
  command, given exactly. The list, and the flags and
  shell features that are refused because they would make a reader write or run
  something, are in the stage 2a specification.
- **Refused when in doubt.** A command line is approved only when every command in
  it is approved. Redirection, substitution, variables, subshells and background
  execution are refused. Anything the checker cannot parse with confidence is
  refused, and the refusal tells the Clot why, so it can say what it could not
  check.
- **A turn's lock is fixed when it starts, and what continues a turn keeps it.** A
  message from the user is never used up in a turn with a different lock. An
  investigation cut off by the usage limit is picked up again under the lock,
  across a restart of the daemon as well.
- **Known limit**: web fetch, web search and `ping` send a request to an address
  of the Clot's choosing, so a Clot hijacked by an event's text could leak a short
  secret through them. This is accepted: an investigation often needs the web.

### Untrusted input

- Triage and the router have no tools and return a fixed schema. The explainer
  has no tools either.
- Their system prompts instruct them to treat event content as data and to
  disregard instructions inside it.
- Event payloads are wrapped and labelled as untrusted when passed to the main
  session. The Clot's system prompt states that instructions come only from the
  user through chat.
- A suspected injection is flagged to the user in the Clot's channel and never
  reaches the Clot.
- Text from an event that looks like a command is not one: an event cannot change
  the mode, close a session or set an effort level.

## 8. Gates

An event that needs action passes these checks in order.

1. **Usage limit reached**: queue. The Clot tells the user once, with the reset
   time. Work resumes when the limit resets.
2. **Brainstorm mode on**: events are queued silently and delivered as one batch
   when brainstorming ends. An event that bears on the discussion is the
   exception: it goes through the steering question of section 3, as during any
   other turn, and nothing joins the conversation without the user's yes. An event
   marked urgent still gets its one-line notice immediately, with no
   investigation.
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
  proposes a recipe for the user to approve.
- **Webhook recipes**: a service with no built-in support is described in the
  rulebook: how its signature is checked, which payloads are kept and which fields
  give the event. Adding one needs the user's yes; the user sets up the webhook
  and puts its secret in `.env`.
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
  held are released at once; open steering questions lapse to the queue; open
  rule proposals stay open and can still be answered.
- **Daemon starting**: the intake port is taken before anything else is read or
  changed, and deliveries are stored from that moment. A second daemon finds the
  port taken, says so and stops, having touched nothing.
- **Triage or explainer call fails**: the event is delivered as needing action;
  the steering question falls back to the event's bare facts.
- **Turn interrupted**: the session is resumed and told its last turn was cut off.
  A session interrupted during its very first turn already has a transcript, so it
  is resumed, not created again.
- **Paused at restart**: a usage-limit pause that expired while the daemon was down
  is resumed at startup like one that expires while it is running. A turn that is
  picked up again keeps its lock.
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
  schedules, channel naming, reply matching, the hold's timing.
- The lock's command checker is tested against two tables: commands that must
  pass and commands that must be refused. A command added to the approved list
  brings its ways of writing or executing into the second table.
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
   - **2d. Gates and sweep**, with the spend log and rollover re-grounding.
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
- Agent SDK billing terms changed three times in 2026. As of 2026-10-07, SDK usage
  draws from subscription limits.
