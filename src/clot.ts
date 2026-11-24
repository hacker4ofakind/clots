import { randomUUID } from "node:crypto";
import type { AgentRunner, TurnHandle, TurnResult } from "./agent/runner.js";
import { buildPrompt, CONTINUE_TEXT, MIDTURN_PREFIX, recapPrompt } from "./agent/prompts.js";
import { COMMAND_USAGE, parseCommand, type Command } from "./commands.js";
import { activityLine } from "./conversation/activity-lines.js";
import type { Conversation } from "./conversation/conversation.js";
import { digestText, planDrain, type DigestEntry } from "./digest.js";
import { describeGate, waitingUntil, type GateState } from "./gates.js";
import { formatEvent, linkTo } from "./events/format.js";
import { KEEP_WARM_PROMPT, KEEP_WARM_RETRY_MS } from "./keep-warm.js";
import type { ClotEvent } from "./events/types.js";
import { OPUS } from "./models.js";
import { REGROUND_FAILED_NOTE, regroundNote, type RegroundOutcome } from "./reground.js";
import { SessionRoster, type RosterEntry } from "./roster.js";
import type { BookArgs } from "./spend.js";
import type { Router } from "./router.js";
import type { InboxRow, SessionRow, Store } from "./store.js";
import type { StandingMatch } from "./standing.js";
import type { DaemonTools, TurnContext, TurnKind } from "./tools.js";
import type { SeedReason } from "./types.js";

export interface ClotDeps {
  name: string;
  store: Store;
  conv: Conversation;
  router: Router;
  runner: AgentRunner;
  timeZone: string;
  rolloverPercent: number;
  now: () => Date;
  newId: () => string;
  schedule: (ms: number, fn: () => void) => void;
  /** Called when no turn is running any more: after each turn, with whether its row was an outsider's, and once at startup. */
  onTurnEnd?: (clot: string, turn: { outsider: boolean }) => Promise<void>;
  /** Makes the daemon's tools for one turn. */
  makeTools?: (ctx: TurnContext) => DaemonTools;
  /** The standing rules that apply to an event, with their text filled in. */
  standingFor?: (clot: string, event: ClotEvent) => StandingMatch[];
  /** Answers `/rules` and `/rules undo`. */
  rules?: { list(clot: string): string; undo(clot: string): string };
  /** Called when a session has been replaced by a new one. */
  onSessionClosed?: (clot: string) => Promise<void>;
  /** Called before each turn starts, when no turn of this Clot is running: brings its global memories up to date. */
  beforeTurn?: (clot: string) => Promise<void>;
  /** Answers `/memory` and `/memory undo`. */
  memory?: { list(): string; undo(): Promise<string> };
  /** Answers `/calendar undo`. Absent when no calendar can be changed. */
  calendar?: { undo(clot: string): Promise<string> };
  /** Answers `/composio undo`. Absent when no Composio account is configured. */
  composio?: { undo(clot: string): Promise<string>; /** Answers `/composio reconnect <toolkit>:<account>`. */ reconnect(account: string): Promise<string> };
  /** One line per listed worker, for every prompt and the recap. */
  workerLines?: (clot: string) => string[];
  /** Where a keep-warm turn's reply goes. It is never posted in chat or kept in the Clot's tail. */
  keepWarmLog?: (clot: string, text: string) => void;
  /** Called when a turn of this Clot hits the usage limit. resetsAt is in Unix seconds. */
  onLimit?: (resetsAt: number) => void;
  /** Called when this Clot's pause ends. */
  onResume?: (clot: string) => void;
  /** What the scarce and lead-in gates say now. Absent: no gate. */
  gate?: () => GateState;
  /** The spend log: books each turn's cost, and answers `/spend`. */
  spend?: { book(a: BookArgs): Promise<void>; report(clot: string): Promise<string> };
  /** Checks a recap against the current state before the new session's first turn. Absent: the recap is taken as written. */
  reground?: (clot: string, recap: string) => Promise<RegroundOutcome>;
  /** Every Clot the daemon runs, this one included, each with a line on what it looks after. Absent: the Clot is told of no others. */
  roster?: () => RosterEntry[];
}

/** A command the daemon answers at once, without a turn and without the session. */
type InstantCommand = Extract<Command, { kind: "invalid" | "effort" | "rules" | "memory" | "calendar" | "composio" | "spend" }>;

/** Returns the command when it is one answered at once; an `/effort` that carries a message is not. */
function instantCommand(command: Command): InstantCommand | undefined {
  return command.kind === "invalid" || command.kind === "rules" || command.kind === "memory" || command.kind === "calendar" || command.kind === "composio" || command.kind === "spend" || (command.kind === "effort" && command.rest === "") ? command : undefined;
}

