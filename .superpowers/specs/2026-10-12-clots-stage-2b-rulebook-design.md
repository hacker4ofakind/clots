# Clots stage 2b: rulebook editing, standing rules and the home Clot

Date: 2026-10-12
Status: implemented.
Parent design: `.superpowers/specs/2026-10-10-clots-design.md`. This document
specifies the second of the four parts of stage 2 (section 16 there). It builds on
stage 2a (`.superpowers/specs/2026-10-11-clots-stage-2a-pipeline-design.md`). Plan:
`.superpowers/plans/2026-10-12-clots-stage-2b-rulebook.md`.

## 1. What 2b delivers

The user tells a Clot "ignore Dependabot PRs" and a rule takes effect, without
opening a file.

A Clot can suggest a rule. Nothing it suggests applies without the user's yes,
given to the daemon in a temporary channel.

A standing rule lets a Clot post one pre-approved comment on GitHub while it
investigates an event.

An optional home Clot receives events from repositories no Clot is bound to.

`&rules` lists the rules in force, and `&rules undo` steps back through the edits
made from chat.

GitHub is still the only source.

## 2. Where 2b sits in the parent design

2b builds these parts of the parent design, and is where each is specified in
full:

- **Editing the rulebook from chat** (parent section 5): which edits apply at
  once and which need the user's yes, decided by the daemon (section 5 here).
- **Daemon tools** (parent sections 2 and 7): the first tools that run in the
  daemon process, outside the container (section 4 here).
- **Standing rules and `send_from_template`** (parent section 5), with a GitHub
  comment as the one way of sending (section 7 here).
- **The home Clot** (parent sections 1 and 5), in section 9 here.
- **The `&rules` command** (parent section 6), in section 8 here.

## 3. The rule file

`global.yaml` applies to every Clot, `<clot>.yaml` to one, and `home.yaml` to the
home Clot. A file holds three lists:

```yaml
prefilters:
  - actor: dependabot[bot]
triage:
  - Typo fixes in docs need no action.
standing:
  - name: ack-issue
    trigger: { kind: issue_opened }
    via: github_comment
    template: "Thanks for the report, @{actor}. I'm looking into it."
```

- **`prefilters`**: a rule drops an event when every field it names matches:
  `kind`, `actor`, `repo` (`owner/name`, case-insensitive) and `titleContains`
  (case-insensitive). A rule names at least one field.
- **`triage`**: a list of plain-language lines, passed to the triage call: the
  global lines, then the Clot's own. A file that holds a single block of text
  there is read as one line.
- **`standing`**: a list of standing rules.
  - `name`: lowercase letters, digits and hyphens. Unique within its file. When
    the global file and a Clot's own file both hold a name, the Clot's own rule
    is the one in force.
  - `trigger`: matched like a pre-filter, with the same fields. It must name a
    `kind`, one of the five a source produces; `batch` cannot be named.
  - `via`: how the message is sent. The one value in 2b is `github_comment`.
  - `template`: the exact text, at most 2,000 characters. It may use the fields
    `{actor}`, `{title}`, `{ref}`, `{repo}` and `{url}`, filled from the
    triggering event. Any other `{field}` makes the file invalid.

The files are still edited by hand as in 2a, reloaded when they change, and a
file that does not fit the schema leaves its last good version in force.

## 4. Daemon tools

Five tools, registered with the Agent SDK's `createSdkMcpServer` under the server
name `clots`. They run in the daemon process. The Clot's container holds neither
the rulebook nor a credential that can post under a standing rule, so the tools
are the only way to either.

| Tool | Does |
|---|---|
| `rulebook_show` | Returns the rules in force for this Clot (the global file, then its own) and its open proposals. |
| `rulebook_prefilter` | Adds or removes one pre-filter. |
| `rulebook_guidance` | Adds or removes one triage line. |
| `rulebook_standing` | Adds, replaces or removes one standing rule. Adding under a name the file already holds replaces that rule. |
| `send_from_template` | Sends under a standing rule (section 7). |

- **Built per turn.** Each turn gets its own set, which knows the Clot, the kind
  of turn, whether a steered event has joined it, and the event being
  investigated. The turn that writes a recap gets none.
