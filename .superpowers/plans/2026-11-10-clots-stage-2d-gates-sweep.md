# Clots stage 2d: gates, digests, spend log, sweep and re-grounding — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. This plan gives structure and decisions, not code. You write the implementation (TDD per task). Track tasks with the checkboxes. After all tasks, run the **Manual Verification Checklist** (or hand it to the user if they asked to do it), then fill in **Implementation Notes**.

**Goal:** The Clots step back during the user's own hours and when the five-hour window runs high, deliver what waited as one digest, log what every model call costs, sweep the claude.ai connectors every 90 minutes, and re-ground each new session after a rollover.
**Specs:** `.superpowers/specs/2026-11-10-clots-stage-2d-gates-sweep-design.md`; parent `.superpowers/specs/2026-10-10-clots-design.md` (sections 6, 8, 9).
**Architecture:** A pure gate function decides "run or wait, until when" from the time, the configured windows and the usage meter's five-hour reading. A one-minute daemon ticker refreshes the meter, notices gate changes and pokes every Clot's drain and the worker queue, and runs the sweep when it is due. The sweep and re-grounding are one-off sessions run by a new runner method with structured output, a lock that also allows read-only connector tools, a time limit and transcript deletion. Spend is booked from the SDK's `total_cost_usd` into a store table.
**Tech Stack:** TypeScript on Node, `@anthropic-ai/claude-agent-sdk` (^0.3.296), better-sqlite3, zod 4, vitest.

## Global Constraints

- Open Docker Desktop before any work, and check that `docker info` succeeds.
- Development environment: the local one (parent section 15). If the user says this session runs in a Claude Code cloud environment, first measure CPU, memory, disk and whether Docker can start a container, compare with what one Clot needs (the daemon, one container running Claude Code, a project build, Chromium), and stop and tell the user if it falls short.
- Models: sweep and re-grounding are Opus 5.5 (`OPUS` in `src/models.ts`) at `low` effort.
- Times are in `config.timeZone`. Week starts Monday 00:00 in that zone.
- No new npm dependencies.
- Spec and plan describe the design as built: when the build changes a decision, edit them in place, with no change notes.
- `src/commands.ts` and `tests/commands.test.ts` are stored with CRLF; keep them that way.
- Commit once at the end (Task 8), on branch `stage-2d`. Do not push.

## File Map

- `src/gates.ts` (create): windows parsing, `gateAt`, `mayRunUnderGate`, `describeGate`. Pure.
- `src/usage-meter.ts` (create): the five-hour and seven-day readings.
- `src/spend.ts` (create): booking, the weekly warning, `&spend`'s text.
- `src/sweep.ts` (create): the Sweeper, the sweep schema and prompt, `findingEvents`.
- `src/reground.ts` (create): the re-grounding run and its schema and prompt.
- `src/digest.ts` (create): a digest turn's prompt text. Pure.
- `src/config.ts` (modify): `gates`, `sweep`, `spend`.
- `src/agent/usage.ts` (modify): `RateLimitState` gains `type`; utilization normalised to percent.
- `src/agent/runner.ts` (modify): `onRateLimit` option, `totalCostUsd` on results, `readUsage()`, `runOneOff()`.
- `src/agent/command-check.ts` (modify): `lockDecision` takes an optional set of allowed connector tools.
- `src/agent/container.ts` (modify): `deleteSession(container, id)`.
- `src/agent/prompts.ts` (modify): system prompt lines, the tight-usage line, digest wiring in `buildPrompt`.
- `src/store.ts` (modify): inbox `gated`, `merged` status, `digest` kind, `digests` table, worker `gate_ok`, `spend` and `session_costs` tables, sweep transaction.
- `src/clot.ts` (modify): gate in `queueEvent` and `drain`, digest turns, tight line, re-grounding in `handoff`, `&spend`, booking main-session spend.
- `src/workers.ts` (modify): gated starts, `wake()`, booking worker spend.
- `src/tools.ts`, `src/agent/tool-server.ts` (modify): `gateOk` on start; `send_from_template` takes `event` in a digest.
- `src/triage.ts`, `src/router.ts`, `src/routing-call.ts` (modify): report each call's cost.
- `src/events/kinds.ts`, `src/rulebook.ts` (modify): `sweep` source, `finding` kind.
- `src/commands.ts` (modify): `&spend`.
- `src/daemon.ts` (modify): wire the meter, gate, ticker, spend log, sweeper, re-grounder.
- `scripts/spike.ts` (modify, Task 1 only): probes.
- `README.md`, `clots.config.example.json` (modify): the new keys and `&spend`.
- Tests: `tests/gates.test.ts`, `tests/usage-meter.test.ts`, `tests/spend.test.ts`, `tests/sweep.test.ts`, `tests/reground.test.ts`, `tests/digest.test.ts` (create); extend `clot.test.ts`, `workers.test.ts`, `config.test.ts`, `commands.test.ts`, `command-check.test.ts`, `tools.test.ts`, `rulebook.test.ts`, `store.test.ts`, `prompts.test.ts`.

## Key Decisions & Gotchas