const HANDOFF_TEXT: Record<SeedReason, { notice: string; failed: string; intro: string }> = {
  context: {
    notice: "Context limit reached. Writing a handoff for the next session...",
    failed: "The handoff could not be written. This session stays open; I'll try again after the next message.",
    intro: "New session. This is the recap of the previous one. Correct anything that is wrong before I continue.",
  },
  user: {
    notice: "Closing this session at your request. Writing a handoff...",
    failed: "The handoff could not be written, so this session stays open. Send `/close` to try again, or `/close nosummary` to start without one.",
    intro: "New session, started at your request. This is the recap of the previous one. Correct anything that is wrong before I continue.",
  },
};

/** What the model is told in place of a message that holds only an image. */
const IMAGE_ONLY = "[The user sent an image without any text.]";

/** A message the user sent from the web app. */
export interface UserMessage {
  id: string;
  text: string;
  at: Date;
  /** How many images came with it; they are stored with the message. */
  images?: number;
}

export class Clot {
  private live?: TurnHandle;
  /** What the running turn is for. Only a chat turn takes in the user's messages while it runs. */
  private liveKind: TurnKind | "keep-warm" = "chat";
  /** No keep-warm ping is tried before this time: the last one failed. */
  private keepWarmRetryAt = 0;
  /** The running chat turn's context, so a message fed into it joins the text the write reviewer may trust. */
  private liveContext?: TurnContext;
  /** The last of the daemon's notes that the running turn was given, or 0 when it was given none. */
  private liveNotes = 0;
  /** The roster the running turn was told of by a note, to be recorded once it has read it. */
  private liveRoster?: { session: string; told: string };
  private roster?: SessionRoster;
  private draining = false;
  private posts: Promise<void> = Promise.resolve();
  /** The ID each streamed piece of text was sent under, by the runner's key, until its final text arrives. */
  private streams = new Map<string, string>();

  constructor(private d: ClotDeps) {
    if (d.roster) this.roster = new SessionRoster({ store: d.store, name: d.name, roster: d.roster });
  }

  async init(): Promise<void> {
    const { store, name } = this.d;
    store.upsertClot(name);
    const clot = store.getClot(name)!;

    if (!store.activeSession(name)) store.createSession({ id: this.d.newId(), clot: name, seed: null });

    // A session that already ran has a cache of unknown age: its keep-warm clock starts now.
    if (store.activeSession(name)!.started && this.lastTurnAt() === undefined) store.setState(`last-turn:${name}`, String(this.d.now().getTime()));

    if (store.requeueRunning(name) > 0) store.setInterrupted(store.activeSession(name)!.id, true);
    // Nothing is running after a restart either.
    await this.turnEnded();

    // A pause that expired while the daemon was down still goes through the resume path, so the cut-off work continues.
    if (clot.pausedUntil !== null) this.scheduleResume(clot.pausedUntil);
    else await this.drain();
  }

  async onMessage(m: UserMessage): Promise<void> {
    const { store, conv, name } = this.d;
    const text = m.text.trim() === "" && (m.images ?? 0) > 0 ? IMAGE_ONLY : m.text;
    if (!store.enqueue({ id: m.id, clot: name, text, receivedAt: m.at.getTime() })) return;

    const command = parseCommand(text);
    const instant = instantCommand(command);
    if (instant) {
      await this.runInstant(m.id, instant);
      return;
    }

    if (this.live) {
      if (command.kind === "close") {
        // Stays pending; the drain loop closes the session once this turn is over.
        await conv.post(name, "I'll close this session when the current turn finishes.", { kind: "note" });
        return;
      }
      // An earlier message is waiting for this turn to end (a close, a refused push).
      // This one waits behind it, so it is not delivered ahead of what the user sent first.
      const earlier = this.nextRunnable();
      if (earlier && earlier.id !== m.id) return;
      // A turn's authority is fixed when it starts. A message that arrives during an event's or a
      // worker's turn stays pending and gets a chat turn of its own, so it keeps the user's.
      if (this.liveKind !== "chat") return;
      const live = this.live;
      const sent = command.kind === "effort" ? command.rest : text;
      const decision = await this.d.router.decide({ clot: name, text: sent, tail: store.tail(name, 4) });
      if (this.live !== live) {
        // The turn ended while routing. The message is still pending; handle it as a normal turn.
        await this.drain();
        return;
      }
      const oneOff = store.nextEffort(name);
      const effort = (command.kind === "effort" ? command.effort : oneOff) ?? decision.effort;
      // Refused once the turn's input has closed; the message then stays pending for the next turn,
      // and a one-off effort is kept for it.
      const images = this.imagesOf(m.id);
      if (!live.push(`${MIDTURN_PREFIX}\n${sent}`, effort, images.length === 0 ? undefined : images)) return;
      if (this.liveContext) this.liveContext.userText = `${this.liveContext.userText ?? ""}\n\n${sent}`.trim();
      if (oneOff !== null) store.setNextEffort(name, null);
      store.appendTail(name, "user", sent);
      store.setInboxStatus(m.id, "running");
      return;
    }
    await this.drain();
  }