- **The file is `own` or `global`.** A Clot cannot name another Clot's file.
- **Removing** names the rule exactly: a pre-filter by its fields, a line by its
  text, a standing rule by its name. Removing something that is not there is
  refused, and the tool says what the file holds.
- **Under the lock** all five are approved. Each enforces its own limits, and an
  edit made in a locked turn is never applied by the Clot (section 5).

## 5. Applied or proposed

The daemon decides whether an edit is applied or put to the user. The Clot cannot
choose.

| Edit | A working turn the user started, with no steered event in it | Any other turn |
|---|---|---|
| A pre-filter or a triage line, in the Clot's own file | Applied at once | Proposal |
| Anything in `global.yaml` | Proposal | Proposal |
| A standing rule: added, replaced or removed | Proposal | Proposal |

"Any other turn" is an investigation, a brainstorm turn, and a working turn from
the moment a steered event has joined it. These are the turns that are locked, or
that hold untrusted text the user did not write. A turn that picks up a working
turn which was cut off, by the usage limit or by a restart, after a steered event
had joined it, is still such a turn: the daemon keeps that fact with the session
until a turn of the user's own has ended without being cut off. An investigation
that runs in between does not end it.

### Applying an edit

1. The file is changed through the YAML library's document form, so comments and
   everything written by hand stay as they were.
2. The result is checked against the schema before it is written. A file that is
   already invalid is not edited: the tool says what is wrong with it.
3. The file is written, the rulebook is reloaded, and the change is committed in
   the rulebook's own repository with a message that names the Clot and the rule.
   Whatever else the file held uncommitted goes into the same commit. A commit
   that fails does not undo the edit.
4. The daemon posts the resulting rule in the Clot's live channel. The Clot does
   not write that message.
5. The edit is logged with its inverse, for `&rules undo` (section 8).

Edits are applied one at a time across all Clots: several can change
`global.yaml`.

### When a Clot suggests a rule

The Clot's system prompt tells it:

- to use the tools when the user asks for a rule, and to say a rule is in force
  only when the tool has said so;
- to suggest a rule the user did not ask for only on a clear pattern: the user
  has dismissed or ignored the same kind of event more than once, or has stated
  a standing preference ("I never care about X"). It gives the reason in one
  line;
- not to suggest a rule the first time an event looks ignorable, and never to
  propose again what the user declined.

### Known limit

The line is drawn by the kind of turn, not by what the session has read. A working
turn the user starts still has earlier events in its context, so a Clot misled by
one of them could add a pre-filter to its own file while the user was asking for
something else. The user sees the rule posted at once and can remove it with
`&rules undo`. The global file and standing rules are out of its reach either way.

## 6. Proposals

A proposal is put to the user the way a steering question is (2a section 8).

1. The daemon creates a temporary channel in the Clot's category, named
   `<clot>-rule`, then `<clot>-rule-2` and so on while others are open.
2. It posts there, mentioning the user: the file, and the exact edit. For a
   standing rule that is its name, its trigger, its template and where it sends;
   for a replacement, the rule as it is and as it would be. Then the replies it
   accepts.
3. The tool call returns at once and tells the Clot the user will be asked. The
   Clot does not wait.
4. The user's reply in that channel is lowercased, stripped of punctuation and
   surrounding space, and compared exactly:

| Reply | Outcome |
|---|---|
| `yes`, `sure`, `do that`, `yeah` | Applied, as in section 5 |
| `no`, `dont`, `not at all` | Declined |
| anything else | The question is repeated in the same channel, with the accepted replies |

5. The outcome is posted in the Clot's live channel, the temporary channel is
   deleted, and a note is stored for the Clot.

Rules:

- **The reply never reaches the model.** It is an answer to the daemon.
- **Notes.** A note is one line: what was proposed and what the user decided, or
  which edit the user undid with `&rules undo`. The
  notes waiting for a Clot are placed in front of its next turn, whatever starts
  that turn, and are cleared when that turn ends without an error. A note starts
  no turn.
