import type { Conversation } from "./conversation/conversation.js";
import type { AskRow, InboxInsert, Store } from "./store.js";
import type { AskResult } from "@clots/ui-api-schemas";
import type { UiEventType } from "./ui-api/events.js";

export type { AskRow } from "./store.js";
export type { AskResult } from "@clots/ui-api-schemas";

export type AskKindName = "rule" | "email" | "merge" | "choice" | "memory" | "composio" | "config" | "restart";

/** The inbox row an ask's close hands to its Clot, stored in the same transaction as the close. */
export interface HandOver {
  id: string;
  text: string;
  kind: "message" | "choice";
  outsider: boolean;
}

/** What the user answers an ask with. A choice's options are 0 and 1 here; the stored pick is 1 or 2. */
export type AskAnswer = { action: "allow" } | { action: "block" } | { action: "edit"; body: string } | { action: "pick"; option: 0 | 1 };

export type AskTimer = "calm" | "calling" | "urgent";

/** What a card shows of an ask. The web app lays it out; the daemon only says what is in it. */
export interface AskView {
  /** "Send an email from Home?" */
  heading: string;
  /** The same on a phone: "Allow sending an email?" */
  shortHeading: string;
  /** Labelled details, shown as a two-column list. */
  rows: { label: string; value: string; href?: string }[];
  /** A longer text under the details (an email's body, a rule's text, a JSON value). */
  body?: string;
  /** What the body replaces, shown before it: a configuration key's value now, a memory's text in force. */
  previous?: string;
  /** The body can be changed before answering. */
  bodyEditable?: boolean;
  /** The buttons' words, when they are not Approve and Decline. */
  labels?: { allow: string; block: string };
  /** A choice's two options, and the Clot's pick (0 or 1). */
  options?: [string, string];
  pick?: 0 | 1;
  /** A line above the card's details, such as "From an outsider's report.". */
  warning?: string;
}

/** What a kind can do with its ask. Every close goes through `close`, which closes it exactly once. */
export interface AskIo<P> {
  /**
   * Closes the ask, saying how it `result`ed (the card's icon follows it, never the words), with the note for its Clot (and the inbox row, in the same transaction), shows the
   * outcome `line` in the chat and on the card, tells the UI, and kicks the Clot when a row was handed
   * over. `outcome` is what the card says when it differs from the line (or there is no line). Returns false
   * when the ask was closed already: then nothing was done.
   */
  close(result: AskResult, note: string | null, line: string | null, then?: { inbox: HandOver }, outcome?: string): Promise<boolean>;
  /** Says something in the Clot's chat, as a note. */
  say(text: string): Promise<void>;
  /** Moves the ask from open to busy, with a new payload if given. False when it was not open. */
  setBusy(payload?: P): boolean;
  /** Moves it back from busy to open, with a new payload if given. */
  reopen(payload?: P): void;
}

export interface AskKind<P> {
  kind: AskKindName;
  /** What the card shows. */
  view(clot: string, payload: P, ask: { deadline: number | null }): AskView;
  /** What the tool tells the Clot: put to the user, already with the user, too many open, or not asked (with the reason when one is known). */
  texts: { filed: string; already: string; full(open: number): string; notAsked(reason?: string): string };
  /** Which answers this kind takes. */
  answers: AskAnswer["action"][];
  /** Called when the user answers with a button. */
  onAnswer(ask: AskRow<P>, answer: AskAnswer, io: AskIo<P>): Promise<void>;
  /**
   * Called for a message the user types in the Clot's chat while this ask is open: the kind's "any other
   * reply", handed to the Clot as feedback. A kind without it leaves the message to the Clot.
   */
  onFeedback?(ask: AskRow<P>, text: string, io: AskIo<P>): Promise<void>;
  /** When its deadline passes. */
  onDeadline(ask: AskRow<P>, io: AskIo<P>): Promise<void>;
  /** At startup, for an ask left in "busy" by a stop: close it with what is known. */
  interrupted?(ask: AskRow<P>, io: AskIo<P>): Promise<void>;
  /** Hourly, at startup and before an answer is carried out: a reason withdraws it. */
  stale?(ask: AskRow<P>, now: number): string | undefined;
  /** Store writes that go with a withdrawal, in its transaction: a stop cannot fall between them. */
  withdrawn?(ask: AskRow<P>, reason: string): void;
}