  private gateState(): GateState {
    return this.d.gate?.() ?? { holds: null };
  }

  /** The first pending row that may run now: while a gate holds, the events it holds back are skipped, and never block the user's own work. */
  private nextRunnable(): InboxRow | undefined {
    return planDrain(this.d.store.pendingRows(this.d.name), this.gateState().holds !== null).run;
  }

  /** The fields every main session turn's prompt shares. Taking the notes marks them as given to this turn. */
  private shared(session: SessionRow) {
    const gate = this.gateState();
    return {
      seed: session.seed,
      seedReason: session.seedReason,
      interrupted: session.interrupted,
      notes: [...this.takeNotes(), ...this.rosterNote(session)],
      workers: this.workerLines(),
      ...(gate.holds === null ? {} : { tight: describeGate(gate, this.d.timeZone, this.d.now().getTime()) }),
    };
  }

  /** The settings a change in the configuration reaches at once. */
  configure(o: { rolloverPercent?: number; timeZone?: string }): void {
    if (o.rolloverPercent !== undefined) this.d.rolloverPercent = o.rolloverPercent;
    if (o.timeZone !== undefined) this.d.timeZone = o.timeZone;
  }

  /** Whether a turn is running. */
  isBusy(): boolean {
    return this.live !== undefined;
  }

  /** When this Clot's last turn that reached the model ended (kept across restarts), or undefined before its first. */
  lastTurnAt(): number | undefined {
    const value = this.d.store.getState(`last-turn:${this.d.name}`);
    return value === undefined ? undefined : Number(value);
  }

  /** Notes that a turn reached the model, which started its cache's lifetime over. */
  private touch(result: TurnResult): void {
    if (result.ok || result.responded === true || result.contextPercent > 0) this.d.store.setState(`last-turn:${this.d.name}`, String(this.d.now().getTime()));
  }

  /**
   * Sends the session one small message so that its prompt cache does not expire, when nothing else is using the Clot.
   * It holds the drain, so it never runs beside another turn and a message that arrives meanwhile waits, then runs. The
   * message and the reply go to the daemon's log only: not to chat, not to the tail, and the tools it may not use are refused.
   */
  async keepWarm(): Promise<void> {
    const { store, name } = this.d;
    if (this.draining || this.live) return;
    const session = store.activeSession(name);
    // Nothing is cached before the session's first turn, and a paused Clot would only meet the limit again.
    if (!session?.started) return;
    const paused = store.getClot(name)!.pausedUntil;
    // Any pause, even one that has run out: the resume callback clears it and queues the cut-off turn's continuation, and must not meet a running ping.
    if (paused !== null) return;
    if (this.d.now().getTime() < this.keepWarmRetryAt) return;
    this.draining = true;
    try {
      const reply: string[] = [];
      this.liveKind = "keep-warm";
      this.live = this.d.runner.startTurn({
        resume: session.id,
        prompt: KEEP_WARM_PROMPT,
        effort: "low",
        role: "main",
        model: OPUS,
        tools: this.d.makeTools?.({ clot: name, kind: "chat", outsider: true }),
        roster: this.rosterPrompt(session),
        noTools: true,
        onText: (text) => void reply.push(text),
      });
      let result: TurnResult;
      try {
        result = await this.live.done;
      } finally {
        this.live = undefined;
      }
      // Only a ping that worked starts the clock again; a failed one is tried again after the retry delay.
      if (result.ok) this.touch(result);
      await this.d.spend?.book({ clot: name, who: "main", sessionId: session.id, total: result.totalCostUsd }).catch((error) => console.error(`[${name}] booking the keep-warm turn's cost failed:`, error));
      this.d.keepWarmLog?.(name, result.ok ? `reply: ${reply.join(" ").trim() || "(none)"}` : "the turn did not finish");
      if (result.limit) {
        this.d.onLimit?.(result.limit.resetsAt);
        await this.pause(result.limit.resetsAt);
      } else if (!result.ok) {
        this.keepWarmRetryAt = this.d.now().getTime() + KEEP_WARM_RETRY_MS;
      } else if (result.contextPercent >= this.d.rolloverPercent) {
        // Pings add to the session like any turn, so an idle one rolls over the same way.
        await this.handoff("context", true);
      }
    } finally {
      this.draining = false;
    }
    // A message that came in during the ping was left pending.
    this.kick();
  }

