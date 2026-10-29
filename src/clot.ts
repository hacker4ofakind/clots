import type { AgentRunner, TurnHandle, TurnResult } from "./agent/runner.js";
import { buildPrompt, CONTINUE_TEXT, MIDTURN_PREFIX, recapPrompt } from "./agent/prompts.js";
import type { ChatAdapter, InboundMessage } from "./chat/adapter.js";
import { sessionChannelName } from "./chat/names.js";
import { makeRoom } from "./chat/room.js";
import { COMMAND_USAGE, parseCommand, type Command } from "./commands.js";
import { formatEvent, linkTo } from "./events/format.js";
import type { ClotEvent } from "./events/types.js";
import { OPUS } from "./models.js";
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
  /** One line per listed worker, for every prompt and the recap. */
  workerLines?: (clot: string) => string[];
  /** Called when a turn of this Clot hits the usage limit. resetsAt is in Unix seconds. */
  onLimit?: (resetsAt: number) => void;
  /** Called when this Clot's pause ends. */
  onResume?: (clot: string) => void;
}

/** A command the daemon answers at once, without a turn and without the session. */
type InstantCommand = Extract<Command, { kind: "invalid" | "effort" | "rules" | "memory" | "calendar" }>;

/** Returns the command when it is one answered at once; an `&effort` that carries a message is not. */
function instantCommand(command: Command): InstantCommand | undefined {
  return command.kind === "invalid" || command.kind === "rules" || command.kind === "memory" || command.kind === "calendar" || (command.kind === "effort" && command.rest === "") ? command : undefined;
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
  private liveKind: TurnKind = "chat";
  /** The last of the daemon's notes that the running turn was given, or 0 when it was given none. */
  private liveNotes = 0;
  private draining = false;
  private posts: Promise<void> = Promise.resolve();

  constructor(private d: ClotDeps) {}

  async init(): Promise<void> {
    const { store, chat, name } = this.d;
    if (!store.getClot(name)) store.upsertClot(name, await chat.ensureCategory(name));
    const clot = store.getClot(name)!;

    if (!store.activeSession(name)) {
      const channelId = await this.newChannel(clot.categoryId);
      store.createSession({ id: this.d.newId(), clot: name, channelId, seed: null });
      await chat.post(channelId, `${chat.mention(this.d.userId)} ${name} is ready.`);
    }

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
      const earlier = store.nextPending(name);
      if (earlier && earlier.id !== m.id) return;
      // A turn's authority is fixed when it starts. A message that arrives during an event's or a
      // worker's turn stays pending and gets a chat turn of its own, so it keeps the user's.
      if (this.liveKind !== "chat") return;
      const live = this.live;
      const text = command.kind === "effort" ? command.rest : m.text;
      const decision = await this.d.router.decide({ text, tail: store.tail(name, 4) });
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
      if (oneOff !== null) store.setNextEffort(name, null);
      store.appendTail(name, "user", text);
      store.setInboxStatus(m.id, "running");
      return;
    }
    await this.drain();
  }

  /** Whether a turn is running. */
  isBusy(): boolean {
    return this.live !== undefined;
  }

  /**
   * Puts an event in the queue for a locked turn of its own, and posts its one-line
   * notice. With kick false the caller is the Clot's own after-turn hook, and the
   * drain that called it carries on by itself.
   */
  async queueEvent(event: ClotEvent, notice: string, kick = true): Promise<void> {
    const { store, chat, name } = this.d;
    const session = store.activeSession(name)!;
    // Named by the Clot as well, so an event handed to another Clot is queued there too.
    store.enqueue({ id: `event:${name}:${event.id}`, clot: name, channelId: session.channelId, text: formatEvent(event, this.d.timeZone), receivedAt: event.receivedAt, kind: "event", eventId: event.id, outsider: event.outsider });
    store.setEventStatus(event.id, "queued");
    await chat.post(session.channelId, `${notice}${linkTo(event.url)}`).catch(() => undefined);
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
        const row = store.nextPending(name);
        if (!row) return;
        const keepGoing = await this.process(row);
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
    } else if (command.kind === "calendar") {
      const calendar = this.d.calendar;
      await chat.post(channelId, calendar === undefined ? "No calendar can be changed from this daemon." : await calendar.undo(name));
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
      result = isEvent ? await this.runEventTurn(row, session) : row.kind === "worker" || row.kind === "choice" ? await this.runWorkerTurn(row, session) : await this.runTurn(row, session, command);
    } finally {
      this.live = undefined;
      stopTyping();
    }
    await this.posts;
    if (result.activity && result.activity.files.length + result.activity.commands.length > 0) {
      await chat.postActivity(session.channelId, result.activity).catch(() => undefined);
    }
    await this.turnEnded(row.outsider);
    // The notes this turn was given have been read, unless it failed. One that arrived meanwhile waits for the next turn.
    if (result.ok && this.liveNotes > 0) store.clearNotes(name, this.liveNotes);
    this.liveNotes = 0;

    // The session exists on disk once any model response has come back.
    if (result.ok || result.contextPercent > 0) store.markSessionStarted(session.id);
    store.setInterrupted(session.id, false);
    store.finishRunning(name);

    if (!result.ok && !result.limit) {
      await chat.post(
        session.channelId,
        isEvent
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

    if (result.contextPercent >= this.d.rolloverPercent && (await this.handoff("context", true)) === "paused") return false;
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
   * After a reset: if a turn was cut off and nothing is waiting, queue a prompt that tells the session to carry on.
   * It is queued as what the cut-off turn was, so an investigation is picked up again under the lock.
   */
  private queueContinuation(resetsAt: number): void {
    const { store, name } = this.d;
    const session = store.activeSession(name)!;
    if (!session.interrupted || store.nextPending(name)) return;
    store.enqueue({ id: `resume-${resetsAt}`, clot: name, channelId: session.channelId, text: CONTINUE_TEXT, receivedAt: this.d.now().getTime(), kind: session.interruptedKind, eventId: session.interruptedEvent, outsider: session.interruptedOutsider });
  }

  /**
   * Runs an event as a turn of its own. The router still picks the effort. An event does
   * not use up a one-off effort: that belongs to the user's own messages.
   */
  private async runEventTurn(row: InboxRow, session: SessionRow): Promise<TurnResult> {
    const { store, name } = this.d;
    const decision = await this.d.router.decide({ text: row.text, tail: store.tail(name, 4) });
    // The event this turn is for. A turn that picks up a cut-off investigation is for the same one.
    const event = row.eventId === null ? undefined : store.getEvent(row.eventId);
    const standing = event === undefined ? [] : (this.d.standingFor?.(name, event) ?? []);
    store.setInboxStatus(row.id, "running");
    this.liveKind = "event";
    this.live = this.d.runner.startTurn({
      ...(session.started ? { resume: session.id } : { newSessionId: session.id }),
      prompt: buildPrompt({
        text: row.text,
        seed: session.seed,
        seedReason: session.seedReason,
        interrupted: session.interrupted,
        event: true,
        outsider: row.outsider,
        notes: this.takeNotes(),
        standing: standing.map((match) => ({ name: match.rule.name, text: match.filled })),
        workers: this.workerLines(),
      }),
      effort: decision.effort,
      role: "main",
      model: OPUS,
      tools: this.d.makeTools?.({ clot: name, kind: "event", event, outsider: row.outsider }),
      onText: this.sayIn(session.channelId),
    });
    return this.live.done;
  }

  /**
   * Runs a worker's report, question or failure as a turn of its own, at low effort, without the
   * router. It carries none of the user's authority: a report can quote outside text. A choice the
   * user did not answer in time runs the same way.
   */
  private runWorkerTurn(row: InboxRow, session: SessionRow): Promise<TurnResult> {
    const { store, name } = this.d;
    store.setInboxStatus(row.id, "running");
    this.liveKind = "worker";
    this.live = this.d.runner.startTurn({
      ...(session.started ? { resume: session.id } : { newSessionId: session.id }),
      prompt: buildPrompt({ text: row.text, seed: session.seed, seedReason: session.seedReason, interrupted: session.interrupted, notes: this.takeNotes(), workers: this.workerLines() }),
      effort: "low",
      role: "main",
      model: OPUS,
      tools: this.d.makeTools?.({ clot: name, kind: "worker", outsider: row.outsider, ...(row.kind === "choice" ? { fromTimeout: true } : {}) }),
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
    const decision = await this.d.router.decide({ text, tail: store.tail(name, 4) });
    // The user's own choice of effort wins over the router's: given with this message, or set for it beforehand.
    // A one-off effort is spent on this message either way.
    const oneOff = store.takeNextEffort(name);
    const effort = (command.kind === "effort" ? command.effort : oneOff) ?? decision.effort;

    store.appendTail(name, "user", text);
    store.setInboxStatus(row.id, "running");
    const prompt = buildPrompt({
      text,
      seed: session.seed,
      seedReason: session.seedReason,
      interrupted: session.interrupted,
      notes: this.takeNotes(),
      workers: this.workerLines(),
    });

    this.liveKind = "chat";
    this.live = this.d.runner.startTurn({
      ...(session.started ? { resume: session.id } : { newSessionId: session.id }),
      prompt,
      effort,
      role: "main",
      model: OPUS,
      tools: this.d.makeTools?.({ clot: name, kind: "chat", outsider: row.outsider }),
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
  private async handoff(reason: SeedReason, summary: boolean): Promise<"done" | "failed" | "paused" | "resumed"> {
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
        onText: (text) => void parts.push(text),
      });
      await chat.post(old.channelId, words.notice).catch(() => undefined);
      const stopTyping = chat.startTyping(old.channelId);
      const recapResult = await recapTurn.done.finally(stopTyping);
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
    return "done";
  }

  private async newChannel(categoryId: string): Promise<string> {
    // Best-effort: a full category makes the create below fail, which leaves the old session in place.
    await makeRoom(this.d.chat, this.d.store, this.d.name, categoryId).catch((error) => console.error(`[${this.d.name}] making room in the category failed:`, error));
    const names = await this.d.chat.listChannelNames(categoryId);
    return this.d.chat.createChannel(categoryId, sessionChannelName(this.d.name, this.d.now(), this.d.timeZone, names));
  }
}
