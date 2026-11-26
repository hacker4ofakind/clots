"use client";

import { useCallback, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { ArrowDownIcon, CaretLeftIcon, InfoIcon } from "@phosphor-icons/react";
import type { ClotInfo, MessagePage } from "@clots/ui-api-schemas";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api-client";
import { labelOfName } from "@/lib/clots";
import { useEdgeSwipeBack } from "@/lib/edge-swipe";
import { readableText } from "@/lib/readable-error";
import { cn } from "@/lib/utils";
import { useAppState } from "./app-state";
import { Composer } from "./composer";
import { InfoPane } from "./info-pane";
import { MessageList } from "./message-list";
import { useSidePane } from "./side-pane";
import { useChatScroll } from "./use-chat-scroll";
import { useChatSend } from "./use-chat-send";
import { useChatStream } from "./use-chat-stream";

/** One Clot's chat: the messages, the activity between them, ask cards and worker cards, and the composer. */
export function ChatView({ clot, initial, info }: { clot: string; initial: MessagePage; info: ClotInfo }) {
  const { setActiveClot, asks, clots, connection } = useAppState();
  const { open: openPane, pane, close: closePane } = useSidePane();
  const label = labelOfName(clot);
  const focusAsk = Number(useSearchParams().get("ask") ?? "") || undefined;
  const router = useRouter();
  useEdgeSwipeBack(() => router.push("/clots"));

  const { items, setItems, hasMore, setHasMore, outcomes } = useChatStream(clot, initial);
  const { scroller, content, onScroll, newBelow, loadingOlder, followEnd, jumpToEnd } = useChatScroll({ clot, items, setItems, hasMore, setHasMore, focusAsk });
  const { send, retry } = useChatSend(clot, setItems, followEnd);

  // The chat that is open is the one whose replies are read at once.
  useEffect(() => {
    setActiveClot(clot);
    void api(`/clots/${encodeURIComponent(clot)}/read`, { method: "POST", body: {} }).catch(() => undefined);
    return () => setActiveClot(undefined);
  }, [clot, setActiveClot]);

  // The Clot's info is a side pane on desktop.
  const showInfo = useCallback(() => openPane({ clot, label: `Info about ${label}`, render: () => <InfoPane info={info} /> }), [openPane, clot, label, info]);
  useEffect(() => () => closePane(), [clot, closePane]);
  const infoOpen = pane?.clot === clot;

  const state = clots.find((c) => c.name === clot);
  const lastIsStreaming = items.at(-1)?.streaming === true;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="grid h-14 shrink-0 grid-cols-[1fr_auto_1fr] items-center px-4 max-md:h-auto max-md:px-2 max-md:pt-[max(calc(env(safe-area-inset-top)+4px),54px)] max-md:pb-1.5">
        <Button asChild variant="ghost" size="lg" className="justify-self-start px-2 text-base font-medium md:hidden">
          <Link href="/clots">
            <CaretLeftIcon size={20} aria-hidden /> Clots
          </Link>
        </Button>
        <span className="max-md:hidden" />
        <h1 className="text-chat leading-normal font-[650] max-md:text-section">{label}</h1>
        <div className="flex justify-self-end max-md:hidden">
          <Button variant="ghost" size="icon" aria-label="Info" aria-pressed={infoOpen} onClick={() => (infoOpen ? closePane() : showInfo())} className={cn(infoOpen && "bg-muted")}>
            <InfoIcon size={20} />
          </Button>
        </div>
      </header>
      <div className="relative min-h-0 flex-1">
        <div ref={scroller} onScroll={onScroll} tabIndex={0} aria-label="Messages" role="region" className="h-full overflow-y-auto overscroll-contain outline-none [overflow-anchor:none] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring" data-chat-scroller>
          <div ref={content} className="content-width chat-gutter flex min-h-full flex-col gap-4 px-4 pt-2 pb-4">
            <MessageList items={items} openAsks={asks} outcomes={outcomes} focusAsk={focusAsk} onRetry={retry} />
            {state?.state === "working" && !lastIsStreaming ? (
              <p className="flex items-center gap-2 text-caption text-muted-foreground" role="status">
                <span className="size-1.5 animate-pulse rounded-full bg-highlight" aria-hidden />
                {label} is working
              </p>
            ) : null}
            {state?.state === "failed" ? <p className="text-caption text-primary-ink">{readableText(state.reason, "The last turn failed.")}</p> : null}
          </div>
        </div>
        {loadingOlder ? <Skeleton className="absolute inset-x-4 top-2 mx-auto h-10 max-w-sm" role="status" aria-label="Loading earlier messages" /> : null}
        {newBelow ? (
          <Button size="sm" onClick={jumpToEnd} className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full shadow-pop">
            <ArrowDownIcon weight="bold" aria-hidden />
            New messages
          </Button>
        ) : null}
      </div>
      <div className="shrink-0 pt-1">
        <div className="content-width">
          <Composer clot={clot} label={label} onSend={send} disabled={connection === "down"} />
        </div>
      </div>
    </div>
  );
}