- **A proposal lasts as long as its session.** When the session is closed or
  rolls over, its open proposals are closed as unanswered: channel deleted, and
  one note that lists them for the new session. All of them are closed in one
  step, before any channel is deleted, and a proposal records the session it was
  opened in: one that a stopped daemon left behind from a replaced session is
  closed at startup, and a reply to it that arrives first closes it as
  unanswered instead of answering it. A session started with nothing carried over gets no note,
  also when the user discards the recap of a session that has not started.
- **A limit on open proposals per Clot.** It is three unless
  `maxProposals` in `clots.config.json` sets another number. One more is refused, and
  the Clot puts the suggestion in its reply instead.
- **Not asked twice.** A proposal identical to an open one is not opened again;
  the tool says it is already with the user.
- **Stored.** Open proposals survive a restart of the daemon and can still be
  answered. One whose channel no longer exists is closed as unanswered at
  startup. The channel is told by its ID, not its name; when the daemon cannot
  find out whether it exists, the proposal stays open.
- **An answer stands.** Each proposal is closed exactly once, by whoever gets to
  it first.
- **Checked again when applied.** A yes applies the edit to the file as it is
  then. If it no longer fits (the rule was removed by hand, the file became
  invalid), nothing is changed, the user is told in the live channel, and the
  Clot gets a note.
- **When the file cannot be written.** A yes whose edit fails on the disk, with
  the file untouched, leaves the proposal open: the daemon says so in its
  channel and the user can answer again.

## 7. Standing rules

A standing rule lets the Clot send one message without asking. It is a trigger,
an exact template and a way of sending. Adding, replacing or removing one always
needs the user's yes (section 5).

### When a rule applies

When an investigation starts, the daemon checks the event against the standing
rules in force for that Clot, as they are at that moment. Each rule that matches
is named in the investigation's prompt with its filled-in text, and the Clot is
told it may send it or leave it. When none matches, the prompt says nothing about
standing rules.

A `batch` matches a rule when any of the reports it was made from matches the
trigger. The template is filled from the earliest report that does.

### Sending

The Clot calls `send_from_template` with the rule's name and, if it wants to
adjust the wording, its own text. The daemon checks, in this order, and refuses
with the reason at the first that fails:

1. The turn is an investigation, and the rule is in force and matches the event
   that turn was started for. A working turn, a brainstorm turn and an event
   that was steered into a turn cannot send.
2. The event is about an issue or a pull request. One about a branch has nowhere
   to send.
3. This rule has not been sent for this event before.
4. The text, when given, differs from the filled-in template by at most five
   words.

Then it sends the text and records the send. The Clot never names where a message
goes: a `github_comment` is posted, with the Clots' token, on the issue or pull
request the event is about.

### Counting words

- The template is filled in first. Filled-in values never count.
- Both texts are split into words at white space. Each word added, removed or
  replaced counts one; the count is the smallest number of such changes that
  turns one text into the other.
- Case and punctuation attached to a word are part of the word.
- Six or more is refused, and the tool tells the Clot the count.

### Mentions

