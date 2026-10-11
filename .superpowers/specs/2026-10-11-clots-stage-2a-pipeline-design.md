# Clots stage 2a: pipeline with one source

Date: 2026-10-11
Status: approved in brainstorming; ready for an implementation plan.
Parent design: `.superpowers/specs/2026-10-10-clots-design.md`. This document
specifies the first of the four parts of stage 2 (section 16 there).

## 1. What 2a delivers

A GitHub event on a Clot's repository reaches that Clot. The Clot posts a one-line
notice, investigates without being able to change anything, proposes one or two
options in its channel, and waits. The user's reply in chat starts a normal working
turn.

When an event arrives while the Clot is already working and bears on that work, the
user is asked whether to feed it into the running turn.

Automated reports about the same pull request or branch (failed CI runs, failed
deploy previews) are held briefly and reach the Clot as one event. A review reaches
the Clot together with its inline comments.

GitHub is the only source. The rulebook is read from files and edited by hand.

## 2. Changes to the parent design

2a settles these points, which the parent design left open or decided differently:

- **The Clots have their own GitHub account.** One machine account serves all of a
  user's Clots. Each Clot's token belongs to it, and it is a collaborator on each
  bound repository. This replaces acting as the user's account.
- **One built-in drop.** The parent design has no built-in drops. 2a adds one:
  events the Clot caused itself (section 5).
- **Investigation is locked by the daemon**, not only by instruction (section 7).
- **Brainstorm mode moves onto the same lock.** Stage 1 ran it in plan mode with a
  callback that refuses everything. Plan mode never consults that callback: a
  session in that configuration ran file-changing shell commands when told to. Only
  the model's own restraint was holding. Brainstorm mode no longer uses plan mode.
- **Relevance to a running turn applies to every turn**, with the user's approval
  (section 8). The parent design has it for brainstorm mode only, decided by triage
  alone; stage 2d builds its brainstorm gate on the mechanism defined here.
- **Webhooks reach the development machine through Tailscale Funnel.** The parent
  design prefers Cloudflare Tunnel where the user's DNS is on Cloudflare; this
  user's is not, and moving it is not acceptable.

## 3. Components

| Component | Responsibility | Depends on |
|---|---|---|
| Intake server | An HTTP server inside the daemon. Verifies GitHub's signature, drops repeated deliveries by delivery ID, stores the event, and answers GitHub without waiting for anything else. | Webhook secret, store |
| GitHub adapter | Turns a GitHub payload into the common event (section 4). Pure. | None |
| Hold | Keeps automated events back for a short while, grouped by Clot and subject, and releases each group together (section 6). | A timer |
| Batch | Turns the events of a released group into one event (section 6). Pure. | None |
| Review reader | Fetches a review's inline comments from GitHub and adds them to the review's event. | The Clots' token |
| Rulebook | Loads the rule files; answers whether an event is dropped and what triage guidance applies. Read-only in 2a. | Rule files |
| Triage | One Sonnet 5.5 call at low effort, no tools, fixed output schema. | Rulebook guidance |
| Explainer | One Haiku 5.5 call at medium effort, no tools. Writes the message for a steering question. | None |
| Command checker | Decides whether a shell command is read-only, and whether a tool call is allowed under the lock (section 7). Pure. | None |
| Pipeline | Runs an event through the steps of section 6 and hands it to the Clot. | All of the above |
| Clot (changed) | Runs an event as a turn of its own under the lock; runs brainstorm turns under it too; steers an approved event into a running turn. | Runner, store, chat |
| Runner (changed) | Starts a turn unlocked, or under the lock for brainstorming or for investigating. | Command checker |
| Clot image (changed) | Gains `ping`, `ps`, `tree` and `file`, which the approved list names and the image lacked. | None |
| Chat adapter (changed) | Can delete a channel. | Discord |

## 4. The common event

Every source produces the same shape. In 2a only GitHub does.

