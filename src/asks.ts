import type { ChatAdapter, InboundMessage } from "./chat/adapter.js";
import { makeRoom } from "./chat/room.js";
import type { AskRow, InboxInsert, Store } from "./store.js";

export type { AskRow } from "./store.js";

export type AskKindName = "rule" | "email" | "merge" | "choice" | "memory" | "composio";

/** The inbox row an ask's close hands to its Clot, stored in the same transaction as the close. */
export interface HandOver {
  id: string;
  text: string;
  kind: "message" | "choice";
  outsider: boolean;
}

/** What a kind can do with its ask. Every close goes through `close`, which closes it exactly once. */
export interface AskIo<P> {
  /**
   * Closes the ask with the note for its Clot (and the inbox row, in the same transaction), deletes
   * its channel, posts the line in the live channel, tells clots-waiting, and kicks the Clot when a
   * row was handed over. Returns false when the ask was closed already: then nothing was done.
   */
  close(note: string | null, line: string | null, then?: { inbox: HandOver }): Promise<boolean>;
  /** Posts in the ask's channel. */
  repeat(text: string): Promise<void>;
  /** Moves the ask from open to busy, with a new payload if given. False when it was not open. */
  setBusy(payload?: P): boolean;
  /** Moves it back from busy to open, with a new payload if given. */
  reopen(payload?: P): void;
  /** Deletes the ask's channel now, before a long step: the answer is given. */
  dropChannel(): Promise<void>;
}

export interface AskKind<P> {
  kind: AskKindName;
  channelName(clot: string, existing: string[]): string;
  /** The text after the mention and the Clot's name. */
  render(clot: string, payload: P, ask: { deadline: number | null }): string;
  /** A line shown above the mention, when there is one. */
  lead?(payload: P): string | undefined;
  /** What the tool tells the Clot: put to the user, already with the user, too many open, or not asked (with the reason when one is known). */
  texts: { filed: string; already: string; full(open: number): string; notAsked(reason?: string): string };
  /** Called for every message from the user in the ask's channel while it is open. */
  onReply(ask: AskRow<P>, text: string, io: AskIo<P>): Promise<void>;
  /** At startup, for an ask left in "busy" by a stop: close it with what is known. */
  interrupted?(ask: AskRow<P>, io: AskIo<P>): Promise<void>;
  /** Hourly, at startup and before an answer is carried out: a reason withdraws it. */
  stale?(ask: AskRow<P>, now: number): string | undefined;
  /** Store writes that go with a withdrawal, in its transaction: a stop cannot fall between them. */
  withdrawn?(ask: AskRow<P>, reason: string): void;
  /** When its deadline passes. */
  onDeadline?(ask: AskRow<P>, io: AskIo<P>): Promise<void>;
}

export interface AsksDeps {
  store: Store;
  chat: ChatAdapter;
  userId: string;
  now: () => number;
  /** Starts the Clot's drain, so a row handed over runs. Does nothing for a Clot not loaded yet: it drains when it starts. */
  kick: (clot: string) => void;
  /** Posts in a Clot's live channel. Never throws. */
  say: (clot: string, text: string) => Promise<void>;
  /** A one-off timer; returns its cancel. */
  after: (ms: number, fn: () => void) => () => void;
  kinds: AskKind<any>[];
  /** Channels whose messages no ask and no Clot takes, such as clots-waiting. */
  ignore?: (channelId: string) => boolean;
}

/** How many asks opened from outsiders' turns a Clot may have open of one kind: outsiders cannot fill the user's slots. */
export const OUTSIDER_MAX = 2;

const STILL_SHOWN = "This is still being shown. Answer once all of it, and the list of answers, is here.";
const CLOSED = "This question is already closed.";
const INTERRUPTED = "This was being carried out when the daemon stopped; whether it finished is not known. Check before asking again.";

/**
 * Every question put to the user: a rule change, an email to send, a merge, a choice, a global
 * memory. Each is asked in a temporary channel and answered there to the daemon. This owns the
 * channel, the post, routing replies by channel, closing each ask exactly once, withdrawal, the
 * startup and hourly sweeps, deadlines, and telling clots-waiting what changed. The kinds own
 * what an answer does.
 */
export class Asks {
  /** Asks are opened one at a time, so a limit and the check for a repeat cannot be raced. */
  private opening: Promise<unknown> = Promise.resolve();
  private kinds: Map<string, AskKind<any>>;
  private listeners: (() => void)[] = [];
  private timers = new Map<number, () => void>();
  /** Channels of asks closed since the daemon started, which may still get a late message. */
  private closed = new Set<string>();

  constructor(private d: AsksDeps) {
    this.kinds = new Map(d.kinds.map((kind) => [kind.kind, kind]));
  }

  /** Called after every open, close and withdrawal. */
  onChange(fn: () => void): void {
    this.listeners.push(fn);
  }