- **The gate never covers the usage limit.** Gate 1 is the existing pause (`pausedUntil` on the Clot, `pausedUntil` in `Workers`). `gateAt` only answers scarce and lead-in. Code that asks "does any gate hold" (the sweep) checks both.
- **Gate 3 is stateless.** It holds while `now` is inside a lead-in window and the five-hour reading is at or above `leadInPercent`. `UsageMeter.fiveHour()` returns `undefined` once `now >= resetsAt`, so a reset lifts the gate by itself.
- **`until`.** Collect the candidate times after `now`: every window start and end over the next 8 days, plus the five-hour `resetsAt`. Walk them in order and return the first `t` at which `gateAt(t, …, readingIfStillValidAt(t))` holds nothing. Assume a reading stays as it is until its reset. With the defaults, a held lead-in therefore reports 18:00 when the reset comes after 15:00.
- **One ticker, no per-Clot gate timers.** `daemon.ts` runs `setInterval` every 60 s, and the first tick runs at startup after everything is ready. Each tick:
  1. refreshes the meter when `now` is inside a lead-in window and the five-hour reading is older than 5 minutes;
  2. computes `gateAt` and compares `holds` with the last tick's value; on a change (and at startup) it calls `kick()` on every Clot and `workers.wake()`;
  3. calls `sweeper.tick()`.

  Also call kick/wake when `meter.onChange` fires, because a rate-limit event can push the reading over the threshold mid-hour. One-minute resolution is enough.
- **Which inbox rows run under gate 2 or 3** (`mayRunUnderGate`):
  - always: `message`, `worker` and `choice` rows; `digest` rows (one exists only once its gate has lifted); resume rows (ids start with `resume-`), because they continue a cut-off turn;
  - an `event` row only when its event is `urgent` (`store.getEvent(row.eventId).urgent`).
- **Drain under a gate.** Today the drain takes `store.nextPending()`. Replace that with `store.pendingRows(clot)` in rowid order:
  - run the first row that may run;
  - mark every event row it skips as `gated = 1`;
  - when no gate holds and gated rows are pending: two or more become a digest (below), and a single one has its flag cleared and runs as normal.

  Keep "one drain at a time" and the pause check as they are.
- **Notice of a waiting event.** In `Clot.queueEvent`, when the gate holds and the event is not urgent:
  - store the row with `gated = 1`;
  - append ` (waiting until HH:MM)` to the notice, before the link, with `HH:MM` in `timeZone`;
  - when `until` is on another day, write `(waiting until Mon 10:00)`.

  Events queued before the gate started are marked by the drain and keep their original notice.
- **Digest storage.**
  - `InboxKind` gains `"digest"` and `InboxStatus` gains `"merged"`.
  - Table `digests (digest_id TEXT, event_id TEXT, position INTEGER)`.
  - `store.makeDigest(clot, rows)` runs in one transaction:
    - insert the inbox row `digest:<clot>:<first row id>` with kind `digest`, `eventId` set to the digest id, the first row's `channelId` and `receivedAt`, and `outsider` true if any row is;
    - insert the `digests` rows;
    - set the gated rows to `merged`.
  - The drain runs the new row at once, so it takes the place of the first. A restart in between leaves it at the end of the queue; that is accepted.
- **Resuming a digest.** A digest cut off by the usage limit resumes through the existing path: `setInterrupted(session, true, "digest", digestId, outsider)`, then the resume row carries kind `digest` and the digest id. `runDigestTurn` loads the events with `store.digestEvents(id)`. Handle the `digest` kind wherever `runEventTurn` and the interrupted kind are switched on.
- **Digest turn tools.**
  - `TurnContext` gains `digest?: ClotEvent[]`, with `kind: "event"` and `event: undefined`.
  - `send_from_template` gains an optional `event` argument, described as "The event's ID; required in a digest."
  - In a digest turn, `send` refuses when `event` is missing (`Refused: name the event, this turn holds several.`) and when the event is not in the digest (`Refused: that event is not in this turn.`). It then runs 2b's checks against that event.
  - Outside a digest, `event` is ignored.
  - Standing matches are computed per event with `standingFor`.
- **Digest prompt** (`src/digest.ts`):
  - a header line: `These events waited because usage was tight. Deal with each one: nothing to do, a reply, a choice, or work.`
  - then, per event: arrival time in `timeZone`, the ID, the triage one-liner, and `formatEvent(event)` wrapped exactly as `buildPrompt` wraps an event row's text;
  - then that event's standing rules, in the existing standing-rules block format, with `(event <id>)` after each rule name.

  `buildPrompt` takes the digest text in place of `text`, with `event: true`.
- **The tight-usage line.** While gate 2 or 3 holds, `buildPrompt` gets `tight` and puts this first:

  ```
  [Usage is tight right now (<scarce mode until 18:00 | the five-hour window is at 54%>). When you start a worker, choose one step cheaper than you otherwise would: Opus xhigh → Opus high, Opus high → Opus medium, Opus medium → Sonnet high, Sonnet high → Sonnet medium. Haiku stays as it is.]
  ```

  `describeGate` produces the part in angle brackets. Add it in every main-session turn builder: chat, event, worker or choice, and digest.
- **System prompt lines** (`CLOT_SYSTEM_PROMPT`):
  - `- During scarce hours, or when the account's five-hour usage runs high in the hours before, ordinary events wait and reach you later together, as one digest turn. Deal with each event in it; send_from_template then needs the event's ID.`
  - `- When a turn starts with a line saying usage is tight, follow it for every worker you start in that turn.`

  Resumed sessions keep their old system prompt, so the user must `&close` each Clot after the build (see the Manual Verification shared setup).
