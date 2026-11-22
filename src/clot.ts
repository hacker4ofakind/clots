import type { AgentRunner, TurnHandle, TurnResult } from "./agent/runner.js";
import { buildPrompt, CONTINUE_TEXT, MIDTURN_PREFIX, recapPrompt } from "./agent/prompts.js";
import type { ChatAdapter, InboundMessage } from "./chat/adapter.js";
import { sessionChannelName } from "./chat/names.js";
import { makeRoom } from "./chat/room.js";
import { COMMAND_USAGE, parseCommand, type Command } from "./commands.js";
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
  chat: ChatAdapter;
  router: Router;
  runner: AgentRunner;
  timeZone: string;
  userId: string;
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
  /** Answers `&rules` and `&rules undo`. */
  rules?: { list(clot: string): string; undo(clot: string): string };
  /** Called when a session has been replaced by a new one. */
  onSessionClosed?: (clot: string) => Promise<void>;
  /** Called before each turn starts, when no turn of this Clot is running: brings its global memories up to date. */
  beforeTurn?: (clot: string) => Promise<void>;
  /** Answers `&memory` and `&memory undo`. */
  memory?: { list(): string; undo(): Promise<string> };
  /** Answers `&calendar undo`. Absent when no calendar can be changed. */
  calendar?: { undo(clot: string): Promise<string> };
  /** Answers `&composio undo`. Absent when no Composio account is configured. */
  composio?: { undo(clot: string): Promise<string>; /** Answers `&composio reconnect <toolkit>:<account>`. */ reconnect(account: string): Promise<string> };
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
  /** The spend log: books each turn's cost, and answers `&spend`. */
  spend?: { book(a: BookArgs): Promise<void>; report(clot: string): Promise<string> };
  /** Checks a recap against the current state before the new session's first turn. Absent: the recap is taken as written. */
  reground?: (clot: string, recap: string) => Promise<RegroundOutcome>;
  /** Every Clot the daemon runs, this one included, each with a line on what it looks after. Absent: the Clot is told of no others. */
  roster?: () => RosterEntry[];
}

/** A command the daemon answers at once, without a turn and without the session. */
type InstantCommand = Extract<Command, { kind: "invalid" | "effort" | "rules" | "memory" | "calendar" | "composio" | "spend" }>;

/** Returns the command when it is one answered at once; an `&effort` that carries a message is not. */
function instantCommand(command: Command): InstantCommand | undefined {
  return command.kind === "invalid" || command.kind === "rules" || command.kind === "memory" || command.kind === "calendar" || command.kind === "composio" || command.kind === "spend" || (command.kind === "effort" && command.rest === "") ? command : undefined;
}

