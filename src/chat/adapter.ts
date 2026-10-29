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
  /** Finds a text channel by name outside every category, or creates one at the top of the server. Returns its ID. */
  ensureTopChannel(name: string): Promise<string>;
  /** Posts one message, pinging no one, and returns its ID. */
  postMessage(channelId: string, text: string): Promise<string>;
  pin(channelId: string, messageId: string): Promise<void>;
  /** Whether a message is pinned. Throws when that cannot be found out; see `isUnknown`. */
  isPinned(channelId: string, messageId: string): Promise<boolean>;
  /** Replaces a message's text, pinging no one. Throws when the message is gone; see `isUnknown`. */
  editMessage(channelId: string, messageId: string, text: string): Promise<void>;
}

/** Discord's codes for a channel or a message that does not exist. */
const UNKNOWN_CHANNEL = 10003;
const UNKNOWN_MESSAGE = 10008;

/** Whether an error says the channel or the message is gone, as opposed to Discord being unreachable. */
export function isUnknown(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === UNKNOWN_CHANNEL || code === UNKNOWN_MESSAGE;
}