- **Worker gate.**
  - `workers.gate_ok INTEGER NOT NULL DEFAULT 0`. `tools.startSession` sets `gateOk = urgent || ctx.kind === "chat"`.
  - `WorkersDeps` gains `gate: () => GateState`. While it holds, `dispatch()` passes over queued workers with `!gateOk && !hasPlace(w)` and keeps the order. Workers that already have a place (follow-up turns) are never held.
  - Public `wake()` calls `dispatch()`.
- **Rate-limit events.**
  - `parseRateLimit` also returns `type` (`rate_limit_info.rateLimitType`).
  - Utilization: the SDK type does not say whether it is a fraction or a percentage. Task 1's probe decides. Write the answer into `toPercent` and into this note.
  - `RunnerOptions` gains `onRateLimit?: (s: RateLimitState) => void`, called for every event, not only `rejected`. `UsageMeter.observe` updates `five_hour` and `seven_day` and ignores the other types.
- **Reading usage on demand.** `ClaudeRunner.readUsage()`:
  - starts `query()` with an `InputQueue` that is never fed;
  - calls `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true })`, closes the queue and returns `{ fiveHour, sevenDay }`, with `resets_at` parsed from ISO 8601 to ms;
  - has a 20 s time limit and returns `undefined` on any failure.

  The meter calls it on the home Clot's runner, or the first Clot's. `refresh(maxAgeMs)` is single-flight.
- **Spend booking.**
  - `TurnResult.totalCostUsd` is the last `result` message's `total_cost_usd`.
  - `SpendLog.book({ clot, who, sessionId?, total })`:
    - with a `sessionId`, in one transaction: `delta = total >= last ? total - last : total`, then upsert `session_costs`;
    - without one, the cost is `total`;
    - skip a cost of 0 or less, and a result with no `totalCostUsd` (a turn that failed before its result): the next turn's increase covers it;
    - after booking, check the weekly warning.
  - `who` values: `main`, `regrounding`, `triage`, `worker:<id>`, `routing`, `sweep`. `clot` is the Clot's name, `daemon` for `routing`, `sweep` for `sweep`.
  - Book the recap turn as `main`. Book the router's call as `triage`, so it appears on "Triage and router". Triage, the router and the routing call already loop over messages; give each an `onCost?: (usd: number, clot: string | null) => void` dependency and add `clot` to the router's and triage's inputs.
- **Weekly warning.**
  - Key `spend-warned:<clot>:<weekStartMs>` in the state table, set only after the post succeeds.
  - Text: `<clot> has spent an estimated $52.10 this week, past the $50 warning. &spend shows where.`
- **`&spend` text** (exact layout; amounts to 2 decimals):
  ```
  Spend this week, since Mon 10 Nov 00:00. Estimated at API prices; on a subscription this is not a bill.
  encryptify: $12.40
  - Main session: $6.10
  - Re-grounding: $0.30
  - Triage and router: $0.40
  - Worker 1a2b3c4d "Fix login redirect" (Sonnet 5.5 high): $5.60
  All Clots: $20.15. Daemon: $0.12. Sweep: $1.30.
  Gate: scarce mode until 18:00.            (or: Gate: none.)
  Five-hour window: 54%, resets 16:20 (read 3 minutes ago). Seven-day window: 31%, resets Thu 09:00.
  ```
  - Without readings, the last line is `Usage reading unavailable.`
  - Lines with no spend are left out.
  - Before answering, `&spend` calls `meter.refresh(5 min)` with a 15 s ceiling.
  - Reuse `modelLabel` from `workers.ts` for the worker's model.
- **One-off sessions** (`ClaudeRunner.runOneOff`):
  - Request: `{ prompt, systemPrompt, model, effort, cwd?, schema, timeoutMs }`. A fresh `newSessionId`, no daemon tools, `outputFormat: { type: "json_schema", schema }`.
  - The lock is enforced exactly as for a main turn: the same hook, callback and removed tools. Pass `lockDecision` an extra `Set` of allowed connector tool names.
  - Build the set from `session.mcpServerStatus()` called right after `query()`: tools whose `annotations.readOnly === true`, named as the hook sees them (Task 1 records the exact naming). The hook awaits that promise, so it is ready before the first tool call. If the status call fails, the set is empty.
  - Result: `{ ok, output?: unknown (result.structured_output), totalCostUsd?, limit?, error? }`.
  - The time limit uses the query's abort controller and returns `{ ok: false, error: "timed out" }`.
  - In a `finally`, always call `deleteSession(container, sessionId)`, which removes `/home/clot/.claude/projects/*/<id>.jsonl` the same way `sessionExists` finds it.
