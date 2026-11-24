import type { TurnActivity } from "../types.js";
import type { Store } from "../store.js";
import type { EventBus } from "../ui-api/events.js";
import type { ActivityLine } from "./activity-lines.js";
import type { ImageRow, MessageKind, MessageRow } from "./store.js";

export type ClotState = "idle" | "working" | "paused" | "failed";

/** A message as the UI is sent it. */
export type MessageView = Omit<MessageRow, "seq">;

export const toView = (row: MessageRow): MessageView => {
  const { seq: _seq, ...view } = row;
  return view;
};

export interface PostOptions {
  kind?: "clot" | "note" | "onboarding";
  /** What the UI draws the message from, for a kind that is more than text. */
  data?: Record<string, unknown>;
  /** The text is a recap: the UI folds it. */
  recap?: boolean;
  /** The ID to store it under. For a streamed reply it is the ID its deltas were sent under. */
  id?: string;
}

/**
 * Everything the daemon says in a Clot's chat goes through here: a row in the conversation store and an
 * event for the UI. It replaces the chat adapter, and is keyed by Clot, not by channel.
 */
export interface Conversation {
  /** Posts the Clot's text or a daemon note. Returns the message's ID. Never rejects. */
  post(clot: string, text: string, o?: PostOptions): Promise<string>;
  /** A message the user sent. A repeated ID is not stored again (`created` is false). */
  addUser(clot: string, m: { id: string; text: string; images?: ImageRow[]; at: number }): { message: MessageView; created: boolean };
  /** What a turn changed and ran, as one message after it. */
  postActivity(clot: string, activity: TurnActivity): Promise<void>;
  /** One tool call of a turn. */
  activityLine(clot: string, line: ActivityLine): void;
  setState(clot: string, state: ClotState, reason?: string): void;
  stateOf(clot: string): { state: ClotState; reason?: string };
  /** Puts an ask in the Clot's chat. Returns the message's ID. */
  postAsk(clot: string, askId: number): Promise<string>;
  /** Puts the workers a turn started in the Clot's chat, once. Returns the message's ID. */
  postWorkers(clot: string, turnId: string): Promise<string>;
  /** Streamed text of a reply being written, under the ID the final post will use. */
  delta(clot: string, messageId: string, text: string): void;
}

export interface ConversationDeps {
  store: Store;
  bus: EventBus;
  now: () => number;
  newId: () => string;
  /** Called after each of the Clot's replies is stored. Used for push notifications. */
  onReply?: (clot: string, message: MessageView) => void;
  /** Called when a Clot's state changes. */
  onState?: (clot: string, state: ClotState, reason?: string) => void;
}

/** The conversation store with the event stream. */
export class ConversationService implements Conversation {
  private states = new Map<string, { state: ClotState; reason?: string }>();
  /** Messages whose text arrived in deltas: their final post is a `message.done`. */
  private streaming = new Set<string>();

  constructor(private d: ConversationDeps) {}

  private get conv() {
    return this.d.store.conversation;
  }

  private store(clot: string, kind: MessageKind, text: string, o: { id?: string; ref?: string | null; data?: Record<string, unknown> | null } = {}): { row: MessageRow; created: boolean } {
    return this.conv.add({ id: o.id ?? this.d.newId(), clot, sessionId: this.d.store.activeSession(clot)?.id ?? null, kind, text, ref: o.ref ?? null, data: o.data ?? null, createdAt: this.d.now() });
  }

  async post(clot: string, text: string, o: PostOptions = {}): Promise<string> {
    const kind = o.kind ?? "clot";
    const { row, created } = this.store(clot, kind, text, { id: o.id, data: o.recap ? { recap: true } : (o.data ?? null) });
    const view = toView(row);
    const streamed = o.id !== undefined && this.streaming.delete(o.id);
    if (created || streamed) this.d.bus.emit(streamed ? "message.done" : "message.created", { clot, message: view });
    if (created && kind === "clot") this.d.onReply?.(clot, view);
    return row.id;
  }

  addUser(clot: string, m: { id: string; text: string; images?: ImageRow[]; at: number }): { message: MessageView; created: boolean } {
    const { row, created } = this.conv.add({ id: m.id, clot, sessionId: this.d.store.activeSession(clot)?.id ?? null, kind: "user", text: m.text, createdAt: m.at, images: m.images });
    const message = toView(row);
    if (created) this.d.bus.emit("message.created", { clot, message });
    return { message, created };
  }

  async postActivity(clot: string, activity: TurnActivity): Promise<void> {
    const { row } = this.store(clot, "activity", "", { data: { type: "summary", files: activity.files, commands: activity.commands } });
    this.d.bus.emit("message.created", { clot, message: toView(row) });
  }

  activityLine(clot: string, line: ActivityLine): void {
    const { row } = this.store(clot, "activity", line.text, { data: { type: "line", icon: line.icon } });
    this.d.bus.emit("activity", { clot, message: toView(row) });
  }

  setState(clot: string, state: ClotState, reason?: string): void {
    const before = this.states.get(clot);
    if (before?.state === state && before.reason === reason) return;
    this.states.set(clot, { state, ...(reason === undefined ? {} : { reason }) });
    this.d.bus.emit("clot.state", { clot, state, ...(reason === undefined ? {} : { reason }) });
    this.d.onState?.(clot, state, reason);
  }

  stateOf(clot: string): { state: ClotState; reason?: string } {
    const paused = this.d.store.getClot(clot)?.pausedUntil;
    if (paused !== null && paused !== undefined && paused * 1000 > this.d.now()) return { state: "paused", reason: "usage limit" };
    return this.states.get(clot) ?? { state: "idle" };
  }

  async postAsk(clot: string, askId: number): Promise<string> {
    const { row } = this.store(clot, "ask", "", { ref: String(askId) });
    this.d.bus.emit("message.created", { clot, message: toView(row) });
    return row.id;
  }

  async postWorkers(clot: string, turnId: string): Promise<string> {
    const { row, created } = this.store(clot, "workers", "", { id: `workers:${turnId}`, ref: turnId });
    if (created) this.d.bus.emit("message.created", { clot, message: toView(row) });
    return row.id;
  }

  delta(clot: string, messageId: string, text: string): void {
    this.streaming.add(messageId);
    this.d.bus.emit("message.delta", { clot, id: messageId, delta: text });
  }
}
