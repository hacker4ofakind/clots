import type { Conversation, ClotState, MessageView, PostOptions } from "../../src/conversation/conversation.js";
import type { ActivityLine } from "../../src/conversation/activity-lines.js";
import type { ImageRow } from "../../src/conversation/store.js";
import type { TurnActivity } from "../../src/types.js";

/** A conversation that records what was said, for tests. Same recording style as the old fake chat, keyed by Clot. */
export class FakeConversation implements Conversation {
  posts: { clot: string; text: string; kind: "clot" | "note" | "onboarding"; id?: string; recap?: boolean }[] = [];
  activities: { clot: string; activity: TurnActivity }[] = [];
  lines: { clot: string; line: ActivityLine }[] = [];
  asksPosted: { clot: string; askId: number }[] = [];
  workersPosted: { clot: string; turnId: string }[] = [];
  deltas: { clot: string; id: string; text: string }[] = [];
  users: { clot: string; id: string; text: string }[] = [];
  states: { clot: string; state: ClotState; reason?: string }[] = [];
  private current = new Map<string, { state: ClotState; reason?: string }>();
  private seen = new Set<string>();
  private counter = 0;

  async post(clot: string, text: string, o: PostOptions = {}): Promise<string> {
    this.counter += 1;
    const id = o.id ?? `m${this.counter}`;
    this.posts.push({ clot, text, kind: o.kind ?? "clot", id, ...(o.recap ? { recap: true } : {}) });
    return id;
  }

  addUser(clot: string, m: { id: string; text: string; images?: ImageRow[]; at: number }): { message: MessageView; created: boolean } {
    const created = !this.seen.has(m.id);
    this.seen.add(m.id);
    if (created) this.users.push({ clot, id: m.id, text: m.text });
    return { message: { id: m.id, clot, sessionId: null, kind: "user", text: m.text, ref: null, data: null, createdAt: m.at, images: m.images?.length ?? 0 }, created };
  }

  async postActivity(clot: string, activity: TurnActivity): Promise<void> {
    this.activities.push({ clot, activity });
  }

  activityLine(clot: string, line: ActivityLine): void {
    this.lines.push({ clot, line });
  }

  setState(clot: string, state: ClotState, reason?: string): void {
    this.states.push({ clot, state, ...(reason === undefined ? {} : { reason }) });
    this.current.set(clot, { state, ...(reason === undefined ? {} : { reason }) });
  }

  stateOf(clot: string): { state: ClotState; reason?: string } {
    return this.current.get(clot) ?? { state: "idle" };
  }

  async postAsk(clot: string, askId: number): Promise<string> {
    this.asksPosted.push({ clot, askId });
    return `ask-${askId}`;
  }

  async postWorkers(clot: string, turnId: string): Promise<string> {
    this.workersPosted.push({ clot, turnId });
    return `workers:${turnId}`;
  }

  delta(clot: string, id: string, text: string): void {
    this.deltas.push({ clot, id, text });
  }

  /** The texts posted in a Clot's chat, in order. */
  postsFor(clot: string): string[] {
    return this.posts.filter((p) => p.clot === clot).map((p) => p.text);
  }

  /** Every text posted, in order, whatever the Clot. */
  texts(): string[] {
    return this.posts.map((p) => p.text);
  }
}
