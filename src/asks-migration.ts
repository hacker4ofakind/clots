import { mailHeadline } from "./asks/email.js";
import type { ChatAdapter } from "./chat/adapter.js";
import type { OutgoingMail } from "./sources/email.js";
import type { Store } from "./store.js";

const MIGRATED = "asks.migrated";

/**
 * Runs once: the rule proposals, send reviews and memory questions an earlier version left open
 * are withdrawn, their channels deleted. A Clot is told about its proposals and reviews; a memory
 * question needs no note, since the next home check applies the memory.
 */
export async function migrateAsks(d: { store: Store; chat: ChatAdapter }): Promise<void> {
  const { store, chat } = d;
  if (store.getState(MIGRATED) !== undefined) return;
  const old = store.legacyAsks();
  const notes = old.flatMap((row) => {
    if (row.clot === null) return [];
    const summary = row.table === "proposals" ? `the rule change ${row.summary!.split("\n")[0]}` : `the email ${mailHeadline(JSON.parse(row.mail!) as OutgoingMail, row.account!)}`;
    return [{ clot: row.clot, text: `Withdrawn when the daemon was updated: ${summary}. Ask again if it still makes sense.` }];
  });
  // The rows go first, together with the notes: a stop in between leaves at worst a channel nothing answers.
  store.dropLegacyAsks(notes, MIGRATED);
  for (const row of old) await chat.deleteChannel(row.channelId).catch(() => undefined);
}