/** An ask as the API and the stream show it. */
export interface AskSnapshot {
  id: number;
  clot: string;
  kind: AskKindName;
  summary: string;
  view: AskView;
  /** Unix milliseconds. */
  deadline: number;
  timer: AskTimer;
  /** "busy" while the answer is being carried out. */
  state: "open" | "busy";
  openedAt: number;
  outsider: boolean;
}

export interface AsksDeps {
  store: Store;
  conv: Conversation;
  now: () => number;
  /** Starts the Clot's drain, so a row handed over runs. Does nothing for a Clot not loaded yet: it drains when it starts. */
  kick: (clot: string) => void;
  /** A one-off timer; returns its cancel. */
  after: (ms: number, fn: () => void) => () => void;
  kinds: AskKind<any>[];
  /** Sends an event to the UI. */
  emit: (type: UiEventType, data: unknown) => void;
  /** How long an ask waits for its answer, in milliseconds. Read each time: the setting changes while the daemon runs. */
  timeoutMs: () => number;
}

/** How many asks opened from outsiders' turns a Clot may have open of one kind: outsiders cannot fill the user's slots. */
export const OUTSIDER_MAX = 2;

/** The timer's calm, calling and urgent thresholds, in milliseconds before the deadline. */
export const CALLING_MS = 5 * 60_000;
export const URGENT_MS = 60_000;

export const timerState = (deadline: number, now: number): AskTimer => (deadline - now <= URGENT_MS ? "urgent" : deadline - now <= CALLING_MS ? "calling" : "calm");

const INTERRUPTED = "This was being carried out when the daemon stopped; whether it finished is not known. Check before asking again.";

/** What answering an ask told the caller. */
export type AnswerResult =
  /** The answer was carried out, or is being: `outcome` is how it ended (null when it is still going). */
  | { status: "answered"; outcome: string | null; result: AskResult | null }
  /** It had closed before: how it ended. */
  | { status: "closed"; outcome: string; result: AskResult | null }
  /** It is being carried out for an answer already given. */
  | { status: "busy"; outcome: "in progress" }
  /** No such ask. */
  | { status: "missing" }
  /** The answer is not one this kind takes. */
  | { status: "invalid"; reason: string };

/**
 * Every question put to the user: a rule change, an email to send, a merge, a choice, a global memory. Each is a
 * card in the Clot's chat and a row in Waiting for you, answered with buttons. This owns opening them, answering
 * and closing each exactly once, withdrawal, the startup and hourly sweeps, deadlines (which block an ask,
 * except a choice, which goes with the Clot's pick) and telling the UI what changed. The kinds own what an answer does.
 */
export class Asks {
  /** Asks are opened one at a time, so a limit and the check for a repeat cannot be raced. */
  private opening: Promise<unknown> = Promise.resolve();
  private kinds: Map<string, AskKind<any>>;
  private listeners: (() => void)[] = [];
  private timers = new Map<number, (() => void)[]>();
  /** The idempotency key of the answer being carried out, by ask. */
  private keys = new Map<number, string>();

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

  /** What the card of an ask shows, and where it stands. */
  snapshot(ask: AskRow): AskSnapshot | undefined {
    const kind = this.kinds.get(ask.kind);
    if (!kind) return undefined;
    const deadline = ask.deadline ?? this.d.now() + this.d.timeoutMs();
    return { id: ask.id, clot: ask.clot, kind: ask.kind as AskKindName, summary: ask.summary, view: kind.view(ask.clot, ask.payload, { deadline }), deadline, timer: timerState(deadline, this.d.now()), state: ask.state, openedAt: ask.openedAt, outsider: ask.outsider };
  }