| Field | Meaning |
|---|---|
| `id` | The source's delivery ID. Unique; used to drop repeats. |
| `source` | `github` |
| `kind` | One of the five kinds below |
| `repo` | `owner/name` |
| `actor` | The login of whoever caused it |
| `title` | One line: what happened |
| `body` | The relevant text, trimmed to a fixed length |
| `url` | A link to the thing on GitHub |
| `ref` | The issue or pull request number, or the branch for a CI run |
| `subject` | What the event is about: `pr:14`, `issue:7` or `branch:main`. A CI run's subject is its pull request when GitHub names one, otherwise its branch. |
| `automated` | Whether a machine produced it: every CI run, and anything from a bot account |
| `receivedAt` | When the daemon received it |

The five kinds, and the GitHub deliveries that produce them:

| Kind | GitHub event and action |
|---|---|
| `issue_opened` | `issues`: `opened`, `reopened` |
| `comment` | `issue_comment`: `created` (GitHub uses this for comments on pull requests too) |
| `review` | `pull_request_review`: `submitted` |
| `pr_opened` | `pull_request`: `opened`, `reopened` |
| `ci_failed` | `workflow_run`: `completed` with conclusion `failure` or `timed_out` |

Any other delivery is acknowledged and discarded. A review's individual line
comments are not separate events; the daemon reads them and adds them to the
review's event (section 6).

A sixth kind, `batch`, is never produced by a source. The daemon makes it from
several automated events about one subject (section 6). Pre-filter rules cannot
name it.

## 5. Self-caused events

The daemon learns the Clots' GitHub login from the token at startup. An event is
dropped when its actor is that login and its kind is `issue_opened`, `comment`,
`review` or `pr_opened`: the Clot wrote the thing itself.

`ci_failed` is never dropped by this rule. GitHub names the account that pushed as
the actor of a CI run, so a failure on the Clot's own branch carries the Clot's
login, and it is exactly what the Clot must hear about. A `batch` is never dropped
by it either: each event in it passed this rule when it arrived.

## 6. The pipeline

1. **Receive.** A request with a bad signature is refused. A delivery ID already
   stored is acknowledged and ignored. Otherwise the event is stored and GitHub is
   answered.
2. **Normalise.** The adapter produces the common event, or nothing for a delivery
   outside the five kinds.
3. **Self-caused drop** (section 5).
4. **Pre-filter.** Rulebook rules drop events. Nothing else is dropped without a
   rule.
5. **Route.** The repository picks the Clot. In 2a each repository is bound to one
   Clot through the Clot's `repoUrl`. An event for an unbound repository is logged
   and discarded.
6. **Hold.** An automated event is kept back and gathered with others about the
   same subject ("Holding automated events" below). What comes out is one event:
   the event itself, or a `batch`. Events written by people skip this step.
7. **Inline comments.** A review's inline comments are fetched and added to its
   body ("Inline review comments" below).
8. **Triage** returns four answers: needs action, a one-line message for the user,
   urgent, suspicious. When a turn is running for that Clot, triage also receives
   the last four messages of the conversation and returns a fifth answer: relevant
   to what is happening right now.
   - Suspicious: a warning with the one-line message is posted in the Clot's
     channel, and the event goes no further. This is checked first: triage usually
     says of an injection attempt both that it is suspicious and that it needs no
     action.
   - Needs no action: the event stops here, silently.
   - `urgent` is recorded. It has no effect until stage 2d.
9. **Steering question**, only when a turn is running and triage said relevant now
   (section 8). Its outcome is steer, queue or drop.
10. **Queue.** The one-line message is posted in the Clot's live channel and the
   event joins the Clot's queue. Events and the user's messages share one queue and
   are handled in arrival order. An event never joins a running turn except through
   step 9.
11. **Investigate.** The event runs as a turn of its own under the lock
   (section 7), wrapped and labelled as untrusted external data. The Clot replies
   with what it found and one or two options.
12. **The user answers in chat**, which starts a normal turn. A comment the user
    writes on GitHub is an event like any other: instructions come only through
    chat.

The steps after a turn are those of stage 1: the turn summary, the context check,
rollover.

If the triage call fails, the event is treated as needing action, not urgent, not
suspicious and not relevant now, so it is queued and nothing is lost silently.

