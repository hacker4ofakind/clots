import type { TurnActivity } from "../types.js";
import type { ChatAdapter, InboundMessage } from "./adapter.js";

export class FakeChat implements ChatAdapter {
  categories = new Map<string, string>();
  channels: { id: string; categoryId: string; name: string }[] = [];
  posts: { channelId: string; text: string }[] = [];
  activities: { channelId: string; activity: TurnActivity }[] = [];
  readOnly = new Set<string>();
  typing = new Set<string>();
  deleted: string[] = [];
  private handler: (m: InboundMessage) => void = () => undefined;
  private counter = 0;

  async start(onMessage: (m: InboundMessage) => void): Promise<void> {
    this.handler = onMessage;
  }

  deliver(m: InboundMessage): void {
    this.handler(m);
  }

  async ensureCategory(name: string): Promise<string> {
    if (!this.categories.has(name)) this.categories.set(name, `cat-${name}`);
    return this.categories.get(name)!;
  }

  async listChannelNames(categoryId: string): Promise<string[]> {
    return this.channels.filter((c) => c.categoryId === categoryId).map((c) => c.name);
  }

  async createChannel(categoryId: string, name: string): Promise<string> {
    this.counter += 1;
    const id = `ch-${this.counter}`;
    this.channels.unshift({ id, categoryId, name });
    return id;
  }

  async post(channelId: string, text: string): Promise<void> {
    this.posts.push({ channelId, text });
  }

  async postActivity(channelId: string, activity: TurnActivity): Promise<void> {
    this.activities.push({ channelId, activity });
  }

  startTyping(channelId: string): () => void {
    this.typing.add(channelId);
    return () => void this.typing.delete(channelId);
  }

  postsIn(channelId: string): string[] {
    return this.posts.filter((p) => p.channelId === channelId).map((p) => p.text);
  }

  async makeReadOnly(channelId: string): Promise<void> {
    this.readOnly.add(channelId);
  }

  async deleteChannel(channelId: string): Promise<void> {
    this.channels = this.channels.filter((c) => c.id !== channelId);
    this.deleted.push(channelId);
  }

  async channelExists(channelId: string): Promise<boolean> {
    return this.channels.some((c) => c.id === channelId);
  }

  mention(userId: string): string {
    return `<@${userId}>`;
  }

  channelLink(channelId: string): string {
    return `<#${channelId}>`;
  }

  /** Channels outside every category, at the top of the server. */
  top: { id: string; name: string }[] = [];
  /** Messages posted with postMessage, by ID, with their current text. */
  messages = new Map<string, { channelId: string; text: string }>();
  edits: { messageId: string; text: string }[] = [];
  pinned: string[] = [];
  /** Set to make the next edit fail with this error. */
  editFails?: unknown;

  async ensureTopChannel(name: string): Promise<string> {
    const found = this.top.find((c) => c.name === name);
    if (found) return found.id;
    this.counter += 1;
    const channel = { id: `top-${this.counter}`, name };
    this.top.unshift(channel);
    return channel.id;
  }

  async postMessage(channelId: string, text: string): Promise<string> {
    if (!this.top.some((c) => c.id === channelId) && !this.channels.some((c) => c.id === channelId)) throw Object.assign(new Error("Unknown Channel"), { code: 10003 });
    this.counter += 1;
    const id = `msg-${this.counter}`;
    this.messages.set(id, { channelId, text });
    this.posts.push({ channelId, text });
    return id;
  }

  async pin(_channelId: string, messageId: string): Promise<void> {
    this.pinned.push(messageId);
  }

  async editMessage(_channelId: string, messageId: string, text: string): Promise<void> {
    if (this.editFails !== undefined) {
      const error = this.editFails;
      this.editFails = undefined;
      throw error;
    }
    const message = this.messages.get(messageId);
    if (!message) throw Object.assign(new Error("Unknown Message"), { code: 10008 });
    message.text = text;
    this.edits.push({ messageId, text });
  }
}