  /** Every ask waiting for the user, oldest first. */
  list(): AskSnapshot[] {
    return this.d.store.openAsks().flatMap((ask) => this.snapshot(ask) ?? []);
  }

  /** Puts something to the user. Returns what the tool tells the Clot. */
  open<P>(kind: AskKind<P>, clot: string, payload: P, o: { summary: string; dedupe: string; max: number; deadline?: number; outsider?: boolean }): Promise<string> {
    const result = this.opening.then(() => this.openOne(kind, clot, payload, o));
    this.opening = result.catch(() => undefined);
    return result;
  }

  private async openOne<P>(kind: AskKind<P>, clot: string, payload: P, o: { summary: string; dedupe: string; max: number; deadline?: number; outsider?: boolean }): Promise<string> {
    const { store } = this.d;
    if (!store.getClot(clot)) return kind.texts.notAsked();
    const open = store.openAsks(clot).filter((ask) => ask.kind === kind.kind);
    if (open.some((ask) => ask.dedupe === o.dedupe)) return kind.texts.already;
    if (open.length >= o.max) return kind.texts.full(open.length);
    const fromOutsiders = open.filter((ask) => ask.outsider).length;
    if (o.outsider && fromOutsiders >= OUTSIDER_MAX) return kind.texts.full(fromOutsiders);

    const deadline = o.deadline ?? this.d.now() + this.d.timeoutMs();
    const id = store.createAsk({ kind: kind.kind, clot, payload, summary: oneLine(o.summary), openedAt: this.d.now(), deadline, dedupe: o.dedupe, outsider: o.outsider === true });
    try {
      await this.d.conv.postAsk(clot, id);
    } catch {
      store.closeAsk(id, clot, null);
      return kind.texts.notAsked();
    }
    this.schedule(store.askById(id)!);
    const snapshot = this.snapshot(store.askById(id)!);
    if (snapshot) this.d.emit("ask.opened", snapshot);
    this.changed();
    return kind.texts.filed;
  }

  /**
   * Handles a message the user typed in a Clot's chat: when one of its open asks takes feedback, the
   * message goes to it (the newest such ask) and the ask closes. Returns false when the message is the
   * Clot's to read.
   */
  async onUserMessage(clot: string, text: string): Promise<boolean> {
    const { store } = this.d;
    for (const ask of store.openAsks(clot).reverse()) {
      if (ask.state !== "open") continue;
      const kind = this.kinds.get(ask.kind);
      if (!kind?.onFeedback) continue;
      const reason = kind.stale?.(ask, this.d.now());
      if (reason !== undefined) {
        await this.withdraw(ask.id, reason);
        continue;
      }
      await kind.onFeedback(ask, text, this.io(ask));
      return true;
    }
    return false;
  }

  /** Answers an ask with a button. `key` makes a retry of the same answer harmless. */
  async answer(id: number, answer: AskAnswer, key?: string): Promise<AnswerResult> {
    const { store } = this.d;
    const ask = store.askById(id);
    if (!ask) {
      const past = store.conversation.askOutcome(id);
      if (!past) return { status: "missing" };
      if (key !== undefined && past.answerKey === key) return { status: "answered", outcome: past.outcome, result: past.result };
      return { status: "closed", outcome: past.outcome, result: past.result };
    }
    if (ask.state !== "open") return { status: "busy", outcome: "in progress" };
    const kind = this.kinds.get(ask.kind);
    if (!kind) return { status: "missing" };
    if (!kind.answers.includes(answer.action)) return { status: "invalid", reason: "That answer is not available for this question." };
    const reason = kind.stale?.(ask, this.d.now());
    if (reason !== undefined) {
      await this.withdraw(ask.id, reason);
      const past = store.conversation.askOutcome(id);
      return { status: "closed", outcome: past?.outcome ?? `Withdrawn: ${reason}`, result: past?.result ?? "withdrawn" };
    }
    if (key !== undefined) this.keys.set(id, key);
    try {
      await kind.onAnswer(ask, answer, this.io(ask));
    } finally {
      this.keys.delete(id);
    }
    const done = store.conversation.askOutcome(id);
    return { status: "answered", outcome: done?.outcome ?? null, result: done?.result ?? null };
  }