### Holding automated events

One push often sets off several automated reports within a minute: a failed CI
run, the same run reported a second time for the pull request, and a comment from
each deploy service. Each would otherwise get its own investigation, and the
investigations would say the same thing.

- **What is held:** events marked `automated`. Issues, comments, reviews and pull
  requests from people are never delayed.
- **Grouping:** by Clot and `subject`.
- **How long:** a group is released 60 seconds after its last event arrived, and
  at the latest 120 seconds after its first. Both are set in the configuration
  (`hold.quietSeconds`, `hold.capSeconds`).
- **Repeats:** within a group, CI failures with the same title (the same workflow
  on the same branch) count once; the latest is kept.
- **One event left:** it goes on unchanged.
- **Several left:** they become one `batch` event. Its title says how many reports
  there are and what they are about; its body lists each report's title, actor,
  link and text; its link is the pull request, or the first report when the
  subject is a branch. The events it was made from are recorded as merged into it.
- **From there on a batch is an event like any other:** one triage call, one
  notice, one steering question or one investigation. If triage finds it
  suspicious, the whole batch is reported and stopped.
- **Restart:** held events are stored. At startup their wait is over, and each
  group is released at once.
- **Known limit:** a report that arrives after its group was released (a CI job
  that takes five minutes) is handled by itself.

### Inline review comments

GitHub sends a review without its inline comments, and they are often all the
review says. Before triage, the daemon fetches them with the Clots' token and
adds them to the event's body: for each, the file, the line number or range, the text,
and the code it is on. They
are part of the event from then on: triage sees them, the Clot sees them, and
they are inside the same untrusted block and the same length limit as the rest
of the body. The lock is unchanged: a locked turn is not given `gh api`.

## 7. The lock

A locked turn cannot change anything. Two kinds of turn are locked: a turn started
for an event, and every turn while brainstorm mode is on.

The lock is enforced by the daemon, in three parts:

- The turn runs in Claude Code's default permission mode, in which anything not
  plainly read-only is put to the daemon's permission callback. Plan mode is not
  used: it does not consult the callback.
- The callback approves reading and a fixed set of read-only commands, and refuses
  everything else.
- The tools that edit and write files are removed from the turn altogether.

Editing, committing, pushing and sending are impossible until the lock is off: for
an event, when the user replies; for brainstorming, when the mode ends.

Approved without a command check: the tools that read, search and list the
container's files, web search and web fetch, and subagents (whose own tool calls
pass through the same callback).

Approved shell commands:

- **Files and text:** `cat`, `head`, `tail`, `ls`, `find`, `rg`, `grep`, `wc`,
  `sort`, `uniq`, `cut`, `stat`, `file`, `tree`
- **Git:** `log`, `diff`, `show`, `status`, `blame`, `branch` (listing only),
  `ls-files`, `grep`
- **GitHub CLI:** `issue view`, `issue list`, `pr view`, `pr list`, `pr diff`,
  `pr checks`, `run view`, `run list`
- **System:** `ps`, `docker ps`, `pm2 ps`, `pm2 list`, `ping` with a count
- **The project's test command**, set per Clot in the configuration, matched
  exactly

A command line is approved only when every command in it is approved. Commands may
be joined with pipes, `&&`, `||` and `;`. The checker refuses, wherever they
appear:

- output or input redirection, command substitution, subshells and background
  execution;
- flags that make a reader write or execute: `find` with `-exec`, `-execdir`,
  `-ok`, `-okdir`, `-delete` or any `-fprint` or `-fls` form; `rg` with `--pre`
  or `--hostname-bin`; `sort` with `-o`, or with any long option beginning
  `--o` or `--co`; `git` with any option before the subcommand, or with
  `--output` or `--ext-diff`; `git grep` with `-O` or any long option beginning
  `--op`; `tree` with `-o`; `gh` with `--web`;
- `uniq` with more than one argument that is not an option: it writes to a
  second file. An option's value must be attached, as in `-f1`;
