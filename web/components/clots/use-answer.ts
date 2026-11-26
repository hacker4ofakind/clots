"use client";

import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";
import type { AskAnswerBody } from "@clots/ui-api-schemas";
import { useAppState } from "./app-state";

export interface AnswerState {
  /** An answer is on its way to the daemon. */
  busy: boolean;
  /** The last try failed: the card stays, with Retry. */
  error: string | undefined;
  /** How the ask ended, once it has: from our own answer or from another device's. */
  outcome: string | undefined;
  send: (answer: AskAnswerBody) => Promise<void>;
  /** Sends the answer that just failed again: the one the user chose, not another. */
  retry: () => Promise<void>;
}

/**
 * Answers one ask. A retry sends the same key, so an answer that did reach the daemon is not made twice. An ask that had
 * already closed shows how it ended, on the card and in a toast. An email edit that finds the ask closed keeps its text with the caller.
 */
export function useAnswer(askId: number): AnswerState {
  const { answer } = useAppState();
  const key = useRef<string>(crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [outcome, setOutcome] = useState<string>();
  /** What the user last chose, so a retry sends that and nothing else. */
  const last = useRef<AskAnswerBody>(undefined);

  const send = useCallback(
    async (body: AskAnswerBody) => {
      last.current = body;
      setBusy(true);
      setError(undefined);
      const result = await answer(askId, body, key.current);
      if (result.kind === "answered") {
        // Null means it is still being carried out: the stream's ask.closed brings the end.
        if (result.outcome !== null) setOutcome(result.outcome);
        if (result.outcome === "in progress") setOutcome(undefined);
      } else if (result.kind === "closed") {
        setOutcome(result.outcome);
        toast("Already answered", { description: result.outcome });
      } else if (result.kind === "failed") {
        setError(result.message);
      }
      setBusy(false);
    },
    [answer, askId],
  );

  const retry = useCallback(async () => {
    if (last.current) await send(last.current);
  }, [send]);

  return { busy, error, outcome, send, retry };
}