  /** Withdraws an open ask: what it would act on changed, or it can no longer be answered. A busy one is never withdrawn. */
  async withdraw(id: number, reason: string): Promise<boolean> {
    const ask = this.d.store.askById(id);
    if (!ask || ask.state !== "open") return false;
    const kind = this.kinds.get(ask.kind);
    return this.finish(ask, "withdrawn", `Withdrawn: ${ask.summary} (${reason}). Ask again if it still makes sense.`, `Withdrawn: ${ask.summary} (${reason})`, { onlyOpen: true, also: () => kind?.withdrawn?.(ask, reason) });
  }

  /** Withdraws every open ask of a kind whose payload matches. */
  async withdrawWhere<P>(kind: AskKindName, match: (payload: P) => boolean, reason: string): Promise<void> {
    for (const ask of this.d.store.openAsks()) {
      if (ask.kind === kind && ask.state === "open" && match(ask.payload as P)) await this.withdraw(ask.id, reason);
    }
  }

  /**
   * Closes what can no longer be answered. Hourly, and at startup with `starting`, which first closes what
   * a stop caught half-way: asks being carried out go to their kind's `interrupted`. Then, for open asks
   * only: an unknown kind, a reason from `stale`, and a deadline that has passed.
   */
  async sweep(starting: boolean): Promise<void> {
    const { store } = this.d;
    if (starting) {
      for (const ask of store.openAsks()) {
        if (ask.state !== "busy") continue;
        const kind = this.kinds.get(ask.kind);
        if (kind?.interrupted) await kind.interrupted(ask, this.io(ask));
        else await this.finish(ask, "failed", `${ask.summary}: ${INTERRUPTED}`, `Clots stopped while carrying this out, so whether it finished is not known: ${ask.summary}`, {});
      }
    }
    for (const ask of store.openAsks()) {
      if (ask.state !== "open") continue;
      const kind = this.kinds.get(ask.kind);
      if (!kind) {
        await this.withdraw(ask.id, "this kind of question is switched off");
        continue;
      }
      const reason = kind.stale?.(ask, this.d.now());
      if (reason !== undefined) {
        await this.withdraw(ask.id, reason);
        continue;
      }
      // In case a timer was lost.
      if (ask.deadline !== null && ask.deadline <= this.d.now()) await this.fire(ask.id);
    }
  }

  /**
   * Gives a deadline to asks an earlier version opened without one, then schedules every open ask's deadline
   * and its timer-state changes. Called once at startup; one already past fires at once.
   */
  startTimers(): void {
    const { store } = this.d;
    for (const ask of store.openAsks()) {
      if (ask.deadline === null) store.setAskDeadline(ask.id, this.d.now() + this.d.timeoutMs());
    }
    for (const ask of store.openAsks()) if (ask.state === "open") this.schedule(ask);
  }

  private schedule(ask: AskRow): void {
    if (ask.deadline === null || this.timers.has(ask.id)) return;
    const { deadline } = ask;
    const cancels: (() => void)[] = [];
    // The timer's states change at the 5-minute and 1-minute marks; a mark already passed has no event.
    for (const [mark, state] of [[CALLING_MS, "calling"], [URGENT_MS, "urgent"]] as const) {
      const wait = deadline - mark - this.d.now();
      if (wait > 0) cancels.push(this.d.after(wait, () => this.timerChanged(ask.id, state)));
    }
    cancels.push(
      this.d.after(Math.max(0, deadline - this.d.now()), () => {
        this.timers.delete(ask.id);
        void this.fire(ask.id).catch((error) => console.error(`[${ask.clot}] an ask's deadline failed:`, error));
      }),
    );
    this.timers.set(ask.id, cancels);
  }