  private changed(): void {
    for (const fn of this.listeners) fn();
  }

  /** Puts something to the user. Returns what the tool tells the Clot. */
  open<P>(kind: AskKind<P>, clot: string, payload: P, o: { summary: string; dedupe: string; max: number; deadline?: number; outsider?: boolean }): Promise<string> {
    const result = this.opening.then(() => this.openOne(kind, clot, payload, o));
    this.opening = result.catch(() => undefined);
    return result;
  }

  private async openOne<P>(kind: AskKind<P>, clot: string, payload: P, o: { summary: string; dedupe: string; max: number; deadline?: number; outsider?: boolean }): Promise<string> {
    const { store, chat } = this.d;
    const row = store.getClot(clot);
    if (!row) return kind.texts.notAsked();
    const open = store.openAsks(clot).filter((ask) => ask.kind === kind.kind);
    if (open.some((ask) => ask.dedupe === o.dedupe)) return kind.texts.already;
    if (open.length >= o.max) return kind.texts.full(open.length);
    const fromOutsiders = open.filter((ask) => ask.outsider).length;
    if (o.outsider && fromOutsiders >= OUTSIDER_MAX) return kind.texts.full(fromOutsiders);

    let channelId: string;
    let channelName: string;
    try {
      const noRoom = await makeRoom(chat, store, clot, row.categoryId);
      if (noRoom !== undefined) return kind.texts.notAsked(noRoom);
      channelName = kind.channelName(clot, await chat.listChannelNames(row.categoryId));
      channelId = await chat.createChannel(row.categoryId, channelName);
    } catch {
      return kind.texts.notAsked();
    }
    const deadline = o.deadline ?? null;
    const id = store.createAsk({ kind: kind.kind, clot, channelId, channelName, payload, summary: oneLine(o.summary), openedAt: this.d.now(), deadline, dedupe: o.dedupe, outsider: o.outsider === true });
    try {
      const lead = kind.lead?.(payload);
      await chat.post(channelId, `${lead === undefined ? "" : `${lead}\n`}${chat.mention(this.d.userId)} ${clot} ${kind.render(clot, payload, { deadline })}`);
    } catch {
      if (store.closeAsk(id, clot, null)) await chat.deleteChannel(channelId).catch(() => undefined);
      return kind.texts.notAsked();
    }
    // Answerable only now that the whole question and the answers are in the channel.
    store.moveAsk(id, "posting", "open");
    this.schedule(store.askById(id)!);
    this.changed();
    return kind.texts.filed;
  }

  /** Handles a message in an ask's channel. Returns false when the channel is not one, so the message belongs elsewhere. */
  async onReply(m: InboundMessage): Promise<boolean> {
    const { store, chat } = this.d;
    if (this.d.ignore?.(m.channelId)) return true;
    const ask = store.askByChannel(m.channelId);
    if (!ask) {
      if (!this.closed.has(m.channelId)) return false;
      if (m.authorId === this.d.userId) await chat.post(m.channelId, CLOSED).catch(() => undefined);
      return true;
    }
    if (m.authorId !== this.d.userId) return true;
    if (ask.state === "posting") {
      await chat.post(m.channelId, STILL_SHOWN).catch(() => undefined);
      return true;
    }
    // Already being carried out.
    if (ask.state !== "open") return true;
    const kind = this.kinds.get(ask.kind);
    if (!kind) return true;
    const reason = kind.stale?.(ask, this.d.now());
    if (reason !== undefined) {
      await this.withdraw(ask.id, reason);
      return true;
    }
    await kind.onReply(ask, m.text, this.io(ask));
    return true;
  }

  /** Withdraws an open ask: what it would act on changed, or it can no longer be answered. A busy one is never withdrawn. */
  async withdraw(id: number, reason: string): Promise<boolean> {
    const ask = this.d.store.askById(id);
    if (!ask || ask.state !== "open") return false;
    const kind = this.kinds.get(ask.kind);
    return this.finish(ask, `Withdrawn: ${ask.summary} (${reason}). Ask again if it still makes sense.`, `Withdrawn: ${ask.summary} (${reason})`, { onlyOpen: true, also: () => kind?.withdrawn?.(ask, reason) });
  }

  /** Withdraws every open ask of a kind whose payload matches. */
  async withdrawWhere<P>(kind: AskKindName, match: (payload: P) => boolean, reason: string): Promise<void> {
    for (const ask of this.d.store.openAsks()) {
      if (ask.kind === kind && ask.state === "open" && match(ask.payload as P)) await this.withdraw(ask.id, reason);
    }
  }

