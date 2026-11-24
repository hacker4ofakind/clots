"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import Image from "next/image";
import { ArrowDownIcon, CaretDownIcon, CaretLeftIcon, CaretRightIcon, InfoIcon } from "@phosphor-icons/react";
import type { AskCard as AskCardData, ClotInfo, MessagePage, MessageView, WorkerView, WorkersResponse } from "@clots/ui-api-schemas";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api-client";
import { labelOfName } from "@/lib/clots";
import { useEdgeSwipeBack } from "@/lib/edge-swipe";
import { cn } from "@/lib/utils";
import { useAppState } from "./app-state";
import { AskCard, AskOutcome } from "./ask-card";
import { NamedIcon } from "./clot-icon";
import { Composer, type Draft } from "./composer";
import { InfoPane } from "./info-pane";
import { Markdown } from "./markdown";
import { OnboardingCard } from "./onboarding-card";
import { useSidePane } from "./side-pane";
import { WorkerCard } from "./worker-card";

type Item = { message: MessageView; ask?: AskCardData; workers?: WorkerView[]; status?: "sending" | "failed"; streaming?: boolean; images?: string[] };

const GROUP_MS = 5 * 60_000;
const NEAR_BOTTOM = 80;

const time = (ms: number) => new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(ms);

function Activity({ message }: { message: MessageView }) {
  const data = message.data as { type?: string; icon?: string; files?: { path: string; added: number; removed: number }[]; commands?: string[] } | null;
  if (data?.type === "summary") {
    const files = data.files ?? [];
    const commands = data.commands ?? [];
    return (
      <details className="text-caption text-muted-foreground">
        <summary className="cursor-pointer select-none">
          {files.length > 0 ? `${files.length} file${files.length === 1 ? "" : "s"} changed` : ""}
          {files.length > 0 && commands.length > 0 ? ", " : ""}
          {commands.length > 0 ? `${commands.length} command${commands.length === 1 ? "" : "s"} run` : ""}
        </summary>
        <ul className="mt-1 flex flex-col gap-0.5 font-mono text-code">
          {files.map((f) => (
            <li key={f.path}>
              <span className="text-highlight-ink">+{f.added}</span> <span className="text-primary-ink">-{f.removed}</span> {f.path}
            </li>
          ))}
          {commands.map((c, i) => (
            <li key={i} className="truncate">
              {c.split("\n")[0]}
            </li>
          ))}
        </ul>
      </details>
    );
  }
  return (
    <p className="flex items-center gap-2 text-label font-normal text-muted-foreground">
      {data?.icon ? <NamedIcon name={data.icon} size={16} className="shrink-0" /> : null}
      {message.text}
    </p>
  );
}

function Note({ message }: { message: MessageView }) {
  const [open, setOpen] = useState(false);
  const recap = (message.data as { recap?: boolean } | null)?.recap === true;
  if (!recap) {
    return (
      <p className="flex items-center gap-1.5 self-center py-1 text-center text-caption text-muted-foreground">
        <InfoIcon size={16} className="shrink-0" aria-hidden />
        {message.text}
      </p>
    );
  }
  const [first, ...rest] = message.text.split("\n\n");
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="self-center text-caption text-muted-foreground" data-recap>
      <CollapsibleTrigger asChild>
        <Button variant="ghost" size="xs" className="text-foreground-soft">
          {open ? <CaretDownIcon /> : <CaretRightIcon />}
          New session. Recap of the previous one
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <Markdown text={rest.join("\n\n") || first || ""} className="mt-2 text-body text-foreground" />
      </CollapsibleContent>
    </Collapsible>
  );
}

/** An attached picture. Its box has a fixed shape from the start, so the chat does not jump when the picture arrives. */
function Attachment({ src }: { src: string }) {
  return (
    <span className="relative block aspect-4/3 w-60 max-w-full overflow-hidden rounded-control bg-background">
      <Image src={src} alt="Attached" fill sizes="240px" unoptimized className="object-contain" />
    </span>
  );
}

function UserBubble({ item, onRetry }: { item: Item; onRetry: () => void }) {
  const { message } = item;
  const sources = item.images ?? Array.from({ length: message.images }, (_, i) => `/api/d/clots/${encodeURIComponent(message.clot)}/messages/${message.id}/images/${i}`);
  return (
    <div className="flex w-full flex-col items-end gap-1" data-message-kind="user">
      <div className={cn("max-w-[75%] rounded-card bg-muted px-3.5 py-2.5 text-chat", item.status === "sending" && "opacity-70")}>
        {sources.length > 0 ? (
          <div className="mb-2 flex flex-wrap gap-2">
            {sources.map((src, i) => (
              <Attachment key={i} src={src} />
            ))}
          </div>
        ) : null}
        {message.text ? <p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{message.text}</p> : null}
      </div>
      {item.status === "failed" ? (
        <p className="flex items-center gap-2 text-caption text-primary-ink" role="alert">
          Not sent.
          <Button type="button" variant="link" size="xs" onClick={onRetry} className="h-auto p-0 text-primary-ink">
            Retry
          </Button>
        </p>
      ) : null}
    </div>
  );
}