  /** A request the user made of another Clot that only this one can carry out: queued as the user's own message here, and posted in this Clot's chat. */
  async queueRequest(from: string, request: string): Promise<string> {
    const { store, conv, name } = this.d;
    store.enqueue({
      id: `request:${name}:${this.d.now().getTime()}:${from}`,
      clot: name,
      text: `[The user asked the ${from} Clot for the following, and it passed it to you. Carry it out as if the user said it here; answer here.]
${request}`,
      receivedAt: this.d.now().getTime(),
    });
    await conv.post(name, `Passed on from ${from}, at the user's request:
${request}`.slice(0, 1900), { kind: "note" }).catch(() => undefined);
    this.kick();
    return `${name}'s chat`;
  }

  /**
   * Puts an event in the queue for a locked turn of its own, and posts its one-line
   * notice. With kick false the caller is the Clot's own after-turn hook, and the
   * drain that called it carries on by itself.
   */
  async queueEvent(event: ClotEvent, notice: string, kick = true): Promise<void> {
    const { store, conv, name } = this.d;
    // Under a gate an ordinary event waits: it gets its notice now, with when the gate is expected to lift, and arrives later in a digest.
    const gate = this.gateState();
    const waits = gate.holds !== null && store.getEvent(event.id)?.urgent !== true;
    // Named by the Clot as well, so an event handed to another Clot is queued there too.
    store.enqueue({ id: `event:${name}:${event.id}`, clot: name, text: formatEvent(event, this.d.timeZone), receivedAt: event.receivedAt, kind: "event", eventId: event.id, outsider: event.outsider, gated: waits });
    store.setEventStatus(event.id, "queued");
    const until = waits ? waitingUntil(gate, this.d.timeZone, this.d.now().getTime()) : "";
    await conv.post(name, `${notice}${until}${linkTo(event.url)}`, { kind: "note" }).catch(() => undefined);
    if (kick) void this.drain().catch((error) => console.error(`[${name}]`, error));
  }

  /** Starts draining, so a row the daemon stored for this Clot runs. Does nothing while a drain is active: it picks the row up. */
  kick(): void {
    void this.drain().catch((error) => console.error(`[${this.d.name}]`, error));
  }

  private async turnEnded(outsider = false): Promise<void> {
    await this.d.onTurnEnd?.(this.d.name, { outsider }).catch((error) => console.error(`[${this.d.name}] after-turn hook failed:`, error));
  }

  /** Works through pending messages one at a time. Only one drain runs; a call made while one is active does nothing. */
  private async drain(): Promise<void> {
    const { store, name } = this.d;
    if (this.draining) return;
    this.draining = true;
    try {
      while (true) {
        const paused = store.getClot(name)!.pausedUntil;
        if (paused !== null && paused * 1000 > this.d.now().getTime()) return;
        const plan = planDrain(store.pendingRows(name), this.gateState().holds !== null);
        for (const id of plan.markGated) store.setGated(id, true);
        for (const id of plan.ungate ?? []) store.setGated(id, false);
        if (plan.digest) {
          // The gate has lifted: what waited is looked into together, in turns of at most ten, one after the other.
          for (const chunk of plan.digest) {
            if (!(await this.process(store.makeDigest(name, chunk)))) return;
          }
          continue;
        }
        if (!plan.run) return;
        const keepGoing = await this.process(plan.run);
        if (!keepGoing) return;
      }
    } finally {
      this.draining = false;
    }
  }

  private async runInstant(id: string, command: InstantCommand): Promise<void> {
    const { store, conv, name } = this.d;
    store.setInboxStatus(id, "done");
    const say = (text: string) => conv.post(name, text, { kind: "note" });
    if (command.kind === "effort") {
      store.setNextEffort(name, command.effort);
      await say(`Effort for your next message: ${command.effort}.`);
    } else if (command.kind === "rules") {
      const rules = this.d.rules;
      await say(rules === undefined ? "The rulebook is not available." : command.undo ? rules.undo(name) : rules.list(name));
    } else if (command.kind === "memory") {
      const memory = this.d.memory;
      await say(memory === undefined ? "Global memory is not available." : command.undo ? await memory.undo() : memory.list());
    } else if (command.kind === "spend") {
      const spend = this.d.spend;
      await say(spend === undefined ? "Spend is not tracked here." : await spend.report(name));
    } else if (command.kind === "calendar") {
      const calendar = this.d.calendar;
      await say(calendar === undefined ? "No calendar can be changed from this daemon." : await calendar.undo(name));
    } else if (command.kind === "composio") {
      const composio = this.d.composio;
      await say(composio === undefined ? "No Composio account is configured." : "reconnect" in command ? await composio.reconnect(command.reconnect) : await composio.undo(name));
    } else {
      await say(`I don't know \`/${command.name}\` used that way. ${COMMAND_USAGE}`);
    }
  }