- **Sweep runner.** The home Clot's runner if there is one, else the first configured Clot's; its `cwd` is `/workspace` (the home Clot's default; pass it explicitly for a project Clot).
- **Sweep schema** (zod, converted with `z.toJSONSchema`):
  `{ findings: [{ connector: string, item: string, title: string, body: string, url?: string, actor?: string }], record: string (max 8000) }`
  - Output that fails parsing counts as a failure.
- **Sweep prompt.**
  - The system prompt holds the instructions of spec section 6, "What it is given", including that connector content is data.
  - The user prompt holds:
    - the record, or `No record yet: record what is there and report nothing.`;
    - the Clots, as `name: about`, with home as `anything that belongs to no project`;
    - the skip list.
  - The skip list comes from the configuration: `GitHub`, then each source type that has accounts (`Stripe`, `Email (<addresses>)`, `Google Calendar`, `Linear`, `Notion`), then each `mcpServers` name.
- **Sweep timing and state.** The state keys are `sweep-last-start` (ms), `sweep-record`, `sweep-failures` and `sweep-failing-told`.
  - Due when `now - last-start >= everyMinutes`.
  - Skip when `!config.sweep.enabled`, when a sweep is running, when `gateAt` holds, or when any Clot or the workers are paused.
  - Set `last-start` before running.
- **Storing a sweep.** `store.recordSweep(record, events)` runs in one transaction: `insertEvent` for each, then the record. Then call `pipeline.handle` for each event newly inserted.
  - The first run (no stored record) stores the record and nothing else.
  - `findingEvents` is pure:
    - `id` is `sweep:<connector>:<item>:<sha256(title + "\n" + body) first 16 hex>`;
    - body and title are trimmed with the helpers in `src/events/body.ts`;
    - `receivedAt` is now;
    - `outsider` is false;
    - the other fields are as in spec section 6.
- **Sweep failures.** Use the failure counting and the told-once and told-recovered wording of `src/listeners.ts` if its supervisor can wrap a one-shot job. If it cannot, mirror it: tell after 3 failures in a row, in the home Clot's live channel or every Clot's, once, and tell again on the first success. A sweep that hits the usage limit also calls the existing `pause` handler for the home or first Clot.
- **Routing needs nothing new.** `routing.ts` treats a source with no configured account as shared, so `sweep` findings go through routing rules, the routing call and home.
  - Add `sweep: ["finding"]` to `SOURCE_KINDS`. That makes `sweep` a built-in source name, which a recipe cannot take, and makes `finding` valid only with `source: sweep` or no source.
  - `sweep` has no `via`.
  - Check that `src/config.ts` and the intake do not iterate `SOURCE_KINDS` to build webhook paths or source config; if one does, exclude `sweep`.
- **Triage prompt** gains: `finding (from the sweep): something new or changed in one of the user's connected services, seen by a periodic read of them.`
- **Re-grounding in `handoff`.** This runs only when `summary` is true, after the closing link has been posted and before returning:
  1. Show typing in the new channel and call `d.reground(name, recap)`. It returns `{ changes: string[] } | { failed: true; limit?: number }`.
  2. Changes found: post `Since the recap was written:\n- …` in the new channel, and `store.addNote(name, "Re-grounding found these changes since your recap:\n- …")`. Nothing changed: post nothing and add no note.
  3. Failed: post `I couldn't check the recap against the current state. Treat it with care.` and add the note `Re-grounding failed: the recap was not checked against the current state.`
  4. On `limit`: call `d.onLimit(resetsAt)` and pause the Clot without marking the session interrupted, since there is no turn to continue.

  `handoff` today returns `"paused"`, which on `&close` leaves the command pending so that it is retried. A handoff that is done must never return that. Add the outcome `"done-paused"`: the caller marks a `&close` row done and stops draining. Re-grounding's session runs where the main session runs (the runner's default `cwd`), with the worker lines in its prompt, and books its spend as `regrounding`. Its schema is `{ changes: string[] }`, and it has a 10-minute limit.
- **Restart during re-grounding** needs no code. The new session is saved first and the handoff is not resumed.
- **Config.**
  - Window strings match `/^\d\d:\d\d-\d\d:\d\d$/`, with start before end, parsed to minutes after midnight.
  - Giving `scarce` or `leadIn` replaces its whole default.
  - `leadInPercent` is an integer from 1 to 100. `sweep.everyMinutes` is an integer of at least 15.
  - `spend.weeklyWarnUsd` is optional and positive. The default object has 50; an explicit `"spend": {}` means no warning.

## Tasks

### Task 1: Verify the assumptions
**Files:** `scripts/spike.ts` (modify; revert before the final commit)
**Interfaces:** none.

**Build:** Run probes with `npm run spike` against `clot-home` (or `clot-encryptify`), using the container login. For each of spec section 15's assumptions, record one line under Implementation Notes:
- `usage_EXPERIMENTAL…({ skipBehaviors: true })` answers with `rate_limits.five_hour` from a query that was never sent a prompt, and the account's usage does not move.
- `mcpServerStatus()` lists the claude.ai connectors. Record the exact server names, a tool's `annotations` shape, and the exact tool name a PreToolUse hook receives for a connector tool.
- A two-turn resumed session's `total_cost_usd`: the second turn's value includes the first turn's.
- `outputFormat: { type: "json_schema" }` in a session that calls a Read tool ends with `structured_output` fitting the schema.
- Removing the transcript `.jsonl` of a finished one-off session leaves the main session's next resume working.
- `rate_limit_event.utilization`: is it a fraction or a percentage? Compare it with the usage call's value in the same minute.

If any assumption fails, stop and bring the finding to the user before continuing.

**Done when:** every line is in Implementation Notes and none failed.

- [ ] Task 1 complete

