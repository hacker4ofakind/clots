import type { Store } from "../store.js";
import type { ChatAdapter } from "./adapter.js";

/** Discord allows 50 channels in a category. Room is made below this many, so a session and its asks always fit. */
export const ROOM_LIMIT = 45;

/**
 * Makes room in a Clot's category before a channel is created: at 45 channels or more, the oldest
 * closed session channels are deleted until it is under 45. Their transcripts stay on disk.
 * Returns why there is still no room, or undefined when there is.
 */
export async function makeRoom(chat: ChatAdapter, store: Store, clot: string, categoryId: string): Promise<string | undefined> {
  let count = (await chat.listChannelNames(categoryId)).length;
  for (const channelId of store.closedSessionChannels(clot)) {
    if (count < ROOM_LIMIT) break;
    await chat.deleteChannel(channelId);
    store.markSessionChannelRemoved(channelId);
    count -= 1;
  }
  return count < ROOM_LIMIT ? undefined : `${clot}'s category has ${count} channels and no closed session channel is left to remove`;
}
