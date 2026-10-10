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
  makeReadOnly(channelId: string): Promise<void>;
  mention(userId: string): string;
  channelLink(channelId: string): string;
}