### Task 2: Config, gate and usage meter
**Files:** `src/config.ts`, `src/gates.ts`, `src/usage-meter.ts`, `src/agent/usage.ts`, `src/agent/runner.ts` (`onRateLimit`, `readUsage`, `totalCostUsd`), tests.
**Interfaces (produces):**
```ts
type Weekday = "mon"|"tue"|"wed"|"thu"|"fri"|"sat"|"sun";
interface Span { start: number; end: number }            // minutes after local midnight
interface GateConfig { scarce: Partial<Record<Weekday, Span>>; leadIn: Partial<Record<Weekday, Span>>; leadInPercent: number }
interface Reading { percent: number; resetsAt: number; readAt: number }   // ms
interface GateState { holds: null | "scarce" | "leadIn"; until?: number; percent?: number }
function gateAt(now: number, cfg: GateConfig, timeZone: string, fiveHour?: Reading): GateState;
function inLeadIn(now: number, cfg: GateConfig, timeZone: string): boolean;
function mayRunUnderGate(row: { id: string; kind: InboxKind }, urgent: boolean): boolean;
function describeGate(g: GateState, timeZone: string, now: number): string; // "scarce mode until 18:00" | "the five-hour window is at 54%"
class UsageMeter { observe(s: RateLimitState): void; fiveHour(): Reading|undefined; sevenDay(): Reading|undefined; refresh(maxAgeMs: number): Promise<void>; onChange(fn: () => void): void }
interface UsageSnapshot { fiveHour?: Reading; sevenDay?: Reading }
// AgentRunner: readUsage(): Promise<UsageSnapshot|undefined>;  TurnResult.totalCostUsd?: number
```
Config gives `config.gates: GateConfig`, `config.sweep: { enabled: boolean; everyMinutes: number }`, `config.spend: { weeklyWarnUsd?: number }`.

**Build:** as in Key Decisions. Make `gateAt` and `until` pure, and do the weekday and minute arithmetic with `Intl.DateTimeFormat`, as `src/chat/names.ts` does.

**Tests (behaviours):**
- 14:59, 15:00 and 17:59 on a Monday hold scarce; 18:00 does not; a Saturday does not; the edges hold in `Europe/Zurich` across a DST change.
- Lead-in with a 49% reading does not hold; 50% holds `leadIn` with `percent`; no reading does not hold; a reading whose reset has passed does not hold.
- `until`: scarce gives 18:00. A held lead-in with the reset at 13:00 gives 13:00; with the reset at 16:00 it gives 18:00. On Friday 17:00 scarce gives 18:00 the same day.
- `mayRunUnderGate`: message, worker, choice, digest and `resume-…` rows pass; an event passes only when urgent.
- Config: the defaults; a replacement `scarce`; `{}` means no windows; a bad window string, start ≥ end, `leadInPercent: 0` and `everyMinutes: 10` are each rejected with a message.
- Meter: `observe` updates only `five_hour` and `seven_day`; `fiveHour()` is `undefined` after the reset; `refresh` within `maxAge` makes no call; two concurrent `refresh` calls make one call; a failed read keeps the old reading.
- `parseRateLimit` returns `type` and the utilization as a percentage.

**Done when:** `npm test` and `npm run typecheck` pass.

- [ ] Task 2 complete

### Task 3: Gated drain, notices, digests and the tight line
**Files:** `src/store.ts`, `src/clot.ts`, `src/digest.ts`, `src/agent/prompts.ts`, `src/tools.ts`, `src/agent/tool-server.ts`, `src/daemon.ts` (ticker part 2, and passing `gate` into `ClotDeps`), tests.
**Interfaces:**
- Consumes: `gateAt`, `mayRunUnderGate`, `describeGate`, `GateState` (Task 2).
- Produces:
  - `ClotDeps.gate?: () => GateState` (the daemon closes over the config and the meter).
  - `Clot.kick()`, which exists already.
  - `store.pendingRows(clot)`, `store.setGated(rowId, on)`, `store.makeDigest(clot, rows): InboxRow`, `store.digestEvents(digestId): ClotEvent[]`.
  - `TurnContext.digest?: ClotEvent[]`.
  - `send_from_template { rule, text?, event? }`.

**Build:**
- Store migration: inbox `gated`, the `merged` status, the `digest` kind, and the `digests` table. Follow how `store.ts` adds columns to existing databases.
- `queueEvent`: the waiting suffix and `gated`.
- `drain`: as in Key Decisions. Add `runDigestTurn` beside `runEventTurn`, and handle `digest` in the interrupted-kind paths.
- `buildPrompt`: `tight` and the digest text. Add the system prompt lines.
- `send_from_template` with `event` in digest turns.
- The daemon ticker: steps 1 and 2 only (no sweep yet). Call `kick` on every Clot on a gate change and on `meter.onChange`.

**Tests (behaviours), with the fake clock, runner and chat:**
- Inside scarce, an ordinary event's notice ends `(waiting until 18:00)` and no turn starts. At 18:00 a tick delivers two waiting events as one digest turn, whose prompt lists both in order with their arrival times and IDs. One waiting event runs as an ordinary investigation.
- Inside scarce, a message, an urgent event, a worker's report and a choice timeout each start a turn. A message that arrives after a waiting event runs first.
- An event queued at 14:59 behind a running turn is marked gated at 15:00 and is in the 18:00 digest. Its notice has no suffix.
- A digest holding an outsider's event is an outsider turn: `TurnContext.outsider` is true.
- In a digest turn, `send_from_template` without `event` is refused, refused for an event outside the digest, and sends for an event in the digest whose rule matches.
- A digest cut off by the limit resumes as a digest with the same events.
- A restart with gated rows outside any window delivers them as one digest at startup.
- The tight line is in the prompt of every main-session turn kind while scarce holds, and absent outside it.
- With no gate configured, behaviour matches the existing `clot.test.ts` (the suite stays green).