  /** Handles one pending message. Returns false when draining must stop (the Clot is now paused). */
  private async process(row: InboxRow): Promise<boolean> {
    const { store, conv, name } = this.d;
    const session = store.activeSession(name)!;

    // An event or a worker's report is data: text in it that looks like a command is not one.
    const isEvent = row.kind === "event";
    const command: Command = row.kind !== "message" ? { kind: "none" } : parseCommand(row.text);
    const instant = instantCommand(command);
    if (instant) {
      await this.runInstant(row.id, instant);
      return true;
    }
    if (command.kind === "close") {
      if (session.started) {
        const outcome = await this.handoff("user", command.summary);
        // On a usage limit the command stays pending and is retried after the reset.
        if (outcome === "paused") return false;
        if (outcome === "resumed") return true;
        // The handoff is done, but re-grounding hit the usage limit: the command is finished, and nothing is retried.
        if (outcome === "done-paused") {
          store.setInboxStatus(row.id, "done");
          return false;
        }
      } else if (!command.summary && session.seed !== null) {
        // A new session that still carries an unused recap: drop the recap in place.
        store.clearSeed(session.id);
        store.clearTail(name);
        store.clearNotes(name);
        await conv.post(name, "Recap discarded. This session now starts from scratch.", { kind: "note" });
      } else {
        await conv.post(name, "This session is already fresh; there is nothing to close.", { kind: "note" });
      }
      store.setInboxStatus(row.id, "done");
      return true;
    }

    conv.setState(name, "working");
    // Between turns, so the daemon never writes in the memory folder while the Clot may be writing there too.
    await this.d.beforeTurn?.(name).catch((error) => console.error(`[${name}] syncing global memories failed:`, error));
    let result: TurnResult;
    try {
      result = row.kind === "digest" ? await this.runDigestTurn(row, session) : isEvent ? await this.runEventTurn(row, session) : row.kind === "worker" || row.kind === "choice" ? await this.runWorkerTurn(row, session) : await this.runTurn(row, session, command);
    } finally {
      this.live = undefined;
      this.liveContext = undefined;
    }
    await this.posts;
    this.touch(result);
    await this.d.spend?.book({ clot: name, who: "main", sessionId: session.id, total: result.totalCostUsd }).catch((error) => console.error(`[${name}] booking the turn's cost failed:`, error));
    if (result.activity && result.activity.files.length + result.activity.commands.length > 0) {
      await conv.postActivity(name, result.activity).catch(() => undefined);
    }
    await this.turnEnded(row.outsider);
    // The notes this turn was given have been read, unless it failed. One that arrived meanwhile waits for the next turn.
    if (result.ok && this.liveNotes > 0) store.clearNotes(name, this.liveNotes);
    this.liveNotes = 0;
    if (result.ok && this.liveRoster) this.roster?.markTold({ id: this.liveRoster.session }, this.liveRoster.told);
    this.liveRoster = undefined;

    // The session exists on disk once any model response has come back.
    if (result.ok || result.contextPercent > 0) store.markSessionStarted(session.id);
    store.setInterrupted(session.id, false);
    store.finishRunning(name);

    if (!result.ok && !result.limit) {
      conv.setState(name, "failed", "The last turn ended with an error");
      await conv.post(
        name,
        row.kind === "digest"
          ? `Looking into these events ended with an error: ${store.digestEvents(row.eventId ?? "").map((event) => event.id).join(", ")}. Ask me about any of them to try again.`
          : isEvent
            ? "Looking into that event ended with an error. Ask me about it to try again."
            : row.kind === "worker"
              ? "Reading a worker's report ended with an error. Ask me about the worker to try again."
              : row.kind === "choice"
                ? "Going on with my pick ended with an error. Answer the choice here to try again."
                : "That turn ended with an error. Send your message again to retry.",
        { kind: "note" },
      );
      return true;
    }
    conv.setState(name, "idle");

    if (result.limit) {
      store.setInterrupted(session.id, true, row.kind, row.eventId, row.outsider);
      // The limit is the account's: the workers wait for the same reset.
      this.d.onLimit?.(result.limit.resetsAt);
      return (await this.pause(result.limit.resetsAt)) === "resumed";
    }

    if (result.contextPercent >= this.d.rolloverPercent) {
      const outcome = await this.handoff("context", true);
      if (outcome === "paused" || outcome === "done-paused") return false;
    }
    return true;
  }

  /**
   * Pauses until the usage limit resets and tells the user. Returns "resumed"
   * when the reset came while the notice was being posted, in which case the
   * caller carries on draining.
   */
  private async pause(resetsAt: number): Promise<"paused" | "resumed"> {
    const { store, conv, name } = this.d;
    store.setPausedUntil(name, resetsAt);
    // Scheduled before the notice: a failed post must not leave the Clot paused with no wake-up.
    this.scheduleResume(resetsAt);
    conv.setState(name, "paused", "usage limit");
    const time = new Intl.DateTimeFormat("en-GB", { timeZone: this.d.timeZone, hour: "2-digit", minute: "2-digit" }).format(new Date(resetsAt * 1000));
    await conv.post(name, `Paused: usage limit reached. I'll resume at ${time}.`, { kind: "note" }).catch(() => undefined);
    // The timer skips its wake-up while a drain is active, which this one is. If it fired during the post, take the wake-up here.
    if (store.getClot(name)!.pausedUntil !== null) return "paused";
    this.queueContinuation(resetsAt);
    return "resumed";
  }

