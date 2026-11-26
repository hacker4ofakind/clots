"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { MessagePage } from "@clots/ui-api-schemas";
import { api } from "@/lib/api-client";
import { toItems, type Item } from "./chat-items";

const NEAR_BOTTOM = 80;
/** Scrolling up to within this many pixels of the top asks for the earlier messages. */
const NEAR_TOP = 200;

/**
 * A chat's scrolling: it follows the end while the user is at it, says there is something new below when they are not, loads earlier
 * messages when they scroll up and puts the view back where it was when those come in above it, and scrolls to an ask it was told to focus.
 */
export function useChatScroll({ clot, items, setItems, hasMore, setHasMore, focusAsk }: { clot: string; items: Item[]; setItems: Dispatch<SetStateAction<Item[]>>; hasMore: boolean; setHasMore: Dispatch<SetStateAction<boolean>>; focusAsk: number | undefined }) {
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  /** Whether the view is at the end of the chat, and so follows what arrives. */
  const stick = useRef(true);
  /** Set while older messages are being added above: where the view was, so it can be put back. */
  const anchor = useRef<{ height: number; top: number }>(undefined);
  const known = useRef(items.length);
  const [newBelow, setNewBelow] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);

  const toEnd = useCallback(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  // After every change of the messages: put the view back where it was when older ones came in above it, follow the end when
  // the user is at it, and otherwise say there is something new below.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const added = items.length - known.current;
    known.current = items.length;
    if (anchor.current) {
      el.scrollTop = anchor.current.top + (el.scrollHeight - anchor.current.height);
      anchor.current = undefined;
    } else if (stick.current) {
      toEnd();
    } else if (added > 0 && items.slice(-added).some((i) => i.message.kind !== "user" && i.message.kind !== "activity")) {
      setNewBelow(true);
    }
  }, [items, toEnd]);

  // What changes the height without changing the messages (a picture arriving, the composer growing, the keyboard opening)
  // keeps the end in view too, when that is where the user is.
  useEffect(() => {
    const el = scroller.current;
    const inner = content.current;
    if (!el || !inner || typeof ResizeObserver === "undefined") return;
    const watch = new ResizeObserver(() => {
      if (stick.current && !anchor.current) toEnd();
    });
    watch.observe(el);
    watch.observe(inner);
    return () => watch.disconnect();
  }, [toEnd]);

  useEffect(() => {
    if (focusAsk === undefined) return;
    const target = document.querySelector<HTMLElement>(`[data-ask-id="${focusAsk}"]`);
    if (target) {
      stick.current = false;
      target.scrollIntoView({ block: "center" });
      target.focus();
    }
  }, [focusAsk, items.length]);

  const loadOlder = useCallback(async () => {
    const first = items[0]?.message.id;
    const el = scroller.current;
    if (!hasMore || loadingOlder || !first || !el) return;
    setLoadingOlder(true);
    try {
      const page = await api<MessagePage>(`/clots/${encodeURIComponent(clot)}/messages?before=${encodeURIComponent(first)}`);
      // The layout effect puts the view back below what came in above it.
      anchor.current = { height: el.scrollHeight, top: el.scrollTop };
      setItems((list) => [...toItems(page), ...list]);
      setHasMore(page.hasMore);
    } catch {
      // Scrolling up again tries again.
    }
    setLoadingOlder(false);
  }, [items, hasMore, loadingOlder, clot, setItems, setHasMore]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM;
    if (stick.current) setNewBelow(false);
    if (el.scrollTop < NEAR_TOP) void loadOlder();
  };

  /** Sending a message follows the end, wherever the view was. */
  const followEnd = useCallback(() => {
    stick.current = true;
  }, []);
  const jumpToEnd = useCallback(() => {
    stick.current = true;
    toEnd();
    setNewBelow(false);
  }, [toEnd]);

  return { scroller, content, onScroll, newBelow, loadingOlder, followEnd, jumpToEnd };
}