An `@` makes GitHub notify someone only where the template itself wrote it. With
the template `Hello, @{actor}`, the person who opened the issue is mentioned. An
`@` inside a filled-in value (a title is the reporter's text), or in a word the
Clot added or replaced, is written so that it mentions nobody.

### Rules that keep a send from repeating or going astray

- **Once per rule and event.** The send is recorded before the comment is
  posted, and the record is removed only when GitHub definitely refused the
  comment. A daemon that stops in between has lost a send; it has never sent one
  twice.
- **An investigation that is picked up again keeps its event.** After a
  usage-limit pause, the turn that continues is tied to the same event, so the
  record still holds.
- **The user sees every send.** The daemon posts a line in the Clot's live
  channel: the rule, the text and a link to the comment.
- **The Clot's own comment produces nothing.** It comes back from GitHub as an
  event caused by the Clots' account and is dropped as self-caused.

### Ways of sending

Sending sits behind one interface: given the event and the final text, send it
and return a link. `via` picks the implementation. 2b has one, the GitHub
comment; later sources add theirs without changing rules that already exist.

## 8. The `&rules` command

Both forms are handled by the daemon at once, as `&effort` is, and never reach
the model. They work while a turn is running.

| Command | Effect |
|---|---|
| `&rules` | Lists the rules in force for this Clot: pre-filters, triage lines and standing rules, each marked with its file, and the Clot's open proposals. |
| `&rules undo` | Reverts the most recent edit made from chat through this Clot, and shows what it reverted. |

- **What undo covers:** edits that came through this Clot, to its own file or the
  global one, applied directly or through a proposal. Edits made by hand are not
  logged and are not undone.
- **Stepping back:** each `&rules undo` reverts the latest edit not yet undone.
  An undo is not itself undone.
- **No further yes.** The command is the user's own, so it applies at once, also
  when it restores a standing rule or changes the global file.
- **When the file has changed since:** if the inverse no longer fits, the command
  says so, changes nothing, and that edit is skipped by the next undo. The
  inverse of a standing rule's edit names the rule it expects to find, so it does
  not fit once the rule has been replaced, removed or added again by anyone
  else, another Clot included.
- **When the file cannot be written:** the command says so, changes nothing, and
  the same edit is still the next one to undo.
- **When an edit cannot be logged:** the edit stands, and the user and the Clot
  are told that undo is not available yet. The daemon keeps the record and
  saves it as soon as it can; until then `&rules undo` changes nothing, so that
  it never reverts an older edit in place of the latest.
- An undo is written, committed and posted like any other edit.
- **The Clot is told.** The command does not reach the model, so an undo leaves a
  note for the Clot (section 6): the rule is no longer in force, and what the user
  said when asking for it no longer applies. Without it the Clot would go on
  acting on a request it still remembers.

## 9. The home Clot

- **Optional.** `"home": true` in the configuration creates it. A project Clot
  cannot be named `home` or `global`.
- **A Clot like any other:** a category, sessions, the container `clot-home`, the
  rule file `home.yaml`, commands, brainstorm mode, the lock.
- **No repository of its own.** Nothing is cloned for it, it has no test command,
  and its turns start in `/workspace`.
- **What reaches it:** an event for a repository no Clot is bound to. Without a
  home Clot such an event is logged and discarded, as in 2a. The repository
  needs the same webhook and secret, and the Clots' account as a collaborator.
- **What it can do:** it investigates through `gh` and the web. After the user's
  go-ahead it may clone the repository into its workspace and work through to a
  pull request, like any Clot.
- **Its system prompt** says it serves what belongs to no project, and names no
  repository.
- **Holding automated events:** a group is formed by Clot, repository and
  subject. `pr:14` in two repositories is two groups.
- **Global memory** is the home Clot's other role: it alone writes the memories
  every Clot shares, which spread after the user's yes. That part is built on top
  of 2b, with its own specification
  (`.superpowers/specs/2026-10-14-clots-global-memory-design.md`) and plan. In 2b
  the home Clot keeps only its own memory, as every Clot does.

## 10. Components

| Component | Responsibility | Depends on |
|---|---|---|
| Rulebook (changed) | Reads the three lists; answers which standing rules match an event. | Rule files |
| Rule editor | Applies one edit to a rule file's YAML document and returns the new text, the inverse edit and a one-line description. Pure. | None |
| Rule writer | Validates, writes, reloads, commits and logs an edit; one at a time. | Rule editor, rulebook, store, git |
| Proposals | Opens, answers and closes proposals; stores notes. | Chat adapter, store, rule writer |
| Standing | Fills a template, counts changed words, defuses mentions. Pure. | None |
| Sender | Sends a text for an event and returns a link. One implementation: a GitHub comment. | The Clots' token |
| Daemon tools | The five tools as plain functions over a turn's context, wrapped for the SDK. | All of the above |
| Clot (changed) | Gives each turn its context; marks a turn a steered event has joined; puts notes in front of a turn; closes proposals with the session; answers `&rules`. | Daemon tools, proposals |
| Runner (changed) | Passes a turn's tools to the session; approves them under the lock; starts a turn in the Clot's working directory. | Agent SDK |
| Pipeline (changed) | Routes an unbound repository's event to the home Clot. | None |
| Hold (changed) | Groups by Clot, repository and subject. | None |
| Container (changed) | Prepares a container with no clone for the home Clot. | Docker |

## 11. Failure handling

- **The temporary channel cannot be created:** the tool says the user could not
  be asked, and the Clot puts the suggestion in its reply.
- **The proposal's question cannot be posted:** the proposal is closed, its
  channel is deleted, and the tool tells the Clot the user could not be asked.
- **An approved proposal no longer fits the file:** section 6.
- **The rule file is invalid when an edit arrives:** the edit is refused with the
  problem; nothing is written.
- **The rule file cannot be read or written:** nothing is changed. The tool says
  so; an approved proposal stays open and an undo stays the next one (sections 6
  and 8).
- **The commit fails:** the edit stands, and the failure is logged.
- **GitHub refuses the comment, or cannot be reached:** the tool returns the
  failure and the Clot says what it could not send. The record of the send is
  removed only on a definite refusal.
- **Daemon restart:** open proposals, notes, the edit log and the record of sends
  are stored. Nothing is applied or sent twice.

## 12. Testing

- Unit tests: each edit and its inverse on a YAML document, including comments
  and hand-written parts surviving; the schema, with a single block of triage
  text and with an unknown template field; the applied-or-proposed table;
  matching a trigger, for an event and for a batch; filling a template; counting
  words, as a table of pairs with their counts; mentions; the replies a proposal
  accepts; parsing `&rules`; naming the temporary channel.
- With the stage 1 and 2a fakes, and a fake runner that calls a turn's tools
  while the turn runs: every cell of the table in section 5; a turn that a
  steered event joined; the life of a proposal, with each reply, the limit, a
  repeated proposal, a session closing and a restart; notes reaching the next
  turn; each refusal of `send_from_template`; a send recorded once across a
  failure; each step of `&rules undo`; an unbound repository with and without a
  home Clot; two repositories with the same subject in the hold.
- Live checks at the end, as in stage 1.

## 13. Done when

In the development environment:

- "ignore Dependabot PRs" produces a posted rule, a matching event is dropped
  without a restart, and the rulebook's repository has a commit for it;
- `&rules` lists the rule, `&rules undo` removes it, and a second undo reverts
  the edit before it;
- a triage line added from chat changes what triage decides about a matching
  event;
- a comment written by hand in a rule file is still there after an edit from
  chat;
- a rule the Clot suggests during an investigation opens a temporary channel,
  and yes and no each do what section 6 says;
- the same request made while brainstorming, and any edit to the global file,
  produce a proposal;
- a declined proposal is known to the Clot on its next turn, and an unanswered
  one is closed when the session closes;
- with the limit at three, a fourth proposal is refused while three are open;
- a standing rule asked for in chat still needs the user's yes; after it, a new
  issue gets the comment once, with the reporter mentioned when the template
  says so, and the comment's own event produces nothing;
- a send with six changed words, a send under a rule whose trigger does not
  match, and a send from a working turn are each refused;
- a pull request whose reports arrive as a batch triggers a rule that matches one
  of them;
- an issue on a second repository that has a webhook and no Clot is investigated
  in the home Clot's channel.

## 14. Not in 2b

Routing match rules and routing corrections, every source other than GitHub, ways
of sending other than a GitHub comment, a fixed destination on a standing rule,
sends the daemon makes without the Clot, urgency markers, watch recipes, gates,
the sweep, global memory.

## 15. Assumptions to verify first

- A tool defined in the daemon process with `createSdkMcpServer` can be called by
  a session whose Claude Code process runs inside the container.
- In a locked turn, the hook that is asked before every tool call sees a daemon
  tool by its name and can let it through, and the call then runs.
- A session that is resumed accepts a new set of tool handlers on each turn.
- The Clots' token can post a comment on an issue and on a pull request of a
  repository its account collaborates on, and the comment's event names that
  account as its actor.
- The YAML library keeps a file's comments through an edit of its document.

If any of these fails, stop and bring the finding to the user before continuing.