  /**
   * After a reset: if a turn was cut off and nothing is waiting (a digest is queued either way), queue a prompt that tells the session to carry on.
   * It is queued as what the cut-off turn was, so an investigation is picked up again under the lock.
   */
  private queueContinuation(resetsAt: number): void {
    const { store, name } = this.d;
    const session = store.activeSession(name)!;
    // A cut-off digest is always picked up again: its events are no longer waiting rows, so nothing else would look at them.
    if (!session.interrupted || (session.interruptedKind !== "digest" && this.nextRunnable())) return;
    store.enqueue({ id: `resume-${resetsAt}`, clot: name, text: CONTINUE_TEXT, receivedAt: this.d.now().getTime(), kind: session.interruptedKind, eventId: session.interruptedEvent, outsider: session.interruptedOutsider });
  }

  /** What a main-session turn does with what the session writes: streamed text, final text and tool calls. */
  private turnHooks(): { onText: (text: string, key?: string) => void; onTextDelta: (key: string, delta: string) => void; onToolUse: (block: { name: string; input: unknown }) => void } {
    return {
      onText: this.sayIn(),
      onTextDelta: (key, delta) => {
        let id = this.streams.get(key);
        if (id === undefined) {
          id = this.d.newId();
          this.streams.set(key, id);
        }
        this.d.conv.delta(this.d.name, id, delta);
      },
      onToolUse: (block) => this.d.conv.activityLine(this.d.name, activityLine(block)),
    };
  }

  /** The images stored with a message, in the form the runner takes. */
  private imagesOf(messageId: string): { mediaType: string; data: string }[] {
    return this.d.store.conversation.imagesOf(messageId).map((image) => ({ mediaType: image.mediaType, data: image.data.toString("base64") }));
  }

  /**
   * Runs an event as a turn of its own. The router still picks the effort. An event does
   * not use up a one-off effort: that belongs to the user's own messages.
   */
  private async runEventTurn(row: InboxRow, session: SessionRow): Promise<TurnResult> {
    const { store, name } = this.d;
    const decision = await this.d.router.decide({ clot: name, text: row.text, tail: store.tail(name, 4) });
    // The event this turn is for. A turn that picks up a cut-off investigation is for the same one.
    const event = row.eventId === null ? undefined : store.getEvent(row.eventId);
    const standing = event === undefined ? [] : (this.d.standingFor?.(name, event) ?? []);
    store.setInboxStatus(row.id, "running");
    this.liveKind = "event";
    this.live = this.d.runner.startTurn({
      ...(session.started ? { resume: session.id } : { newSessionId: session.id }),
      prompt: buildPrompt({
        text: row.text,
        ...this.shared(session),
        event: true,
        outsider: row.outsider,
        standing: standing.map((match) => ({ name: match.rule.name, text: match.filled })),
      }),
      effort: decision.effort,
      role: "main",
      model: OPUS,
      tools: this.d.makeTools?.({ clot: name, kind: "event", turnId: randomUUID(), event, outsider: row.outsider }),
      roster: this.rosterPrompt(session),
      ...this.turnHooks(),
    });
    return this.live.done;
  }

  /**
   * Runs the events that waited behind a gate as one turn of their own, under the lock. A digest an
   * outsider's event is in is an outsider's turn. One cut off by the usage limit is told to carry on, not
   * sent the events again; its events are loaded for the tools.
   */
  private async runDigestTurn(row: InboxRow, session: SessionRow): Promise<TurnResult> {
    const { store, name } = this.d;
    const events = store.digestEvents(row.eventId ?? "");
    const entries: DigestEntry[] = events.map((event) => ({ event, message: event.triageMessage, standing: (this.d.standingFor?.(name, event) ?? []).map((match) => ({ name: match.rule.name, text: match.filled })) }));
    const decision = await this.d.router.decide({ clot: name, text: events.map((event) => event.title).join("\n").slice(0, 2000), tail: store.tail(name, 4) });
    store.setInboxStatus(row.id, "running");
    this.liveKind = "event";
    this.live = this.d.runner.startTurn({
      ...(session.started ? { resume: session.id } : { newSessionId: session.id }),
      // Told to carry on only in the session that was cut off. A session that never ran (a `/close` came in between) gets the events in full.
      prompt: buildPrompt({ text: row.id.startsWith("resume-") && session.started ? CONTINUE_TEXT : digestText(entries, this.d.timeZone), ...this.shared(session), event: true, outsider: row.outsider }),
      effort: decision.effort,
      role: "main",
      model: OPUS,
      tools: this.d.makeTools?.({ clot: name, kind: "event", turnId: randomUUID(), digest: events, outsider: row.outsider }),
      roster: this.rosterPrompt(session),
      ...this.turnHooks(),
    });
    return this.live.done;
  }