- the long options above in any shortened form. GNU `sort` and `git grep` accept
  a long option cut short, so `sort --o=FILE` is `--output` and
  `git grep --op=PROGRAM` is `--open-files-in-pager`; that is why they are
  matched by their first letters;
- `ping` without a count, or with a count above ten.

Anything the checker cannot parse with confidence is refused. A refusal tells the
Clot which command was refused and why, and the Clot says in its reply what it
could not check.

Three things to know about the approved set:

- **Claude Code approves its own short list of plainly read-only commands**
  (`ls`, `cat` and similar) without asking the callback. The effective set is
  that list plus the one above.
- **Allow rules in the repository's own `.claude/settings.json` are honoured by
  Claude Code before the callback is asked.** A project that pre-approves a command
  there has approved it for locked turns too.
- **`docker` and `pm2` act inside the Clot's container.** They are useful when the
  project itself runs them there. They do not show the host's processes, and the
  container is not given the host's Docker socket.
- **Known limit: two approved things can carry data out.** Web fetch and web search
  send a request to an address or query of the Clot's choosing, and `ping` looks
  up a hostname. A Clot that had been hijacked by an event's text could leak a
  short secret through either. The user chose to allow both: an investigation
  often needs the web, for example to learn that a vulnerability is fixed in a
  release newer than the model's knowledge.

## 8. Steering a relevant event into a running turn

When step 9 of the pipeline applies:

1. The daemon creates a temporary channel in the Clot's category, named
   `<clot>-ask`, then `<clot>-ask-2` and so on while others are open.
2. It posts there, mentioning the user: what happened and how it bears on the work
   in progress, written by the explainer from the event and the last four
   messages, followed by the replies it accepts.
3. The user's reply in that channel is lowercased, stripped of punctuation and
   surrounding space, and compared exactly:

| Reply | Outcome |
|---|---|
| `yes`, `sure`, `do that`, `yeah` | Steer: the event is fed into the running turn |
| `after`, `not rn`, `once youre done` | Queue: step 10 of the pipeline |
| `dont`, `not at all`, `no` | Drop: the Clot never acts on it |
| anything else | The question is repeated in the same channel, with the accepted replies |

4. When the outcome has been carried out, the channel is deleted. For a steer, that
   is when the running turn has accepted the event.

Rules that keep this from leaving an event in limbo:

- **The question lapses when the turn ends.** If the user has not answered by then,
  the outcome is queue.
- **A yes that comes too late is a queue.** If the turn has ended or no longer
  accepts input, the event is queued and gets its own investigation.
- **Open questions are stored.** After a restart no turn is running, so each lapses:
  queue, channel deleted.
- **The rule is the same for every kind of turn**: working, investigating or
  brainstorming.
- **A steered event is still untrusted data.** The user's yes lets it into the
  turn; it does not make its text an instruction. It arrives with the same wrapper
  and label as a queued event, and a note that the user approved handling it now.
- **Order is kept.** If one of the user's messages is already waiting for the
  running turn to end, a steer is not attempted and the outcome is queue.

Nothing is steered without the user. If the user is away, a relevant event waits
for the turn to end and is handled in order.

## 9. The rulebook in 2a

- A folder of its own and a git repository of its own, separate from the Clots
  code. Its path is set in the configuration; the default is `rulebook/`, which the
  code repository ignores. The daemon creates and initialises it when missing.
- `global.yaml` applies to every Clot; `<clot>.yaml` applies to one.
- Contents in 2a:
  - `prefilters`: a list of rules. A rule drops an event when all the fields it
    names match: `kind`, `actor`, and `titleContains` (case-insensitive).
  - `triage`: plain-language guidance, passed to the triage call.
- The daemon reloads a file when it changes. A file that cannot be read or does not
  fit the schema is ignored: the last good version stays in force and the user is
  told once in the Clot's channel (in every Clot's channel for `global.yaml`).
- Routing rules, urgency markers, standing-rule templates, watch recipes, and
  editing through chat belong to later parts.

## 10. Setup

The plan walks the user through each of these. None is automated in 2a.

