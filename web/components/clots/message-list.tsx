"use client";

import { useMemo } from "react";
import type { AskSnapshot, MessageView } from "@clots/ui-api-schemas";
import { cn } from "@/lib/utils";
import { AskCard, AskOutcome } from "./ask-card";
import { endedOutcomes, stampedIds, time, type Ended, type Item } from "./chat-items";
import { Activity, Note, UserBubble } from "./chat-parts";
import { Markdown } from "./markdown";
import { OnboardingCard } from "./onboarding-card";
import { WorkerCard } from "./worker-card";

/**
 * Every message of a chat, one renderer per kind. What an earlier session said stays, dimmed: the Clot no longer sees it. An ask that
 * has ended is one quiet line saying how, and the daemon's own note of the same words is left out so it is not read twice.
 */
export function MessageList({ items, openAsks, outcomes, focusAsk, onRetry }: { items: Item[]; openAsks: AskSnapshot[]; outcomes: Record<number, Ended>; focusAsk: number | undefined; onRetry: (id: string) => void }) {
  const stamped = useMemo(() => stampedIds(items), [items]);
  const ended = useMemo(() => endedOutcomes(items, outcomes), [items, outcomes]);
  const endings = useMemo(() => new Set([...ended.values()].map((e) => e.text)), [ended]);
  const currentSession = [...items].reverse().find((i) => i.message.sessionId !== null)?.message.sessionId;
  const older = (m: MessageView) => currentSession !== undefined && m.sessionId !== null && m.sessionId !== currentSession;

  return (
    <>
      {items.map((item) => {
        const { message } = item;
        switch (message.kind) {
          case "user":
            return <UserBubble key={message.id} item={item} dimmed={older(message)} onRetry={() => onRetry(message.id)} />;
          case "clot":
            return (
              <div key={message.id} className={cn("flex flex-col gap-2.5", older(message) && "opacity-55")} data-message-kind="clot" data-streaming={item.streaming ? "true" : undefined}>
                <Markdown text={message.text} />
                {stamped.has(message.id) ? <span className="text-caption font-normal text-muted-foreground">{time(message.createdAt)}</span> : null}
              </div>
            );
          case "activity":
            return <Activity key={message.id} message={message} />;
          case "note":
            return endings.has(message.text) ? null : <Note key={message.id} message={message} />;
          case "workers":
            return item.workers ? <WorkerCard key={message.id} workers={item.workers} /> : null;
          case "onboarding":
            return <OnboardingCard key={message.id} message={message} />;
          case "ask": {
            const id = Number(message.ref);
            const open = openAsks.find((a) => a.id === id);
            if (open) return <AskCard key={message.id} card={{ id, state: open.state, snapshot: open }} focus={focusAsk === id} />;
            const done = ended.get(id);
            return done !== undefined ? <AskOutcome key={message.id} text={done.text} result={done.result} /> : null;
          }
        }
      })}
    </>
  );
}