  /**
   * Runs a worker's report, question or failure as a turn of its own, at medium effort, without the
   * router. It carries none of the user's authority: a report can quote outside text. A choice the
   * user did not answer in time runs the same way.
   */
  private runWorkerTurn(row: InboxRow, session: SessionRow): Promise<TurnResult> {
    const { store, name } = this.d;
    store.setInboxStatus(row.id, "running");
    this.liveKind = "worker";
    this.live = this.d.runner.startTurn({
      ...(session.started ? { resume: session.id } : { newSessionId: session.id }),
      prompt: buildPrompt({ text: row.text, ...this.shared(session) }),
      effort: "medium",
      role: "main",
      model: OPUS,
      tools: this.d.makeTools?.({ clot: name, kind: "worker", turnId: randomUUID(), outsider: row.outsider, ...(row.kind === "choice" ? { fromTimeout: true } : {}) }),
      roster: this.rosterPrompt(session),
      ...this.turnHooks(),
    });
    return this.live.done;
  }

  private workerLines(): string[] {
    return this.d.workerLines?.(this.d.name) ?? [];
  }

  /** Pauses this Clot until the usage limit resets, telling the user in its chat. For a limit a worker hit. */
  async pauseFor(resetsAt: number): Promise<void> {
    const session = this.d.store.activeSession(this.d.name);
    if (!session) return;
    const paused = this.d.store.getClot(this.d.name)!.pausedUntil;
    if (paused !== null && paused >= resetsAt) return;
    await this.pause(resetsAt);
  }

  /** The daemon's notes for the turn that is about to start, remembered so that they are cleared when it has read them. */
  private takeNotes(): string[] {
    const notes = this.d.store.notes(this.d.name);
    this.liveNotes = notes.at(-1)?.seq ?? 0;
    return notes.map((note) => note.text);
  }

  /** What this session's system prompt says of the other Clots. Only the turn that creates the session sets its prompt; later turns send the same text, which Claude Code ignores on a resume. */
  private rosterPrompt(session: SessionRow): string | undefined {
    return this.roster?.prompt(session);
  }

  /** A note for the turn that is about to start when the Clots changed after the session's prompt was written; recorded as given once the turn has read it. */
  private rosterNote(session: SessionRow): string[] {
    const note = this.roster?.note(session);
    this.liveRoster = note === undefined ? undefined : { session: session.id, told: note.told };
    return note === undefined ? [] : [note.text];
  }

  /**
   * What to do with each piece of text the Clot writes during a turn: remember it and post it, in order. A text
   * that was streamed is stored under the ID its deltas were sent with, which finishes it.
   */
  private sayIn(): (text: string, key?: string) => void {
    return (text, key) => {
      const id = key === undefined ? undefined : this.streams.get(key);
      if (key !== undefined) this.streams.delete(key);
      this.d.store.appendTail(this.d.name, "clot", text);
      this.posts = this.posts.then(() => this.d.conv.post(this.d.name, text, { id }).then(() => undefined)).catch(() => undefined);
    };
  }

  /** Routes the message and runs the turn to its end. */
  private async runTurn(row: InboxRow, session: SessionRow, command: Command): Promise<TurnResult> {
    const { store, name } = this.d;
    const text = command.kind === "effort" ? command.rest : row.text;
    const decision = await this.d.router.decide({ clot: name, text, tail: store.tail(name, 4) });
    // The user's own choice of effort wins over the router's: given with this message, or set for it beforehand.
    // A one-off effort is spent on this message either way.
    const oneOff = store.takeNextEffort(name);
    const effort = (command.kind === "effort" ? command.effort : oneOff) ?? decision.effort;

    store.appendTail(name, "user", text);
    store.setInboxStatus(row.id, "running");
    const prompt = buildPrompt({ text, ...this.shared(session) });

    this.liveKind = "chat";
    // The user's own words: the one text a write the Clot asks for may be judged against.
    const context: TurnContext = { clot: name, kind: "chat", turnId: randomUUID(), outsider: row.outsider, userText: text };
    this.liveContext = context;
    const images = this.imagesOf(row.id);
    this.live = this.d.runner.startTurn({
      ...(session.started ? { resume: session.id } : { newSessionId: session.id }),
      prompt,
      ...(images.length === 0 ? {} : { images }),
      effort,
      role: "main",
      model: OPUS,
      tools: this.d.makeTools?.(context),
      roster: this.rosterPrompt(session),
      ...this.turnHooks(),
    });
    return this.live.done;
  }