**Done when:** `npm test` and `npm run typecheck` pass.

- [ ] Task 3 complete

### Task 4: Gated worker starts
**Files:** `src/store.ts` (`gate_ok`), `src/workers.ts`, `src/tools.ts`, `src/daemon.ts` (ticker calls `workers.wake()`), tests.
**Interfaces:**
- Consumes: `GateState`.
- Produces: `WorkersDeps.gate: () => GateState`, `Workers.wake()`, `start(clot, { …, gateOk: boolean })`.

**Build:** as in Key Decisions.

**Tests (behaviours):**
- Inside scarce, a worker started from a chat turn starts.
- One started from an urgent event's turn starts.
- One started from a worker-report turn or a choice-timeout turn stays queued, and starts on `wake()` after the gate lifts.
- A gated worker does not block a later gate-ok worker behind it.
- A follow-up to a worker that already has a place runs inside scarce.
- `gate_ok` survives a restart.

**Done when:** `npm test` and `npm run typecheck` pass.

- [ ] Task 4 complete

### Task 5: Spend log, `&spend` and the weekly warning
**Files:** `src/spend.ts`, `src/store.ts` (`spend`, `session_costs`), `src/clot.ts` (book main turns and the recap; answer `&spend`), `src/workers.ts` (book worker turns), `src/triage.ts`, `src/router.ts`, `src/routing-call.ts`, `src/commands.ts`, `src/daemon.ts`, tests.
**Interfaces:**
- Consumes: `TurnResult.totalCostUsd`, `UsageMeter`, `gateAt`, `describeGate`.
- Produces: `class SpendLog { book(a: { clot: string; who: string; sessionId?: string; total: number }): Promise<void>; report(clot: string): Promise<string>; weekStart(now: number): number }`, and `ClotDeps.spend?: { report(clot: string): Promise<string> }`. `Command` gains `{ kind: "spend" }`, an instant command.

**Build:** as in Key Decisions. The warning post needs the Clot's live channel: `SpendLog` gets `post(clot, text): Promise<void>` from the daemon.

**Tests (behaviours):**
- Turns of one session with totals 0.50, 0.80 and 1.10 book 0.50, 0.30 and 0.30. A drop to 0.20 books 0.20. A total of 0 books nothing.
- A one-off total is booked whole.
- `weekStart` is Monday 00:00 local. An entry on Sunday 23:59 is last week's.
- The report matches the exact layout, leaves out empty lines, says `Gate: none.` and `Usage reading unavailable.` when they apply, and names workers by short ID, title and model.
- The warning is posted once per week per Clot; not again after a restart; again the next week; tried again when posting failed.
- `parseCommand("&spend")` gives `spend`. `&spend extra` gives the usage reply.
- Triage, the router and the routing call each report their result's cost to `onCost` with the right Clot or null.

**Done when:** `npm test` and `npm run typecheck` pass.

- [ ] Task 5 complete

### Task 6: One-off sessions and the sweep
**Files:** `src/agent/runner.ts` (`runOneOff`), `src/agent/command-check.ts`, `src/agent/container.ts`, `src/sweep.ts`, `src/store.ts` (`recordSweep`), `src/events/kinds.ts`, `src/rulebook.ts` (only if validation needs it), `src/triage.ts` (prompt line), `src/daemon.ts` (ticker step 3), tests.
**Interfaces:**
- Consumes: `gateAt`, `SpendLog.book`, `pipeline.handle`.
- Produces:
  ```ts
  interface OneOffRequest { prompt: string; systemPrompt: string; model: string; effort: Effort; cwd?: string; schema: Record<string, unknown>; timeoutMs: number }
  interface OneOffResult { ok: boolean; output?: unknown; totalCostUsd?: number; limit?: LimitInfo; error?: string }
  // AgentRunner: runOneOff(req: OneOffRequest): Promise<OneOffResult>
  // lockDecision(toolName, input, testCommand?, connectorTools?: ReadonlySet<string>): Verdict
  function findingEvents(findings: Finding[], now: number): ClotEvent[];
  class Sweeper { tick(): Promise<void> }
  ```

**Build:** as in Key Decisions. Unit-test `runOneOff` through the existing runner seams. If none fits, put its schema handling, connector-set building and cleanup in small pure helpers, test those, and leave the SDK call itself to the Manual Verification Checklist.

**Tests (behaviours):**
- `lockDecision` approves a connector tool in the set, refuses one outside it, and still refuses Write outside memory.
- The connector set keeps only `readOnly === true` tools.
- `findingEvents` gives the ID format, source, account, kind, place, subject and `automated: false`. The same finding twice gives the same ID; a changed body gives a new one.
- The first sweep stores the record and inserts no events. The next inserts and delivers new events, and a repeated finding is dropped by `insertEvent`.
- Output that fails the schema leaves the record unchanged and counts a failure. Three failures are told once; a success after them is told once.
- The sweep is skipped when not due, when disabled, inside scarce, while a Clot is paused, and while one is running. `last-start` survives a restart, so a restart does not push the next sweep back.
- The skip list is built from the configuration.
- The sweep's cost is booked as `sweep`.
- A rule file with `source: sweep, kind: finding` is valid; `kind: finding` with `source: github` is invalid.

