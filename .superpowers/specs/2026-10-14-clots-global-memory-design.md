# Clots: global memory

Date: 2026-10-14
Status: implemented.
Parent design: `.superpowers/specs/2026-10-10-clots-design.md`. Builds on stage 2b
(`.superpowers/specs/2026-10-12-clots-stage-2b-rulebook-design.md`), which brought
the home Clot and proposals. Plan: `.superpowers/plans/2026-10-14-clots-global-memory.md`.

## 1. What it delivers

The user tells the home Clot "remember for every project that I deploy on
Fridays only", and after the user's yes every Clot knows it. That holds for Clots
that already exist and for ones added later.

`global.yaml` already does this for rules. Global memory does it for what a Clot
remembers.

## 2. Where a Clot's memory lives

A Clot's memory is Claude Code's own auto memory, inside its container's home
volume:

- `/home/clot/.claude/projects/-workspace/memory/` for the home Clot, whose turns
  start in `/workspace`;
- `/home/clot/.claude/projects/-workspace-repo/memory/` for a project Clot, whose
  turns start in `/workspace/repo`.

Each folder holds one file per memory and a `MEMORY.md` index. A session sees the
index, and reads a memory file only when an index line makes it relevant. The
Clot writes and rewrites both itself. Each turn starts a new Claude Code process
that resumes the session, and that process reads `MEMORY.md` again: an index
changed between two turns is what the second turn sees.

The folders, the files and the user they belong to (`clot`, the container's
default user, which `docker exec` also runs as) were checked in the development
containers, and the reading of the index with `scripts/spike-memory.ts`.

The volumes are separate per container, so nothing can be shared by a link. The
daemon copies files into each container with `docker exec`.

## 3. Global memories

- **Only the home Clot writes them.** A global memory is a file in the home
  Clot's memory folder named `global-clot-<topic>.md`, the topic in lowercase
  letters, digits and hyphens, written in the usual memory format (front matter
  with `name`, `description` and `type`, then the text). A file named any other
  way is not a global memory, and the daemon leaves it alone.
- **When it writes one:** when the user asks it to remember something for every
  project, or on its own when it learns something that clearly applies to all of
  the user's work: a preference, an account, a way of working. Never a fact about
  one project.
- **Project Clots are read-only.** They have no tool for suggesting one. A file
  named `global-clot-…` that a project Clot writes itself is removed at its next
  sync (section 6).
- **Nothing spreads without the user's yes**, except a deletion (section 5).
- **The daemon keeps the approved set:** for each file name, the text the user
  approved. This set, held in the daemon's store, is what is in force. The home
  Clot's folder is where changes come from; it is not the record.

## 4. Noticing a change

After every home Clot turn, and once at startup, the daemon reads the
`global-clot-*.md` files in the home Clot's folder and compares each with the
approved set and with the open questions (section 5).

| Home Clot's folder | Approved set | Open question for the file | Daemon does |
|---|---|---|---|
| Same text as approved | present | none | nothing |
| Same text as approved | present | yes | withdraws the question |
| Different text | either | none | asks the user (a new memory, or a change) |
| Different text | either | yes, about other text | updates the question in its channel |
| Different text | either | yes, about this text | nothing |
| Missing | present | either | removes it everywhere (a deletion) |
| Missing | absent | yes | withdraws the question |

- Locked turns cannot write files, so only a working turn of the home Clot can
  produce a change.
- **Withdrawn** means the channel is deleted and one line is posted in the home
  Clot's live channel.
- **When the folder itself is missing** (a new volume, for example), nothing is
  deleted: the daemon writes the approved files back into it.
- **When the folder cannot be read**, the check is skipped and tried again after
  the next home Clot turn.

## 5. The user's answer

### A new memory or a change

A question is put to the user the way a rule proposal is (2b section 6):

1. The daemon creates a temporary channel in the home Clot's category, named
   `home-memory`, then `home-memory-2` and so on while others are open.
2. It posts there, mentioning the user: the file's name and its full text. For a
   change, the approved text first and then the new one. Then the replies it
   accepts.
3. Replies are matched exactly as for a rule proposal: `yes`, `sure`, `do that`,
   `yeah`; `no`, `dont`, `not at all`; anything else repeats the question. The
   reply never reaches the model.
4. **Yes:** the text becomes the approved one and is logged for `&memory undo`.
   Every Clot gets it at its next sync, with a note. The home Clot's live channel
   gets one line.