const HANDOFF_TEXT: Record<SeedReason, { notice: string; failed: string; intro: string; closed: string }> = {
  context: {
    notice: "This thread hit the context limit and will be closed. Waiting on handoff...",
    failed: "The handoff could not be written. This thread stays open; I'll try again after the next message.",
    intro: "New session. This is the recap of the previous one. Correct anything that is wrong before I continue.",
    closed: "This session is closed.",
  },
  user: {
    notice: "Closing this session at your request. Waiting on handoff...",
    failed: "The handoff could not be written, so this session stays open. Send `&close` to try again, or `&close nosummary` to start without one.",
    intro: "New session, started at your request. This is the recap of the previous one. Correct anything that is wrong before I continue.",
    closed: "This session was closed at your request.",
  },
};

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

  constructor(private d: ClotDeps) {
    if (d.roster) this.roster = new SessionRoster({ store: d.store, name: d.name, roster: d.roster });
  }

  async init(): Promise<void> {
    const { store, chat, name } = this.d;
    if (!store.getClot(name)) store.upsertClot(name, await chat.ensureCategory(name));
    const clot = store.getClot(name)!;

    if (!store.activeSession(name)) {
      const channelId = await this.newChannel(clot.categoryId);
      store.createSession({ id: this.d.newId(), clot: name, channelId, seed: null });
      await chat.post(channelId, `${chat.mention(this.d.userId)} ${name} is ready.`);
    }

    // A session that already ran has a cache of unknown age: its keep-warm clock starts now.
    if (store.activeSession(name)!.started && this.lastTurnAt() === undefined) store.setState(`last-turn:${name}`, String(this.d.now().getTime()));

    if (store.requeueRunning(name) > 0) store.setInterrupted(store.activeSession(name)!.id, true);
    // Nothing is running after a restart either.
    await this.turnEnded();

    // A pause that expired while the daemon was down still goes through the resume path, so the cut-off work continues.
    if (clot.pausedUntil !== null) this.scheduleResume(clot.pausedUntil);
    else await this.drain();
  }

  async onMessage(m: InboundMessage): Promise<void> {
    const { store, chat, name } = this.d;
    if (m.authorId !== this.d.userId) return;

    const session = store.activeSession(name)!;
    if (m.channelId !== session.channelId) {
      await chat.post(m.channelId, `This session is closed. Continue in ${chat.channelLink(session.channelId)}.`);
      return;
    }
    if (!store.enqueue({ id: m.id, clot: name, channelId: m.channelId, text: m.text, receivedAt: m.at.getTime() })) return;

    const command = parseCommand(m.text);
    const instant = instantCommand(command);
    if (instant) {
      await this.runInstant(m.id, session.channelId, instant);
      return;
    }

    if (this.live) {
      if (command.kind === "close") {
        // Stays pending; the drain loop closes the session once this turn is over.
        await chat.post(session.channelId, "I'll close this session when the current turn finishes.");
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
      const text = command.kind === "effort" ? command.rest : m.text;
      const decision = await this.d.router.decide({ clot: name, text, tail: store.tail(name, 4) });
      if (this.live !== live) {
        // The turn ended while routing. The message is still pending; handle it as a normal turn.
        await this.drain();
        return;
      }
      const oneOff = store.nextEffort(name);
      const effort = (command.kind === "effort" ? command.effort : oneOff) ?? decision.effort;
      // Refused once the turn's input has closed; the message then stays pending for the next turn,
      // and a one-off effort is kept for it.
      if (!live.push(`${MIDTURN_PREFIX}\n${text}`, effort)) return;
      if (this.liveContext) this.liveContext.userText = `${this.liveContext.userText ?? ""}\n\n${text}`.trim();
      if (oneOff !== null) store.setNextEffort(name, null);
      store.appendTail(name, "user", text);
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
        await this.pause(session.channelId, result.limit.resetsAt);
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

  /** A request the user made of another Clot that only this one can carry out: queued as the user's own message here, and posted in this Clot's channel. */
  async queueRequest(from: string, request: string): Promise<string> {
    const { store, chat, name } = this.d;
    const session = store.activeSession(name)!;
    store.enqueue({
      id: `request:${name}:${this.d.now().getTime()}:${from}`,
      clot: name,
      channelId: session.channelId,
      text: `[The user asked the ${from} Clot for the following, and it passed it to you. Carry it out as if the user said it here; answer here.]
${request}`,
      receivedAt: this.d.now().getTime(),
    });
    await chat.post(session.channelId, `Passed on from ${from}, at the user's request:
${request}`.slice(0, 1900)).catch(() => undefined);
    this.kick();
    return chat.channelLink(session.channelId);
  }

  /**
   * Puts an event in the queue for a locked turn of its own, and posts its one-line
   * notice. With kick false the caller is the Clot's own after-turn hook, and the
   * drain that called it carries on by itself.
   */
  async queueEvent(event: ClotEvent, notice: string, kick = true): Promise<void> {
    const { store, chat, name } = this.d;
    const session = store.activeSession(name)!;
    // Under a gate an ordinary event waits: it gets its notice now, with when the gate is expected to lift, and arrives later in a digest.
    const gate = this.gateState();
    const waits = gate.holds !== null && store.getEvent(event.id)?.urgent !== true;
    // Named by the Clot as well, so an event handed to another Clot is queued there too.
    store.enqueue({ id: `event:${name}:${event.id}`, clot: name, channelId: session.channelId, text: formatEvent(event, this.d.timeZone), receivedAt: event.receivedAt, kind: "event", eventId: event.id, outsider: event.outsider, gated: waits });
    store.setEventStatus(event.id, "queued");
    const until = waits ? waitingUntil(gate, this.d.timeZone, this.d.now().getTime()) : "";
    await chat.post(session.channelId, `${notice}${until}${linkTo(event.url)}`).catch(() => undefined);
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

  private async runInstant(id: string, channelId: string, command: InstantCommand): Promise<void> {
    const { store, chat, name } = this.d;
    store.setInboxStatus(id, "done");
    if (command.kind === "effort") {
      store.setNextEffort(name, command.effort);
      await chat.post(channelId, `Effort for your next message: ${command.effort}.`);
    } else if (command.kind === "rules") {
      const rules = this.d.rules;
      await chat.post(channelId, rules === undefined ? "The rulebook is not available." : command.undo ? rules.undo(name) : rules.list(name));
    } else if (command.kind === "memory") {
      const memory = this.d.memory;
      await chat.post(channelId, memory === undefined ? "Global memory is not available." : command.undo ? await memory.undo() : memory.list());
    } else if (command.kind === "spend") {
      const spend = this.d.spend;
      await chat.post(channelId, spend === undefined ? "Spend is not tracked here." : await spend.report(name));
    } else if (command.kind === "calendar") {
      const calendar = this.d.calendar;
      await chat.post(channelId, calendar === undefined ? "No calendar can be changed from this daemon." : await calendar.undo(name));
    } else if (command.kind === "composio") {
      const composio = this.d.composio;
      await chat.post(channelId, composio === undefined ? "No Composio account is configured." : "reconnect" in command ? await composio.reconnect(command.reconnect) : await composio.undo(name));
    } else {
      await chat.post(channelId, `I don't know \`&${command.name}\` used that way. ${COMMAND_USAGE}`);
    }
  }

  /** Handles one pending message. Returns false when draining must stop (the Clot is now paused). */
  private async process(row: InboxRow): Promise<boolean> {
    const { store, chat, name } = this.d;
    const session = store.activeSession(name)!;

    // An event or a worker's report is data: text in it that looks like a command is not one.
    const isEvent = row.kind === "event";
    const command: Command = row.kind !== "message" ? { kind: "none" } : parseCommand(row.text);
    const instant = instantCommand(command);
    if (instant) {
      await this.runInstant(row.id, session.channelId, instant);
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
        await chat.post(session.channelId, "Recap discarded. This session now starts from scratch.");
      } else {
        await chat.post(session.channelId, "This session is already fresh; there is nothing to close.");
      }
      store.setInboxStatus(row.id, "done");
      return true;
    }

    const stopTyping = chat.startTyping(session.channelId);
    // Between turns, so the daemon never writes in the memory folder while the Clot may be writing there too.
    await this.d.beforeTurn?.(name).catch((error) => console.error(`[${name}] syncing global memories failed:`, error));
    let result: TurnResult;
    try {
      result = row.kind === "digest" ? await this.runDigestTurn(row, session) : isEvent ? await this.runEventTurn(row, session) : row.kind === "worker" || row.kind === "choice" ? await this.runWorkerTurn(row, session) : await this.runTurn(row, session, command);
    } finally {
      this.live = undefined;
      this.liveContext = undefined;
      stopTyping();
    }
    await this.posts;
    this.touch(result);
    await this.d.spend?.book({ clot: name, who: "main", sessionId: session.id, total: result.totalCostUsd }).catch((error) => console.error(`[${name}] booking the turn's cost failed:`, error));
    if (result.activity && result.activity.files.length + result.activity.commands.length > 0) {
      await chat.postActivity(session.channelId, result.activity).catch(() => undefined);
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
      await chat.post(
        session.channelId,
        row.kind === "digest"
          ? `Looking into these events ended with an error: ${store.digestEvents(row.eventId ?? "").map((event) => event.id).join(", ")}. Ask me about any of them to try again.`
          : isEvent
          ? "Looking into that event ended with an error. Ask me about it to try again."
          : row.kind === "worker"
            ? "Reading a worker's report ended with an error. Ask me about the worker to try again."
            : row.kind === "choice"
              ? "Going on with my pick ended with an error. Answer the choice here to try again."
            : "That turn ended with an error. Send your message again to retry.",
      );
      return true;
    }

    if (result.limit) {
      store.setInterrupted(session.id, true, row.kind, row.eventId, row.outsider);
      // The limit is the account's: the workers wait for the same reset.
      this.d.onLimit?.(result.limit.resetsAt);
      return (await this.pause(session.channelId, result.limit.resetsAt)) === "resumed";
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
  private async pause(channelId: string, resetsAt: number): Promise<"paused" | "resumed"> {
    const { store, chat, name } = this.d;
    store.setPausedUntil(name, resetsAt);
    // Scheduled before the notice: a failed post must not leave the Clot paused with no wake-up.
    this.scheduleResume(resetsAt);
    const time = new Intl.DateTimeFormat("en-GB", { timeZone: this.d.timeZone, hour: "2-digit", minute: "2-digit" }).format(new Date(resetsAt * 1000));
    await chat.post(channelId, `Paused: usage limit reached. I'll resume at ${time}.`).catch(() => undefined);
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
    store.enqueue({ id: `resume-${resetsAt}`, clot: name, channelId: session.channelId, text: CONTINUE_TEXT, receivedAt: this.d.now().getTime(), kind: session.interruptedKind, eventId: session.interruptedEvent, outsider: session.interruptedOutsider });
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
      tools: this.d.makeTools?.({ clot: name, kind: "event", event, outsider: row.outsider }),
      roster: this.rosterPrompt(session),
      onText: this.sayIn(session.channelId),
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
      // Told to carry on only in the session that was cut off. A session that never ran (a `&close` came in between) gets the events in full.
      prompt: buildPrompt({ text: row.id.startsWith("resume-") && session.started ? CONTINUE_TEXT : digestText(entries, this.d.timeZone), ...this.shared(session), event: true, outsider: row.outsider }),
      effort: decision.effort,
      role: "main",
      model: OPUS,
      tools: this.d.makeTools?.({ clot: name, kind: "event", digest: events, outsider: row.outsider }),
      roster: this.rosterPrompt(session),
      onText: this.sayIn(session.channelId),
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
      tools: this.d.makeTools?.({ clot: name, kind: "worker", outsider: row.outsider, ...(row.kind === "choice" ? { fromTimeout: true } : {}) }),
      roster: this.rosterPrompt(session),
      onText: this.sayIn(session.channelId),
    });
    return this.live.done;
  }

  private workerLines(): string[] {
    return this.d.workerLines?.(this.d.name) ?? [];
  }

  /** Pauses this Clot until the usage limit resets, telling the user in its live channel. For a limit a worker hit. */
  async pauseFor(resetsAt: number): Promise<void> {
    const session = this.d.store.activeSession(this.d.name);
    if (!session) return;
    const paused = this.d.store.getClot(this.d.name)!.pausedUntil;
    if (paused !== null && paused >= resetsAt) return;
    await this.pause(session.channelId, resetsAt);
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

  /** What to do with each piece of text the Clot writes during a turn: remember it and post it, in order. */
  private sayIn(channelId: string): (text: string) => void {
    return (text) => {
      this.d.store.appendTail(this.d.name, "clot", text);
      this.posts = this.posts.then(() => this.d.chat.post(channelId, text)).catch(() => undefined);
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
    const context: TurnContext = { clot: name, kind: "chat", outsider: row.outsider, userText: text };
    this.liveContext = context;
    this.live = this.d.runner.startTurn({
      ...(session.started ? { resume: session.id } : { newSessionId: session.id }),
      prompt,
      effort,
      role: "main",
      model: OPUS,
      tools: this.d.makeTools?.(context),
      roster: this.rosterPrompt(session),
      onText: this.sayIn(session.channelId),
    });
    return this.live.done;
  }

  private scheduleResume(resetsAt: number): void {
    const { store, name } = this.d;
    const delay = Math.max(0, resetsAt * 1000 - this.d.now().getTime());
    this.d.schedule(delay, () => {
      store.setPausedUntil(name, null);
      this.d.onResume?.(name);
      // A drain is active: either a message that arrived after the reset has already resumed
      // the session, or pause() is still posting its notice and will see the pause was lifted.
      if (this.draining) return;
      this.queueContinuation(resetsAt);
      void this.drain();
    });
  }

  /**
   * Replaces the active session with a new one in a new channel: because the
   * context filled up, or because the user asked. With a summary, the old
   * session first writes a recap that seeds the new one; without, the new
   * session starts from nothing.
   *
   * Returns "paused" or "resumed" when the recap turn hit the usage limit: the
   * old session stays active and the handoff has not happened.
   */
  private async handoff(reason: SeedReason, summary: boolean): Promise<"done" | "failed" | "paused" | "resumed" | "done-paused"> {
    const { store, chat, name } = this.d;
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
      await chat.post(old.channelId, words.notice).catch(() => undefined);
      const stopTyping = chat.startTyping(old.channelId);
      const recapResult = await recapTurn.done.finally(stopTyping);
      this.touch(recapResult);
      await this.d.spend?.book({ clot: name, who: "main", sessionId: old.id, total: recapResult.totalCostUsd }).catch((error) => console.error(`[${name}] booking the recap's cost failed:`, error));
      if (recapResult.limit) {
        this.d.onLimit?.(recapResult.limit.resetsAt);
        return this.pause(old.channelId, recapResult.limit.resetsAt);
      }
      if (!recapResult.ok || parts.length === 0) {
        await chat.post(old.channelId, words.failed);
        return "failed";
      }
      recap = parts.join("\n\n");
    }

    const channelId = await this.newChannel(store.getClot(name)!.categoryId);
    // Saved before anything is announced: from here the new channel is the live one,
    // and the recap is kept, even if a call below fails or the daemon stops.
    store.createSession({ id: this.d.newId(), clot: name, channelId, seed: recap, seedReason: reason });
    if (!summary) store.clearTail(name);
    await this.d.onSessionClosed?.(name).catch((error) => console.error(`[${name}] the after-rollover hook failed:`, error));
    if (!summary) store.clearNotes(name);

    const intro = recap === null ? "New session, started from scratch at your request. Nothing was carried over." : `${words.intro}\n\n${recap}`;
    const failed = (step: string) => (error: unknown) => console.error(`[${name}] handoff: ${step} failed:`, error);
    await chat.post(channelId, `${chat.mention(this.d.userId)} ${intro}`).catch(failed("posting to the new channel"));
    await chat.post(old.channelId, `${words.closed} Continued in ${chat.channelLink(channelId)}.`).catch(failed("posting the closing link"));
    await chat.makeReadOnly(old.channelId).catch(failed("making the old channel read-only"));
    if (recap !== null) return this.reground(channelId, recap);
    return "done";
  }

  /**
   * Checks the recap against the current state before the new session's first turn. What differs is posted in the new
   * channel and left as a note in front of that turn; nothing changed posts nothing. A check that failed says so and
   * leaves a note. One that hit the usage limit also pauses the Clot: there is no turn to continue, so the handoff
   * is done, and "done-paused" says so. Messages that arrive meanwhile wait: this runs inside the drain.
   */
  private async reground(channelId: string, recap: string): Promise<"done" | "done-paused"> {
    const { store, chat, name } = this.d;
    if (this.d.reground === undefined) return "done";
    const stopTyping = chat.startTyping(channelId);
    let outcome: RegroundOutcome;
    try {
      outcome = await this.d.reground(name, recap);
    } catch {
      outcome = { failed: true };
    } finally {
      stopTyping();
    }
    if ("changes" in outcome) {
      if (outcome.changes.length > 0) {
        await chat.post(channelId, `Since the recap was written:\n${outcome.changes.map((line) => `- ${line}`).join("\n")}`).catch(() => undefined);
        store.addNote(name, regroundNote(outcome.changes));
      }
      return "done";
    }
    await chat.post(channelId, "I couldn't check the recap against the current state. Treat it with care.").catch(() => undefined);
    store.addNote(name, REGROUND_FAILED_NOTE);
    if (outcome.limit === undefined) return "done";
    this.d.onLimit?.(outcome.limit);
    return (await this.pause(channelId, outcome.limit)) === "paused" ? "done-paused" : "done";
  }

  private async newChannel(categoryId: string): Promise<string> {
    // Best-effort: a full category makes the create below fail, which leaves the old session in place.
    await makeRoom(this.d.chat, this.d.store, this.d.name, categoryId).catch((error) => console.error(`[${this.d.name}] making room in the category failed:`, error));
    const names = await this.d.chat.listChannelNames(categoryId);
    return this.d.chat.createChannel(categoryId, sessionChannelName(this.d.name, this.d.now(), this.d.timeZone, names));
  }
}