- Create the Clots' GitHub account, invite it to the test repository as a
  collaborator, and make a classic token on it with the `repo` scope. A
  fine-grained token cannot reach a repository its account is only a collaborator
  on; a classic token reaches exactly the repositories the account has been invited
  to. Replace `CLOT_GITHUB_TOKEN`.
- Install Tailscale and enable Funnel for the intake port.
- Add a webhook on the repository: the Funnel address, a secret that is also put in
  `.env`, content type JSON, and the five GitHub events of section 4.

## 11. Failure handling

- **Daemon down:** GitHub retries failed deliveries. An event that was stored is
  picked up after a restart from the step it had reached. Events that were being
  held are released at once.
- **Daemon starting:** the intake port is taken before anything else is read or
  changed, and deliveries are stored from that moment; they are handled once the
  rest has started, which can take as long as finishing a turn the restart cut
  off.
- **A second daemon is started:** it finds the port taken, says so and stops,
  having touched nothing.
- **A review's inline comments cannot be fetched:** the review goes on with a line
  in its body saying they could not be read.
- **Triage or explainer call fails:** triage falls back as in section 6. If the
  explainer fails, the steering question uses the event's title and the one-line
  triage message.
- **Chat unreachable while posting a notice:** the event is still queued.
- **Temporary channel cannot be created:** the outcome is queue.
- **Invalid rulebook file:** section 9.

## 12. Testing

- Unit tests: signature verification; the adapter against recorded real payloads
  for each kind and for ignored deliveries; the self-caused rule, including the CI
  exception; pre-filter matching; the hold's timing; making a batch, including
  repeated CI failures; formatting and fetching inline comments, against a fake
  GitHub; the command checker, with a table of commands
  that must pass and must fail; reply matching for the steering question; the
  triage and explainer output parsers.
- Pipeline tests with a fake triage, a fake explainer, a fake timer, and the
  stage 1 fakes for chat and runner: each outcome of sections 6 and 8, including
  the lapse rules, held events and batches.
- A small labelled set of events to score the triage prompt.
- Live checks at the end, as in stage 1.

## 13. Done when

In the development environment:

- opening an issue produces a notice, an investigation and a proposal in the
  Clot's channel;
- a review left on one of the Clot's pull requests does the same;
- a failed CI run on one of the Clot's branches does the same;
- the Clot's own pull requests and comments produce nothing;
- a push that fails CI and a deploy preview produces one notice and one
  investigation that covers them all;
- a review whose only content is inline comments produces an investigation that
  refers to those comments;
- during an investigation, an attempt to edit a file or push is refused, and an
  approved command runs;
- in brainstorm mode, a file-changing shell command is refused even when the Clot
  is told to run it;
- a pre-filter rule written by hand stops a matching event, without a restart;
- events queued before a restart are delivered after it;
- an event that triage judges relevant during a turn produces a temporary channel,
  and each of the three replies does what section 8 says;
- an unanswered steering question lapses to the queue when the turn ends.

## 14. Not in 2a

Editing the rulebook from chat, standing rules, routing corrections, the home Clot,
sources shared between Clots, every source other than GitHub, creating webhooks
automatically, gates other than the usage-limit pause, digests, the sweep, the
spend log.

## 15. Assumptions to verify first

- A turn in the default permission mode, with a permission callback and with the
  file-changing tools removed, runs the commands the callback approves and nothing
  else that changes anything. (Checked while planning, on 2026-10-11: this holds in
  the default mode and does not hold in plan mode. The plan repeats the check.)
- Tailscale Funnel can expose the intake port of the daemon on the development
  machine at a stable public HTTPS address.
- GitHub names the machine account, not the user, as the sender of what the Clot
  does; and names the pusher as the actor of a `workflow_run`.
- A `workflow_run` delivery for a branch of the same repository lists that
  branch's pull request, and a deploy service's comments come from an account
  whose login ends in `[bot]`. (Both seen in the deliveries recorded and received
  while building 2a.)
- A message fed into a running turn that is under the lock is accepted in the same
  way as in a working turn. (Checked while planning; the plan repeats the check.)

If any of these fails, stop and bring the finding to the user before continuing.