**Done when:** `npm test` and `npm run typecheck` pass.

- [ ] Task 6 complete

### Task 7: Re-grounding
**Files:** `src/reground.ts`, `src/clot.ts` (`handoff`, `ClotDeps.reground`), `src/daemon.ts`, tests.
**Interfaces:**
- Consumes: `runOneOff`, `SpendLog.book`.
- Produces: `ClotDeps.reground?: (clot: string, recap: string) => Promise<{ changes: string[] } | { failed: true; limit?: number }>`.

**Build:** as in Key Decisions, including the `"done-paused"` outcome.

**Tests (behaviours):**
- A context rollover with changes posts the recap, then `Since the recap was written:` with each line, and the new session's first turn starts with the note.
- An empty `changes` posts nothing and leaves no note.
- A failure posts the failure line and leaves its note.
- A limit pauses the Clot. The `&close` row is done and not retried after the reset, and the session is not marked interrupted.
- `&close nosummary` never calls `reground`.
- Messages that arrive during re-grounding wait for it.
- The cost is booked as `regrounding`.

**Done when:** `npm test` and `npm run typecheck` pass.

- [ ] Task 7 complete

### Task 8: Docs, live checks and the commit
**Files:** `README.md`, `clots.config.example.json`, this plan's Implementation Notes, the spec's status line, `scripts/spike.ts` (revert).

**Build:**
- Document `gates`, `sweep`, `spend` and `&spend` in the README and the example configuration.
- Run the Manual Verification Checklist and record the results in Implementation Notes.
- Bring spec and plan in line with any decision the build changed.
- Commit everything on `stage-2d` in one commit. Do not push.

**Done when:** `npm test` and `npm run typecheck` pass, the checklist results are recorded, and the commit exists.

- [ ] Task 8 complete

## Manual Verification Checklist

**Shared setup:**
- Docker Desktop is open and `docker info` succeeds.
- `npm run image`.
- `.env` and `clots.config.json` are as for the previous part: encryptify bound to `hacker4ofakind/encryptify`, `"home": true`, the Clots' machine account, Tailscale Funnel serving the intake on 443, email and calendar as for 2c.
- `clot-home` is logged in to Claude (`docker exec -it clot-home claude /login`, done once), so that it has connectors.
- Start the daemon with `npm run daemon`, as a background process. Before stopping it, check that no turn is running, and stop it by killing the process listening on 8787.
- After starting it, send `&close` in each Clot's live channel so that sessions pick up the new system prompt.
- "Set a window around now" means: edit `gates` in `clots.config.json`, then restart the daemon.

