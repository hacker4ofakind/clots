import type { AskCard as AskCardData, AskResult, MessagePage, MessageView, WorkerView } from "@clots/ui-api-schemas";

/** One thing in a chat: a message from the daemon, with the ask or workers it carries and what the browser knows about it. */
export interface Item {
  message: MessageView;
  ask?: AskCardData;
  workers?: WorkerView[];
  /** A message of the user's own that the daemon has not confirmed yet. */
  status?: "sending" | "failed";
  streaming?: boolean;
  /** The pictures of a message that is still being sent, as data URLs. */
  images?: string[];
}

/** The Clot's messages within this long of each other share one timestamp. */
export const GROUP_MS = 5 * 60_000;

/** A page of messages, oldest first. */
export const toItems = (page: MessagePage): Item[] => [...page.messages].reverse().map((m) => ({ message: m, ask: m.ask, workers: m.workers }));

export const time = (ms: number) => new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(ms);

/**
 * Which of the Clot's messages carry a timestamp. The Clot's messages within five minutes of each other form a group, and the
 * time shows once, under the last of them. Activity lines, notes and cards between them do not break a group; a message from the
 * user does. A message still arriving has no time yet.
 */
export function stampedIds(items: Item[]): Set<string> {
  const stamped = new Set<string>();
  let last: Item | undefined;
  const close = () => {
    if (last && last.status === undefined && !last.streaming) stamped.add(last.message.id);
    last = undefined;
  };
  for (const item of items) {
    if (item.message.kind === "user") close();
    else if (item.message.kind === "clot") {
      if (last && item.message.createdAt - last.message.createdAt > GROUP_MS) close();
      last = item;
    }
  }
  close();
  return stamped;
}

/** How an ask ended: what it says, and the typed result the icon follows (absent on rows from before it was kept). */
export interface Ended {
  text: string;
  result?: AskResult;
}

/** How the asks that have ended ended, as the chat knows it: from the stream's `ask.closed`, or from the ask the page carried. */
export function endedOutcomes(items: Item[], fromStream: Record<number, Ended>): Map<number, Ended> {
  const ended = new Map<number, Ended>();
  for (const item of items) {
    if (item.message.kind !== "ask") continue;
    const id = Number(item.message.ref);
    const streamed = fromStream[id];
    const text = item.ask?.state === "closed" ? item.ask.outcome : undefined;
    if (streamed !== undefined) ended.set(id, streamed);
    else if (text !== undefined) ended.set(id, { text, result: item.ask?.result });
  }
  return ended;
}
