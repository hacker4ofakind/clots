import type { TurnActivity } from "../types.js";

export interface InboundMessage {
  id: string;
  channelId: string;
  authorId: string;
  text: string;
  at: Date;
}

export interface ChatAdapter {
  start(onMessage: (m: InboundMessage) => void): Promise<void>;
  ensureCategory(name: string): Promise<string>;
  listChannelNames(categoryId: string): Promise<string[]>;
  /** Creates the channel at the top of the category and returns its ID. */
  createChannel(categoryId: string, name: string): Promise<string>;
  post(channelId: string, text: string): Promise<void>;
  /** Posts a summary of what a turn changed and ran. */
  postActivity(channelId: string, activity: TurnActivity): Promise<void>;
  /** Shows a typing indicator in the channel until the returned function is called. */
  startTyping(channelId: string): () => void;
  makeReadOnly(channelId: string): Promise<void>;
  deleteChannel(channelId: string): Promise<void>;
  /** Whether the channel is still there. Throws when that cannot be found out. */
  channelExists(channelId: string): Promise<boolean>;
  mention(userId: string): string;
  channelLink(channelId: string): string;
}