  /**
   * Closes what can no longer be answered. Hourly, and at startup with `starting`, which first
   * closes what a stop caught half-way: asks being shown are deleted, asks being carried out go to
   * their kind's `interrupted`. Then, for open asks only: an unknown kind, a reason from `stale`, a
   * channel that is gone (never on an error), and a deadline that has passed.
   */
  async sweep(starting: boolean): Promise<void> {
    const { store, chat } = this.d;
    if (starting) {
      for (const ask of store.openAsks()) {
        if (ask.state === "posting") {
          await this.finish(ask, `Withdrawn: ${ask.summary} (the daemon stopped while showing it). Ask again if it still makes sense.`, `Withdrawn: ${ask.summary} (the daemon stopped while showing it)`, {});
        } else if (ask.state === "busy") {
          const kind = this.kinds.get(ask.kind);
          if (kind?.interrupted) await kind.interrupted(ask, this.io(ask));
          else await this.finish(ask, `${ask.summary}: ${INTERRUPTED}`, `The daemon stopped while carrying this out, so whether it finished is not known: ${ask.summary}`, {});
        }
      }
    }
    for (const ask of store.openAsks()) {
      if (ask.state !== "open") continue;
      const kind = this.kinds.get(ask.kind);
      if (!kind) {
        await this.withdraw(ask.id, "this kind of question is switched off in the daemon");
        continue;
      }
      const reason = kind.stale?.(ask, this.d.now());
      if (reason !== undefined) {
        await this.withdraw(ask.id, reason);
        continue;
      }
      // The channel itself, not its name. Not knowing whether it exists is no reason to close anything.
      const exists = await chat.channelExists(ask.channelId).catch(() => undefined);
      if (exists === false) {
        await this.withdraw(ask.id, "its channel was removed");
        continue;
      }
      // In case a timer was lost.
      if (ask.deadline !== null && ask.deadline <= this.d.now()) await this.fire(ask.id);
    }
  }

  /** Schedules every open ask's deadline. Called once at startup; one already past fires at once. */
  startTimers(): void {
    for (const ask of this.d.store.openAsks()) if (ask.state === "open") this.schedule(ask);
  }

  private schedule(ask: AskRow): void {
    if (ask.deadline === null || !this.kinds.get(ask.kind)?.onDeadline || this.timers.has(ask.id)) return;
    this.timers.set(
      ask.id,
      this.d.after(Math.max(0, ask.deadline - this.d.now()), () => {
        this.timers.delete(ask.id);
        void this.fire(ask.id).catch((error) => console.error(`[${ask.clot}] an ask's deadline failed:`, error));
      }),
    );
  }

  private async fire(id: number): Promise<void> {
    const ask = this.d.store.askById(id);
    if (!ask || ask.state !== "open") return;
    await this.kinds.get(ask.kind)?.onDeadline?.(ask, this.io(ask));
  }

  private io<P>(ask: AskRow<P>): AskIo<P> {
    const { store, chat } = this.d;
    return {
      close: (note, line, then) => {
        const session = store.activeSession(ask.clot);
        // With no session to hand it to, the Clot still learns it from a note.
        const inbox: InboxInsert | undefined =
          then === undefined || session === undefined ? undefined : { ...then.inbox, clot: ask.clot, channelId: session.channelId, receivedAt: this.d.now() };
        return this.finish(ask, inbox === undefined && then !== undefined ? (note ?? then.inbox.text) : note, line, { inbox });
      },
      repeat: (text) => chat.post(ask.channelId, text).catch(() => undefined),
      setBusy: (payload) => {
        if (!store.moveAsk(ask.id, "open", "busy", payload)) return false;
        if (payload !== undefined) ask.payload = payload;
        return true;
      },
      reopen: (payload) => {
        store.moveAsk(ask.id, "busy", "open", payload);
        if (payload !== undefined) ask.payload = payload;
      },
      dropChannel: async () => {
        this.closed.add(ask.channelId);
        await chat.deleteChannel(ask.channelId).catch(() => undefined);
      },
    };
  }

  /** Closes an ask, then deletes its channel, posts the line, tells clots-waiting and kicks the Clot. False when it was closed already. */
  private async finish(ask: AskRow, note: string | null, line: string | null, o: { inbox?: InboxInsert; onlyOpen?: boolean; also?: () => void }): Promise<boolean> {
    if (!this.d.store.closeAsk(ask.id, ask.clot, note, o)) return false;
    this.closed.add(ask.channelId);
    this.timers.get(ask.id)?.();
    this.timers.delete(ask.id);
    await this.d.chat.deleteChannel(ask.channelId).catch(() => undefined);
    if (line !== null) await this.d.say(ask.clot, line);
    this.changed();
    if (o.inbox !== undefined) this.d.kick(ask.clot);
    return true;
  }
}

/** A summary as one line of at most 100 characters, with mentions and links made harmless, for clots-waiting. */
export function oneLine(text: string): string {
  const flat = text
    .split("\n")[0]
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<@/g, "<\\@")
    .replace(/@(everyone|here)/g, "@​$1")
    .trim();
  return flat.length > 100 ? `${flat.slice(0, 99)}…` : flat;
}