  private scheduleResume(resetsAt: number): void {
    const { store, conv, name } = this.d;
    const delay = Math.max(0, resetsAt * 1000 - this.d.now().getTime());
    this.d.schedule(delay, () => {
      store.setPausedUntil(name, null);
      conv.setState(name, "idle");
      this.d.onResume?.(name);
      // A drain is active: either a message that arrived after the reset has already resumed
      // the session, or pause() is still posting its notice and will see the pause was lifted.
      if (this.draining) return;
      this.queueContinuation(resetsAt);
      void this.drain();
    });
  }

  /**
   * Replaces the active session with a new one: because the context filled up, or because the user
   * asked. The chat stays one chat: a note marks where the old session ended and the new one begins.
   * With a summary, the old session first writes a recap that seeds the new one; without, the new
   * session starts from nothing.
   *
   * Returns "paused" or "resumed" when the recap turn hit the usage limit: the
   * old session stays active and the handoff has not happened.
   */
  private async handoff(reason: SeedReason, summary: boolean): Promise<"done" | "failed" | "paused" | "resumed" | "done-paused"> {
    const { store, conv, name } = this.d;
    const old = store.activeSession(name)!;
    const words = HANDOFF_TEXT[reason];

    let recap: string | null = null;
    if (summary) {
      const parts: string[] = [];
      const recapTurn = this.d.runner.startTurn({
        resume: old.id,
        prompt: recapPrompt(reason, this.workerLines()),
        effort: "medium",
        role: "main",
        model: OPUS,
        roster: this.rosterPrompt(old),
        onText: (text) => void parts.push(text),
      });
      await conv.post(name, words.notice, { kind: "note" }).catch(() => undefined);
      conv.setState(name, "working");
      const recapResult = await recapTurn.done.finally(() => conv.setState(name, "idle"));
      this.touch(recapResult);
      await this.d.spend?.book({ clot: name, who: "main", sessionId: old.id, total: recapResult.totalCostUsd }).catch((error) => console.error(`[${name}] booking the recap's cost failed:`, error));
      if (recapResult.limit) {
        this.d.onLimit?.(recapResult.limit.resetsAt);
        return this.pause(recapResult.limit.resetsAt);
      }
      if (!recapResult.ok || parts.length === 0) {
        await conv.post(name, words.failed, { kind: "note" });
        return "failed";
      }
      recap = parts.join("\n\n");
    } else {
      await conv.post(name, words.notice.replace(/ Writing a handoff.*$/, ""), { kind: "note" }).catch(() => undefined);
    }

    // Saved before anything is announced: from here the new session is the live one,
    // and the recap is kept, even if a call below fails or the daemon stops.
    store.createSession({ id: this.d.newId(), clot: name, seed: recap, seedReason: reason });
    if (!summary) store.clearTail(name);
    await this.d.onSessionClosed?.(name).catch((error) => console.error(`[${name}] the after-rollover hook failed:`, error));
    if (!summary) store.clearNotes(name);

    const intro = recap === null ? "New session, started from scratch at your request. Nothing was carried over." : `${words.intro}\n\n${recap}`;
    await conv.post(name, intro, { kind: "note", recap: recap !== null }).catch((error) => console.error(`[${name}] handoff: posting the new session's first note failed:`, error));
    if (recap !== null) return this.reground(recap);
    return "done";
  }

  /**
   * Checks the recap against the current state before the new session's first turn. What differs is posted in the chat and
   * left as a note in front of that turn; nothing changed posts nothing. A check that failed says so and
   * leaves a note. One that hit the usage limit also pauses the Clot: there is no turn to continue, so the handoff
   * is done, and "done-paused" says so. Messages that arrive meanwhile wait: this runs inside the drain.
   */
  private async reground(recap: string): Promise<"done" | "done-paused"> {
    const { store, conv, name } = this.d;
    if (this.d.reground === undefined) return "done";
    conv.setState(name, "working");
    let outcome: RegroundOutcome;
    try {
      outcome = await this.d.reground(name, recap);
    } catch {
      outcome = { failed: true };
    } finally {
      conv.setState(name, "idle");
    }
    if ("changes" in outcome) {
      if (outcome.changes.length > 0) {
        await conv.post(name, `Since the recap was written:\n${outcome.changes.map((line) => `- ${line}`).join("\n")}`, { kind: "note" }).catch(() => undefined);
        store.addNote(name, regroundNote(outcome.changes));
      }
      return "done";
    }
    await conv.post(name, "I couldn't check the recap against the current state. Treat it with care.", { kind: "note" }).catch(() => undefined);
    store.addNote(name, REGROUND_FAILED_NOTE);
    if (outcome.limit === undefined) return "done";
    this.d.onLimit?.(outcome.limit);
    return (await this.pause(outcome.limit)) === "paused" ? "done-paused" : "done";
  }
}
