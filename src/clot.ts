import type { AgentRunner, TurnHandle } from "./agent/runner.js";
import { buildPrompt, CONTINUE_TEXT, MIDTURN_PREFIX, RECAP_PROMPT } from "./agent/prompts.js";
import type { ChatAdapter, InboundMessage } from "./chat/adapter.js";
import { sessionChannelName } from "./chat/names.js";
import { nextMode, type Router } from "./router.js";
import type { InboxRow, Store } from "./store.js";

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
}

export class Clot {
  private live?: TurnHandle;
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

    if (clot.pausedUntil !== null && clot.pausedUntil * 1000 > this.d.now().getTime()) {
      this.scheduleResume(clot.pausedUntil);
    } else {
      store.setPausedUntil(name, null);
      await this.drain();
    }
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

    if (this.live) {
      const live = this.live;
      const decision = await this.d.router.decide({ text: m.text, mode: store.getClot(name)!.mode, tail: store.tail(name, 4) });
      if (this.live !== live) {
        // The turn ended while routing. The message is still pending; handle it as a normal turn.
        if (!this.draining) await this.drain();
        return;
      }
      store.appendTail(name, "user", m.text);
      store.setInboxStatus(m.id, "running");
      live.push(`${MIDTURN_PREFIX}\n${m.text}`, decision.effort);
      return;
    }
    if (!this.draining) await this.drain();
  }

  private async drain(): Promise<void> {
    const { store, name } = this.d;
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

  /** Runs one turn. Returns false when draining must stop (the Clot is now paused). */
  private async process(row: InboxRow): Promise<boolean> {
    const { store, chat, name } = this.d;
    const session = store.activeSession(name)!;
    const mode = store.getClot(name)!.mode;

    const decision = await this.d.router.decide({ text: row.text, mode, tail: store.tail(name, 4) });
    const newMode = nextMode(mode, decision.modeChange);
    if (newMode !== mode) {
      store.setMode(name, newMode);
      await chat.post(session.channelId, newMode === "brainstorm" ? "Brainstorm mode on." : "Brainstorm mode off. Back to work.");
    }

    store.appendTail(name, "user", row.text);
    store.setInboxStatus(row.id, "running");
    const prompt = buildPrompt({
      text: row.text,
      mode: newMode,
      modeChanged: newMode !== mode,
      seed: session.seed,
      interrupted: session.interrupted,
    });

    this.live = this.d.runner.startTurn({
      ...(session.started ? { resume: session.id } : { newSessionId: session.id }),
      prompt,
      effort: decision.effort,
      planMode: newMode === "brainstorm",
      onText: (text) => {
        store.appendTail(name, "clot", text);
        this.posts = this.posts.then(() => chat.post(session.channelId, text)).catch(() => undefined);
      },
    });
    const result = await this.live.done;
    this.live = undefined;
    await this.posts;

    // The session exists on disk once any model response has come back.
    if (result.ok || result.contextPercent > 0) store.markSessionStarted(session.id);
    store.setInterrupted(session.id, false);
    store.finishRunning(name);

    if (!result.ok && !result.limit) {
      await chat.post(session.channelId, "That turn ended with an error. Send your message again to retry.");
      return true;
    }

    if (result.limit) {
      store.setPausedUntil(name, result.limit.resetsAt);
      store.setInterrupted(session.id, true);
      const time = new Intl.DateTimeFormat("en-GB", { timeZone: this.d.timeZone, hour: "2-digit", minute: "2-digit" }).format(
        new Date(result.limit.resetsAt * 1000),
      );
      await chat.post(session.channelId, `Paused: usage limit reached. I'll resume at ${time}.`);
      this.scheduleResume(result.limit.resetsAt);
      return false;
    }

    if (result.contextPercent >= this.d.rolloverPercent) await this.rollover();
    return true;
  }

  private scheduleResume(resetsAt: number): void {
    const { store, name } = this.d;
    const delay = Math.max(0, resetsAt * 1000 - this.d.now().getTime());
    this.d.schedule(delay, () => {
      store.setPausedUntil(name, null);
      if (!store.nextPending(name)) {
        const session = store.activeSession(name)!;
        store.enqueue({ id: `resume-${resetsAt}`, clot: name, channelId: session.channelId, text: CONTINUE_TEXT, receivedAt: this.d.now().getTime() });
      }
      void this.drain();
    });
  }

  private async rollover(): Promise<void> {
    const { store, chat, name } = this.d;
    const old = store.activeSession(name)!;

    const parts: string[] = [];
    const recapTurn = await this.d.runner.startTurn({
      resume: old.id,
      prompt: RECAP_PROMPT,
      effort: "medium",
      planMode: true,
      onText: (text) => void parts.push(text),
    }).done;
    if (!recapTurn.ok || parts.length === 0) return; // Try again after the next turn.
    const recap = parts.join("\n\n");

    const channelId = await this.newChannel(store.getClot(name)!.categoryId);
    await chat.post(
      channelId,
      `${chat.mention(this.d.userId)} New session. This is the recap of the previous one. Correct anything that is wrong before I continue.\n\n${recap}`,
    );
    await chat.post(old.channelId, `This session is closed. Continued in ${chat.channelLink(channelId)}.`);
    await chat.makeReadOnly(old.channelId);
    store.createSession({ id: this.d.newId(), clot: name, channelId, seed: recap });
  }

  private async newChannel(categoryId: string): Promise<string> {
    const names = await this.d.chat.listChannelNames(categoryId);
    return this.d.chat.createChannel(categoryId, sessionChannelName(this.d.name, this.d.now(), this.d.timeZone, names));
  }
}