5. **No:** the approved set is unchanged. The daemon puts the home Clot's copy
   back to the approved text, or removes the file when it is new, and leaves the
   home Clot a note: what was declined, and not to write it again unless the user
   asks.
6. The channel is deleted.

Rules:

- **One question per file.** When the home Clot changes a file again before the
  user has answered, the daemon posts the new text in the same channel, and the
  answer applies to that text.
- **At most three open questions**, or the number in `CLOTS_MAX_PROPOSALS`. These
  are counted apart from rule proposals. A changed file that finds the limit
  reached is asked about when an earlier question closes.
- **Questions do not end with the session.** Unlike a rule proposal, a question
  is about a file that is still there, so it stays open across a rollover or
  `&close` of the home Clot's session. It survives a daemon restart. When its
  channel is gone at startup, the question is closed and the next check asks
  again.

### A deletion

When the home Clot removes a `global-clot-` file, the deletion is applied at once:
the file is dropped from the approved set and logged for `&memory undo`. Every
Clot loses it at its next sync, with a note. The home Clot's live channel gets one
line: the memory removed and that `&memory undo` brings it back.

## 6. Delivering to a Clot

Before each of a Clot's turns starts, the daemon syncs that Clot's memory folder
with the approved set, in one `docker exec`:

- writes every approved file that is missing or differs;
- removes every `global-clot-*.md` file that is not in the approved set;
- rewrites the daemon's block in `MEMORY.md` (below).

The home Clot is synced too, with one difference: its `global-clot-` files are
left alone, since they are where changes come from. Only the block is rewritten,
and the copies the user declined or undid are put back (section 5 and section 7).
All of this waits until no home Clot turn is running.

A sync that fails is logged, the turn runs anyway, and the next turn tries again.

### The daemon's block in `MEMORY.md`

```
<!-- clots: global memories, kept by the daemon. Do not edit. -->
- [Deploy days](global-clot-deploy-days.md) — the user deploys on Fridays only
<!-- clots: end of global memories -->
```

- One line per approved file: the `name` from its front matter (the file name
  when there is none), and its `description`.
- The two comment lines mark the block for the daemon. A session is not shown
  them, only the lines between; what the Clot must not touch it learns from its
  system prompt (section 8).
- **At the top of the file**, so it is always inside the part of `MEMORY.md` a
  session reads.
- **The Clot's own lines are never touched.** The daemon removes its block,
  wherever the Clot has moved it, and any line outside the block that links to a
  `global-clot-` file. It then writes the block at the top again. A Clot that
  edits or deletes the block gets it back at its next sync.
- With no approved files, no block is written.
- When `MEMORY.md` does not exist yet, the daemon creates it with the block.

### Notes

Each change that spreads (an approval, a deletion, an undo) leaves a note for
every Clot, in front of its next turn (2b section 6): the memory's name and
whether it was added, changed or removed. The index shows what is in force; the
note says what changed, so a Clot that has been acting on a memory knows it was
changed or removed.

## 7. The `&memory` command

Both forms work in any Clot's live channel, are answered by the daemon at once,
also during a turn, and never reach the model.

| Command | Effect |
|---|---|
| `&memory` | Lists the approved global memories, one line each with its `description`, and the files waiting for the user's answer. |
| `&memory undo` | Reverts the most recent change that spread, and shows what it reverted. |

- **What undo covers:** every approval and every deletion, from one log for all
  Clots. Each `&memory undo` reverts the latest change not yet undone. An undo is
  not itself undone.
- **Its effect:** an approved addition is removed, an approved change goes back
  to the text before it, a deletion is restored. The home Clot's copy is put back
  to match, between its turns, so the next check does not ask again. Every Clot
  gets the change at its next sync, with a note; the home Clot's note says the
  user undid it and not to write it again unless asked.
- **No further yes.** The command is the user's own.
- **Refused while the file has an open question:** the command says to answer
  that question first and changes nothing. Undoing it would discard what the home
  Clot wrote since.

## 8. What the Clots are told

**Every project Clot**, in its system prompt: memory files named
`global-clot-…` come from the user through the home Clot and apply to all
projects. Do not edit, rename or remove them, do not change the block the daemon
keeps at the top of `MEMORY.md`, and do not add index lines for them. If one
seems wrong or out of date, tell the user.

The user accepts that this is an instruction only. A project Clot that breaks it
changes nothing beyond its own folder, and the next sync undoes it.

**The home Clot**, in its system prompt instead:

- when to write a global memory (section 3), in the usual memory format, under a
  name `global-clot-<topic>.md`;
- not to add it to `MEMORY.md` itself, nor to change the daemon's block there: the
  daemon lists it once the user has said yes;
- that the user is asked before it spreads, so it says a global memory is in
  force only when a note has said so;
- that deleting the file removes it from every Clot at once.

**When the Clots learn it.** A session keeps the system prompt it was started with,
also when a later turn resumes it. What this section adds therefore reaches a Clot
at its next new session, not at its next turn. After an update that changes the
system prompts, the user runs `&close` in each Clot's channel. The global memories
themselves do not wait for that: the sync and the notes reach every session.

## 9. Components

| Component | Responsibility | Depends on |
|---|---|---|
| Memory index | Given a `MEMORY.md` text and the approved files, returns the text with the daemon's block in place. Pure. | None |
| Memory compare | Given the home Clot's files, the approved set and the open questions, returns what to do (section 4). Pure. | None |
| Memory folder | Reads and writes one Clot's memory folder through `docker exec`. | Docker |
| Global memory | Checks after home Clot turns, asks the user, applies answers, syncs before turns, answers `&memory`. | All of the above, store, chat adapter |
| Store (changed) | The approved set, open questions, the change log, and the home Clot copies waiting to be put back. | SQLite |
| Clot (changed) | Awaits a sync before each turn; answers `&memory`. | Global memory |
| Commands (changed) | Parses `&memory` and `&memory undo`. | None |
| Prompts (changed) | What section 8 says. | None |

## 10. Failure handling

- **The home Clot's folder cannot be read:** the check is skipped, and runs again
  after the next turn.
- **The question's channel cannot be created or its post fails:** nothing is
  stored, and the next check tries again.
- **A sync fails:** logged; the turn runs; the next turn's sync tries again.
- **Putting back the home Clot's copy fails:** kept, and tried again after its
  next turn.
- **Daemon restart:** the approved set, open questions, the log and the copies
  waiting to be put back are stored. Nothing is asked or applied twice.

## 11. Testing

- Unit tests: the block written into an empty file, a file with the Clot's own
  lines, a file whose block was moved or edited, and a file with stray
  `global-clot-` lines; front matter with and without `name` and `description`;
  each row of the table in section 4; parsing `&memory`.
- With the stage 1, 2a and 2b fakes and a fake memory folder: a new memory asked
  about, approved and synced to two Clots with notes; a no putting the home Clot's
  copy back; a second change while a question is open; the limit; a deletion; a
  missing folder; each step of `&memory undo`, and undo refused while a question is
  open; a question kept across a home session rollover and a restart; a project
  Clot's own `global-clot-` file removed.
- Live checks at the end, as in stage 2b.

## 12. Done when

In the development environment, with the home Clot and `encryptify`:

- asking the home Clot to remember something for every project opens a
  `home-memory` channel with the file's text;
- after yes, `encryptify`'s memory folder holds the file and its `MEMORY.md`
  starts with the block, and its next turn knows the memory;
- after no, the home Clot's file is gone and the home Clot knows it was declined;
- the home Clot deleting a global memory removes it from `encryptify` at once,
  and `&memory undo` brings it back;
- `&memory` lists what is in force in both Clots' channels;
- a `global-clot-` file written in `encryptify`'s folder by hand is gone after its
  next turn, and an edited block is restored.

## 13. Not in this part

A tool for project Clots to suggest a global memory; editing global memories by
hand outside the home Clot; keeping them in the rulebook's git repository; a size
limit on a memory file; global memories without a home Clot. With `"home": false`
nothing new is written, and memories approved earlier stay in force and can still
be undone.

## 14. Checked before building

These were confirmed on 2026-10-14, in the development containers and with
`scripts/spike-memory.ts` (a throwaway container, the daemon's own runner):

- Auto memory is on in the sessions the daemon starts: `encryptify` had written
  its own memories into `-workspace-repo/memory/`, and the home Clot's container
  has an empty `-workspace/memory/`.
- `docker exec` runs as `clot`, the user that owns those folders.
- A new session sees the lines of `MEMORY.md` (not its comment lines), and a line
  in the daemon's block led it to read the file and answer from it.
- A resumed session sees a block the daemon rewrote between its turns, and says
  that it changed.
- A resumed session keeps the system prompt it was created with: a session started
  with one appended prompt and resumed with another still quoted the first.