To force a sweep, use either:
- `node -e "new (require('better-sqlite3'))('data/clots.db').prepare(\"DELETE FROM state WHERE key='sweep-last-start'\").run()"` (check the state table's name in `src/store.ts` first; the sweep then runs within a minute);
- or set `sweep.everyMinutes` to 15 and wait.

#### MV-1: Waiting events arrive as one digest
- **Setup:** `"scarce": { "<today>": "<now-1min>-<now+8min>" }`, `"leadIn": {}`.
- **Steps:**
  1. Open two issues on `hacker4ofakind/encryptify` titled `Login button misaligned on Safari` and `Typo in footer: "Copyrigth"`.
  2. Wait for the window to end.
- **Expected:**
  - each issue gets a one-line notice in encryptify's live channel ending `(waiting until HH:MM)`, with the window's end time;
  - no investigation starts during the window;
  - within a minute of the end, one turn handles both, with both issues named in the reply;
  - `data/clots.db` has a `digest` inbox row and two `merged` rows.
- **How the executor runs it:** `gh issue create` for the issues; the built-in browser on Discord for the channel; a node one-liner for the rows.

#### MV-2: The user's message runs during scarce mode
- **Setup:** MV-1's window, still open, and something waiting from step 1 of MV-1.
- **Steps:** send `What time is it where you are?` in encryptify's live channel.
- **Expected:**
  - the Clot answers at once;
  - the reply's turn starts with the tight line (check the daemon log or transcript for `Usage is tight right now (scarce mode until`);
  - the waiting events are still waiting.
- **How the executor runs it:** the built-in browser on Discord; read the session's transcript in the container.

#### MV-3: An urgent event runs during scarce mode
- **Setup:** a scarce window around now.
- **Steps:** open an issue titled `Production down: every login returns 500 since the last deploy` with a body saying all users are locked out.
- **Expected:**
  - triage marks it urgent (`events.urgent = 1`);
  - its notice has no `(waiting until …)`;
  - it is investigated at once.
- **How the executor runs it:** `gh issue create`; Discord in the built-in browser; the database.

#### MV-4: A worker asked for in chat starts during scarce mode
- **Setup:** a scarce window around now.
- **Steps:** in encryptify's channel, send `Start a worker to fix the footer typo "Copyrigth" and open a PR.`
- **Expected:**
  - the worker's start line is posted;
  - the worker runs during the window;
  - the main session picks a model one step down from its usual choice (Sonnet medium for a typo, or as the main session says).
- **How the executor runs it:** Discord in the built-in browser.

#### MV-5: A worker asked for outside the user's turn waits
- **Setup:** `CLOTS_MAX_WORKERS=1` in `.env`; a scarce window starting 5 minutes from now and lasting 10.
- **Steps:**
  1. Before the window, ask in chat for a worker on a long task (`Start a worker to add unit tests for every module`).
  2. Open an issue with a clear one-line bug, so that its investigation asks for a second worker, which queues behind the first.
  3. When the first worker finishes inside the window, watch the queue.
- **Expected:**
  - the second worker stays queued until the window ends (`workers.status = 'queued'`, `gate_ok = 0`);
  - it then starts.
- **How the executor runs it:** `[user-only]` if the timing cannot be arranged; otherwise Discord plus the database. Covered by Task 4's tests either way.

#### MV-6: A held lead-in and the tight line
- **Setup:** `"scarce": {}`, `"leadIn": { "<today>": "<now-1min>-<now+30min>" }`, `"leadInPercent": 1`.
- **Steps:**
  1. Wait one minute after the start.
  2. Send `&spend`.
  3. Open an issue titled `Dark mode toggle does nothing`.
- **Expected:**
  - `&spend` shows `Gate: the five-hour window is at N%` with N ≥ 1, and a five-hour line with a reset time;
  - the issue's notice ends `(waiting until …)`;
  - setting `leadInPercent` to 100 and restarting delivers it.
- **How the executor runs it:** Discord, `gh`.

#### MV-7: `&spend` lines
- **Setup:** after MV-1 to MV-4.
- **Steps:** send `&spend` in encryptify's channel.
- **Expected:**
  - the exact layout of the plan;
  - non-zero `Main session` and `Triage and router` lines, and a `Worker … (Sonnet 5.5 …)` line;
  - the `All Clots` line;
  - no model turn starts.
- **How the executor runs it:** Discord in the built-in browser.

#### MV-8: Weekly warning once
- **Setup:** `"spend": { "weeklyWarnUsd": 0.01 }`, then restart.
- **Steps:**
  1. Send `Hi` in encryptify's channel.
  2. Send `Hi again`.
  3. Restart the daemon and send `Hi` once more.
- **Expected:**
  - exactly one `encryptify has spent an estimated $… this week, past the $0.01 warning. &spend shows where.` line;
  - no second one after the restart.
- **How the executor runs it:** Discord in the built-in browser.

#### MV-9: The sweep's baseline, then a finding
- **Setup:** `clot-home` logged in; `sweep.enabled` true.
- **Steps:**
  1. Force a sweep and wait for it to end (log line).
  2. Check that `state.sweep-record` is set and that no `sweep:` events exist.
  3. Change something one of the login's connectors can read (for example create a Claude Doc titled `Encryptify launch checklist` with three bullet points).
  4. Force another sweep.
- **Expected:**
  - after the second sweep, a `sweep:<connector>:…` event exists, is routed (encryptify by the routing call, or home), and gets a notice or is dropped by triage as needing no action;
  - nothing is posted on the first sweep;
  - the sweep's transcript is gone from `clot-home`'s `~/.claude/projects`;
  - the daemon log shows no refused writes.
- **How the executor runs it:** `[user-only]` for creating the Doc; the rest from the database, `docker exec` and Discord.

#### MV-10: The sweep is skipped during scarce mode
- **Setup:** a scarce window around now.
- **Steps:** force a sweep.
- **Expected:** `sweep-last-start` is unchanged after two minutes, and the log says the sweep was skipped.
- **How the executor runs it:** the database and the log.

#### MV-11: `&close` re-grounds
- **Setup:** a worker or open pull request mentioned in encryptify's current session (from MV-4). Close that pull request on GitHub by hand.
- **Steps:** send `&close` in encryptify's channel.
- **Expected:**
  - the new channel shows the recap, then `Since the recap was written:` with a line saying the pull request is closed;
  - the next message's turn starts with the re-grounding note;
  - with nothing changed, a second `&close` shows only the recap.
- **How the executor runs it:** `gh pr close`; Discord in the built-in browser.

#### MV-12: `&close nosummary` skips re-grounding
- **Steps:** send `&close nosummary`.
- **Expected:** `New session, started from scratch at your request. Nothing was carried over.` and no re-grounding lines.
- **How the executor runs it:** Discord in the built-in browser.

#### MV-13: Regressions
- **Setup:** `gates` with no window at the current time.
- **Steps:**
  1. Open an issue.
  2. Send `&rules`.
  3. Ask for a calendar event tomorrow at 10:00 titled `Dentist`.
  4. Check `clots-waiting`.
- **Expected:**
  - the issue is investigated at once, with no waiting suffix;
  - `&rules` lists the rules;
  - the calendar post appears;
  - `clots-waiting` is unchanged in shape.
- **How the executor runs it:** `gh`, Discord in the built-in browser.

## Out of Scope

- A seven-day guard, enforcing the cheaper worker models, and stopping anything on spend.
- A sweep per Clot, or sweeping services the daemon already hears from.
- Gathering events into a digest without a gate.
- Sentry, Vercel and PostHog (2c Tasks 24–26), Pi deployment, onboarding, the browser.

## Implementation Notes
_Filled in by the executor before finishing: deviations from this plan and why, final names/interfaces if they changed, surprises, and anything the next stage's planner should know. Keep it short._