/** One Clot's chat: the messages, the activity between them, ask cards and worker cards, and the composer. */
export function ChatView({ clot, initial, info }: { clot: string; initial: MessagePage; info: ClotInfo }) {
  const { subscribe, onResync, setActiveClot, asks, connection } = useAppState();
  const { open: openPane, pane, close: closePane } = useSidePane();
  const label = labelOfName(clot);
  const params = useSearchParams();
  const focusAsk = Number(params.get("ask") ?? "") || undefined;
  const toItems = (page: MessagePage): Item[] => [...page.messages].reverse().map((m) => ({ message: m, ask: m.ask, workers: m.workers }));
  const [items, setItems] = useState<Item[]>(() => toItems(initial));
  const [hasMore, setHasMore] = useState(initial.hasMore);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [newBelow, setNewBelow] = useState(false);
  const [outcomes, setOutcomes] = useState<Record<number, string>>({});
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  /** Whether the view is at the end of the chat, and so follows what arrives. */
  const stick = useRef(true);
  /** Set while older messages are being added above: where the view was, so it can be put back. */
  const anchor = useRef<{ height: number; top: number }>(undefined);
  const known = useRef(initial.messages.length);
  const router = useRouter();
  useEdgeSwipeBack(() => router.push("/clots"));
  const pending = useRef(new Map<string, Draft>());

  // The chat that is open is the one whose replies are read at once.
  useEffect(() => {
    setActiveClot(clot);
    void api(`/clots/${encodeURIComponent(clot)}/read`, { method: "POST", body: {} }).catch(() => undefined);
    return () => setActiveClot(undefined);
  }, [clot, setActiveClot]);

  // The Clot's info is a side pane on desktop.
  const showInfo = useCallback(() => openPane({ clot, label: `Info about ${label}`, render: () => <InfoPane info={info} /> }), [openPane, clot, label, info]);
  useEffect(() => () => closePane(), [clot, closePane]);

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
      // The banner says the daemon is away; the next open refetches.
    }
  }, [clot]);
  useEffect(() => onResync(() => void refetch()), [onResync, refetch]);

  const refetchWorkers = useCallback(
    async (turnId: string) => {
      try {
        const res = await api<WorkersResponse>(`/turns/${encodeURIComponent(turnId)}/workers`);
        setItems((list) => list.map((i) => (i.message.kind === "workers" && i.message.ref === turnId ? { ...i, workers: res.workers } : i)));
      } catch {
        // Nothing to show yet.
      }
    },
    [],
  );

  useEffect(
    () =>
      subscribe((event) => {
        const d = event.data;
        if (event.type === "ask.closed" && d.clot === clot) setOutcomes((o) => ({ ...o, [d.id]: d.outcome }));
        if (event.type === "workers.updated" && d.clot === clot) void refetchWorkers(d.turnId);
        if (d?.clot !== clot) return;
        if (event.type === "message.created" || event.type === "message.done") {
          const message = d.message as MessageView;
          setItems((list) => {
            const at = list.findIndex((i) => i.message.id === message.id);
            const item: Item = { message };
            if (at >= 0) return list.map((i, j) => (j === at ? { ...i, message, status: undefined, streaming: false } : i));
            return [...list, item];
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
    [subscribe, clot, refetchWorkers],
  );

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
    const target = document.querySelector(`[data-ask-id="${focusAsk}"]`) as HTMLElement | null;
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
  }, [items, hasMore, loadingOlder, clot]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM;
    if (stick.current) setNewBelow(false);
    if (el.scrollTop < 200) void loadOlder();
  };

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
    [clot],
  );
  const send = (draft: Draft) => {
    const id = crypto.randomUUID();
    pending.current.set(id, draft);
    stick.current = true;
    setItems((list) => [...list, { status: "sending", images: draft.images, message: { id, clot, sessionId: null, kind: "user", text: draft.text, ref: null, data: null, createdAt: Date.now(), images: 0 } }]);
    void submit(id, draft);
  };
  const retry = (id: string) => {
    const draft = pending.current.get(id);
    if (!draft) return;
    setItems((list) => list.map((i) => (i.message.id === id ? { ...i, status: "sending" } : i)));
    void submit(id, draft);
  };

  const state = useAppState().clots.find((c) => c.name === clot);
  // What an earlier session said stays in the chat, dimmed: the Clot no longer sees it.
  const currentSession = [...items].reverse().find((i) => i.message.sessionId !== null)?.message.sessionId;
  const older = (m: MessageView) => currentSession !== undefined && m.sessionId !== null && m.sessionId !== currentSession;
  const lastIsStreaming = items.at(-1)?.streaming === true;

  // Messages from the same side within five minutes share one timestamp, under the last of them.
  const rendered = useMemo(
    () =>
      items.map((item, i) => {
        const next = items[i + 1];
        const side = (m: MessageView) => (m.kind === "user" ? "user" : m.kind === "clot" ? "clot" : "other");
        const here = side(item.message);
        const last = here !== "other" && (next === undefined || side(next.message) !== here || next.message.createdAt - item.message.createdAt > GROUP_MS);
        return { item, stamp: last && item.status === undefined && !item.streaming };
      }),
    [items],
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="grid h-14 shrink-0 grid-cols-[1fr_auto_1fr] items-center px-4 max-md:h-auto max-md:px-2 max-md:pb-1.5 max-md:pt-[max(calc(env(safe-area-inset-top)+4px),54px)]">
        <Button asChild variant="ghost" className="-ml-0 h-11 justify-self-start px-2 text-base font-medium md:hidden">
          <Link href="/clots">
            <CaretLeftIcon size={20} aria-hidden /> Clots
          </Link>
        </Button>
        <span className="max-md:hidden" />
        <h1 className="text-[15px] font-semibold max-md:text-[17px] max-md:font-bold">{label}</h1>
        <div className="flex justify-self-end max-md:hidden">
          <Button variant="ghost" size="icon" aria-label="Info" aria-pressed={pane?.clot === clot} onClick={() => (pane?.clot === clot ? closePane() : showInfo())} className={cn(pane?.clot === clot && "bg-muted")}>
            <InfoIcon size={20} />
          </Button>
        </div>
      </header>
      <div className="relative min-h-0 flex-1">
        <div ref={scroller} onScroll={onScroll} tabIndex={0} aria-label="Messages" role="region" className="h-full overflow-y-auto overscroll-contain outline-none [overflow-anchor:none] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring" data-chat-scroller>
          <div ref={content} className="content-width flex min-h-full flex-col gap-4 px-4 pb-4 pt-2 md:px-10">
            {rendered.map(({ item, stamp }) => {
              const { message } = item;
              switch (message.kind) {
                case "user":
                  return (
                    <div key={message.id} className={cn("flex w-full flex-col items-end gap-1", older(message) && "opacity-55")}>
                      <UserBubble item={item} onRetry={() => retry(message.id)} />
                    </div>
                  );
                case "clot":
                  return (
                    <div key={message.id} className={cn("flex flex-col gap-1", older(message) && "opacity-55")} data-message-kind="clot" data-streaming={item.streaming ? "true" : undefined}>
                      <Markdown text={message.text} />
                      {stamp ? <span className="text-caption text-muted-foreground">{time(message.createdAt)}</span> : null}
                    </div>
                  );
                case "activity":
                  return <Activity key={message.id} message={message} />;
                case "note":
                  return <Note key={message.id} message={message} />;
                case "workers":
                  return item.workers ? <WorkerCard key={message.id} workers={item.workers} /> : null;
                case "onboarding":
                  return <OnboardingCard key={message.id} message={message} />;
                case "ask": {
                  const id = Number(message.ref);
                  const open = asks.find((a) => a.id === id);
                  const ended = outcomes[id] ?? (item.ask?.state === "closed" ? item.ask.outcome : undefined);
                  if (open) return <AskCard key={message.id} card={{ id, state: open.state, snapshot: open }} focus={focusAsk === id} />;
                  return ended !== undefined ? <AskOutcome key={message.id} text={ended} /> : null;
                }
              }
            })}
            {state?.state === "working" && !lastIsStreaming ? (
              <p className="flex items-center gap-2 text-caption text-muted-foreground" role="status">
                <span className="size-1.5 animate-pulse rounded-full bg-highlight" aria-hidden />
                {label} is working
              </p>
            ) : null}
            {state?.state === "failed" ? <p className="text-caption text-primary-ink">{state.reason ?? "The last turn failed."}</p> : null}
          </div>
        </div>
        {loadingOlder ? <Skeleton className="absolute inset-x-4 top-2 mx-auto h-10 max-w-sm" role="status" aria-label="Loading earlier messages" /> : null}
        {newBelow ? (
          <Button
            size="sm"
            onClick={() => {
              stick.current = true;
              toEnd();
              setNewBelow(false);
            }}
            className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full shadow-pop"
          >
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
