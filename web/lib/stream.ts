"use client";

import { useEffect, useEffectEvent, useState } from "react";
import { UI_EVENT_TYPES, type UiEventType } from "@clots/ui-api-schemas";

export interface StreamEvent {
  type: UiEventType;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- event payloads are checked by the handler that reads them
  data: any;
  id: string;
}

export type StreamStatus = "connecting" | "up" | "down";

const FIRST_RETRY_MS = 1000;
const MAX_RETRY_MS = 30_000;
/** The app sends a ping every 10 seconds when nothing else is said; this long with nothing at all means the stream is dead, not quiet. */
const SILENCE_MS = 30_000;

/**
 * The daemon's event stream, through the app's own route. It reconnects on its own with a wait that grows from
 * 1 second to 30, asking for what it missed with the last event ID it saw. Each time it opens (the first time
 * too, since the page's data may be older than the stream), `onOpen` says to fetch the open screen again.
 * A `resync` event says the same. A stream that goes silent (the app's route pings every 10 seconds) is dropped and reopened the
 * same way as one that errors, so a connection that died without a word still shows the banner.
 */
export function useStream(handlers: { onEvent: (event: StreamEvent) => void; onOpen: () => void }): StreamStatus {
  const [status, setStatus] = useState<StreamStatus>("connecting");
  const onEvent = useEffectEvent(handlers.onEvent);
  const onOpen = useEffectEvent(handlers.onOpen);

  useEffect(() => {
    let source: EventSource | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    let last: string | undefined;
    let stopped = false;
    let watchdog: ReturnType<typeof setTimeout> | undefined;

    /** The stream broke: show it, and open it again after a wait that grows. */
    const lost = (es: EventSource) => {
      es.close();
      clearTimeout(watchdog);
      if (stopped || source !== es) return;
      setStatus("down");
      const wait = Math.min(FIRST_RETRY_MS * 2 ** attempt, MAX_RETRY_MS);
      attempt += 1;
      timer = setTimeout(connect, wait);
    };

    function connect() {
      if (stopped) return;
      source?.close();
      const es = new EventSource(last === undefined ? "/api/stream" : `/api/stream?last=${encodeURIComponent(last)}`);
      source = es;
      const heard = () => {
        clearTimeout(watchdog);
        watchdog = setTimeout(() => lost(es), SILENCE_MS);
      };
      heard();
      es.addEventListener("ping", heard);
      es.onopen = () => {
        attempt = 0;
        setStatus("up");
        heard();
        onOpen();
      };
      for (const type of UI_EVENT_TYPES) {
        es.addEventListener(type, (e) => {
          heard();
          const message = e as MessageEvent<string>;
          if (message.lastEventId) last = message.lastEventId;
          let data: unknown = null;
          try {
            data = JSON.parse(message.data);
          } catch {
            return;
          }
          if (type === "resync") onOpen();
          else onEvent({ type, data, id: message.lastEventId });
        });
      }
      es.onerror = () => lost(es);
    }
    connect();

    // A phone that was asleep comes back: look again at once, and do not wait out a long retry.
    const visible = () => {
      if (document.visibilityState !== "visible") return;
      onOpen();
      if (source === undefined || source.readyState === EventSource.CLOSED) {
        if (timer) clearTimeout(timer);
        attempt = 0;
        connect();
      }
    };
    document.addEventListener("visibilitychange", visible);
    return () => {
      stopped = true;
      document.removeEventListener("visibilitychange", visible);
      if (timer) clearTimeout(timer);
      clearTimeout(watchdog);
      source?.close();
    };
  }, []);

  return status;
}