  private timerChanged(id: number, timer: AskTimer): void {
    const ask = this.d.store.askById(id);
    const snapshot = ask && this.snapshot(ask);
    if (snapshot) this.d.emit("ask.updated", { ...snapshot, timer });
  }

  private async fire(id: number): Promise<void> {
    const ask = this.d.store.askById(id);
    if (!ask || ask.state !== "open") return;
    await this.kinds.get(ask.kind)?.onDeadline(ask, this.io(ask));
  }

  private io<P>(ask: AskRow<P>): AskIo<P> {
    const { store } = this.d;
    return {
      close: (result, note, line, then, outcome) => {
        const session = store.activeSession(ask.clot);
        // With no session to hand it to, the Clot still learns it from a note.
        const inbox: InboxInsert | undefined = then === undefined || session === undefined ? undefined : { ...then.inbox, clot: ask.clot, receivedAt: this.d.now() };
        return this.finish(ask, result, inbox === undefined && then !== undefined ? (note ?? then.inbox.text) : note, line, { inbox, outcome });
      },
      say: async (text) => {
        await this.d.conv.post(ask.clot, text, { kind: "note" }).catch(() => undefined);
      },
      setBusy: (payload) => {
        if (!store.moveAsk(ask.id, "open", "busy", payload)) return false;
        if (payload !== undefined) ask.payload = payload;
        const snapshot = this.snapshot(store.askById(ask.id)!);
        if (snapshot) this.d.emit("ask.updated", snapshot);
        return true;
      },
      reopen: (payload) => {
        store.moveAsk(ask.id, "busy", "open", payload);
        if (payload !== undefined) ask.payload = payload;
        const snapshot = this.snapshot(store.askById(ask.id)!);
        if (snapshot) this.d.emit("ask.updated", snapshot);
      },
    };
  }

  /** Closes an ask, then shows the outcome, tells the UI and kicks the Clot. False when it was closed already. */
  private async finish(ask: AskRow, result: AskResult, note: string | null, line: string | null, o: { inbox?: InboxInsert; onlyOpen?: boolean; also?: () => void; outcome?: string }): Promise<boolean> {
    const outcome = o.outcome ?? line ?? "Closed";
    const snapshot = this.snapshot(ask);
    const closedAt = this.d.now();
    const answerKey = this.keys.get(ask.id) ?? null;
    // However it ended, the Clot's session learns how: an ask that closes with no note and no row handed over still leaves one,
    // so that no outcome is only in the chat.
    if (note === null && o.inbox === undefined && line !== null) note = `Your question to the user (${ask.summary}) ended: ${line}`;
    if (!this.d.store.closeAsk(ask.id, ask.clot, note, { inbox: o.inbox, onlyOpen: o.onlyOpen, also: o.also, history: { view: snapshot?.view ?? null, outcome, result, closedAt, answerKey } })) return false;
    for (const cancel of this.timers.get(ask.id) ?? []) cancel();
    this.timers.delete(ask.id);
    if (line !== null) await this.d.conv.post(ask.clot, line, { kind: "note" }).catch(() => undefined);
    this.d.emit("ask.closed", { id: ask.id, clot: ask.clot, kind: ask.kind, outcome, result });
    this.changed();
    if (o.inbox !== undefined) this.d.kick(ask.clot);
    return true;
  }
}

/** A summary as one line of at most 100 characters, with links made harmless. */
export function oneLine(text: string): string {
  const flat = text
    .split("\n")[0]
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .trim();
  return flat.length > 100 ? `${flat.slice(0, 99)}…` : flat;
}
