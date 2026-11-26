"use client";

import { useCallback, useEffect, useState } from "react";
import type { MessagePage, MessageView, WorkersResponse } from "@clots/ui-api-schemas";
import { api } from "@/lib/api-client";
import { useAppState } from "./app-state";
import { toItems, type Ended, type Item } from "./chat-items";

/**
 * A chat's messages, kept live: what the page came with, then what the stream brings (new messages, text growing, activity, workers),
 * and a fresh fetch merged in whenever the stream says to look again (it came back after a break).
 */
export function useChatStream(clot: string, initial: MessagePage) {
  const { subscribe, onResync } = useAppState();
  const [items, setItems] = useState<Item[]>(() => toItems(initial));
  const [hasMore, setHasMore] = useState(initial.hasMore);
  /** How asks ended, from the stream: a card folds to this line the moment it arrives. */
  const [outcomes, setOutcomes] = useState<Record<number, Ended>>({});

  const refetch = useCallback(async () => {
    try {
      const page = await api<MessagePage>(`/clots/${encodeURIComponent(clot)}/messages`);
      // What the page fetched is merged into what the chat has, never swapped for it: a message the stream brought while the
      // request was on its way is newer than the page and must stay. The server's copy wins for a message both have.
      const fresh = toItems(page);
      setItems((current) => {
        const byId = new Map(current.map((i) => [i.message.id, i]));
        for (const f of fresh) byId.set(f.message.id, { ...f, images: byId.get(f.message.id)?.images });
        return [...byId.values()].sort((a, b) => a.message.createdAt - b.message.createdAt);
      });
      setHasMore((h) => h || page.hasMore);
    } catch {
      // The banner says the daemon is away; the next resync fetches again.
    }
  }, [clot]);
  useEffect(() => onResync(() => void refetch()), [onResync, refetch]);

  const refetchWorkers = useCallback(async (turnId: string) => {
    try {
      const res = await api<WorkersResponse>(`/turns/${encodeURIComponent(turnId)}/workers`);
      setItems((list) => list.map((i) => (i.message.kind === "workers" && i.message.ref === turnId ? { ...i, workers: res.workers } : i)));
    } catch {
      // Nothing to show yet.
    }
  }, []);

  useEffect(
    () =>
      subscribe((event) => {
        const d = event.data;
        if (event.type === "ask.closed" && d.clot === clot) setOutcomes((o) => ({ ...o, [d.id]: { text: d.outcome, result: d.result } }));
        if (event.type === "workers.updated" && d.clot === clot) void refetchWorkers(d.turnId);
        if (d?.clot !== clot) return;
        // An ask's card is its message: if the page connected a moment before it, the message may have been missed; look again.
        if (event.type === "ask.opened") void refetch();
        if (event.type === "message.created" || event.type === "message.done") {
          const message = d.message as MessageView;
          setItems((list) => {
            const at = list.findIndex((i) => i.message.id === message.id);
            if (at >= 0) return list.map((i, j) => (j === at ? { ...i, message, status: undefined, streaming: false } : i));
            return [...list, { message }];
          });
          if (message.kind === "workers" && message.ref) void refetchWorkers(message.ref);
        } else if (event.type === "message.delta") {
          setItems((list) => {
            const at = list.findIndex((i) => i.message.id === d.id);
            if (at >= 0) return list.map((i, j) => (j === at ? { ...i, message: { ...i.message, text: i.message.text + d.delta }, streaming: true } : i));
            return [...list, { streaming: true, message: { id: d.id, clot, sessionId: null, kind: "clot", text: d.delta, ref: null, data: null, createdAt: Date.now(), images: 0 } }];
          });
        } else if (event.type === "activity") {
          setItems((list) => (list.some((i) => i.message.id === d.message.id) ? list : [...list, { message: d.message }]));
        }
      }),
    [subscribe, clot, refetch, refetchWorkers],
  );

  return { items, setItems, hasMore, setHasMore, outcomes };
}
