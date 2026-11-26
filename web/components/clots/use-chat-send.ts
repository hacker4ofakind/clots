"use client";

import { useCallback, useRef, type Dispatch, type SetStateAction } from "react";
import { api } from "@/lib/api-client";
import type { Item } from "./chat-items";
import type { Draft } from "./composer";

/**
 * Sending a message: it shows in the chat at once as "sending", settles when the daemon has it, and shows as failed, with Retry, when it
 * did not. A retry sends the same id, so a message that did arrive is not made twice.
 */
export function useChatSend(clot: string, setItems: Dispatch<SetStateAction<Item[]>>, onSent: () => void) {
  const pending = useRef(new Map<string, Draft>());

  const submit = useCallback(
    async (id: string, draft: Draft) => {
      try {
        await api(`/clots/${encodeURIComponent(clot)}/messages`, { method: "POST", body: { id, text: draft.text, images: draft.images } });
        pending.current.delete(id);
        setItems((list) => list.map((i) => (i.message.id === id ? { ...i, status: undefined } : i)));
      } catch {
        setItems((list) => list.map((i) => (i.message.id === id ? { ...i, status: "failed" } : i)));
      }
    },
    [clot, setItems],
  );

  const send = useCallback(
    (draft: Draft) => {
      const id = crypto.randomUUID();
      pending.current.set(id, draft);
      onSent();
      setItems((list) => [...list, { status: "sending", images: draft.images, message: { id, clot, sessionId: null, kind: "user", text: draft.text, ref: null, data: null, createdAt: Date.now(), images: 0 } }]);
      void submit(id, draft);
    },
    [clot, setItems, onSent, submit],
  );

  const retry = useCallback(
    (id: string) => {
      const draft = pending.current.get(id);
      if (!draft) return;
      setItems((list) => list.map((i) => (i.message.id === id ? { ...i, status: "sending" } : i)));
      void submit(id, draft);
    },
    [setItems, submit],
  );

  return { send, retry };
}
