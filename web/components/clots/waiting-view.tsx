"use client";

import { useRouter } from "next/navigation";
import { CoffeeIcon } from "@phosphor-icons/react";
import type { AskSnapshot, ClotSummary } from "@clots/ui-api-schemas";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { clotLabel } from "@/lib/clots";
import { countUrgent } from "@/lib/timer";
import { useAppState } from "./app-state";
import { AskActions } from "./ask-actions";
import { ClotIcon } from "./clot-icon";
import { CodeBlock } from "./code-block";
import { NotificationsRow } from "./notifications-row";
import { Timer, useNow } from "./timer";
import { useAnswer } from "./use-answer";

/** The email as the user will see it sent: shown beside the subject, so nothing is sent unseen. */
function EmailPreview({ ask }: { ask: AskSnapshot }) {
  const { view } = ask;
  return (
    <div className="flex flex-col gap-2">
      <dl className="grid grid-cols-[56px_1fr] gap-x-2 gap-y-1 text-caption">
        {view.rows.map((row) => (
          <div key={row.label} className="contents">
            <dt className="text-muted-foreground">{row.label}</dt>
            <dd className="break-words">{row.value}</dd>
          </div>
        ))}
      </dl>
      <CodeBlock className="max-h-64">{view.body}</CodeBlock>
    </div>
  );
}

/** An email ask's one line, with the subject marked as the part that shows the email on hover. */
function EmailSubject({ ask }: { ask: AskSnapshot }) {
  const subject = ask.view.rows.find((r) => r.label === "Subject")?.value;
  const at = subject === undefined ? -1 : ask.summary.indexOf(subject);
  if (subject === undefined || at < 0) return <>{ask.summary}</>;
  return (
    <>
      {ask.summary.slice(0, at)}
      <span className="underline decoration-input decoration-dotted underline-offset-3">{subject}</span>
      {ask.summary.slice(at + subject.length)}
    </>
  );
}

function AskRow({ ask, clot }: { ask: AskSnapshot; clot: ClotSummary }) {
  const router = useRouter();
  const { connection } = useAppState();
  const { busy, outcome, send } = useAnswer(ask.id);
  const chat = `/c/${encodeURIComponent(ask.clot)}?ask=${ask.id}`;
  const open = () => router.push(chat);
  const isEmail = ask.kind === "email";
  const title = <span className="block min-w-0 truncate text-chat font-[550] max-md:text-base">{isEmail ? <EmailSubject ask={ask} /> : ask.summary}</span>;
  const disabled = connection === "down" || outcome !== undefined;
  const actions = { ask, busy: busy || ask.state === "busy", disabled, onAllow: () => void send({ action: "allow" }), onBlock: () => void send({ action: "block" }), onPick: (option: 0 | 1) => void send({ action: "pick", option }), onOpen: open };

  return (
    <li
      data-ask-row={ask.id}
      className="flex items-center gap-4 max-md:cursor-pointer max-md:gap-3 max-md:px-5 max-md:py-3.5 max-md:not-first:border-t md:min-h-12"
      onClick={(e) => (e.target instanceof Element && e.target.closest("button, a") ? undefined : void (window.matchMedia("(max-width: 767px)").matches ? open() : undefined))}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-caption font-semibold text-muted-foreground md:hidden">
          <ClotIcon icon={clot.icon} home={clot.home} size={16} tile={16} />
          {clotLabel(clot)}
          <Timer deadline={ask.deadline} className="px-1.5 py-0 [&_svg]:hidden" />
        </div>
        {isEmail ? (
          <HoverCard openDelay={150}>
            <HoverCardTrigger asChild>
              <Button type="button" variant="ghost" className="h-auto w-full min-w-0 justify-start rounded-sm p-0 text-left font-normal hover:bg-transparent md:w-auto" aria-describedby={`preview-${ask.id}`}>
                {title}
              </Button>
            </HoverCardTrigger>
            <HoverCardContent align="start" className="w-105" id={`preview-${ask.id}`}>
              <EmailPreview ask={ask} />
            </HoverCardContent>
          </HoverCard>
        ) : (
          title
        )}
        {outcome ? <span className="text-caption text-muted-foreground">{outcome}</span> : null}
      </div>
      <Timer deadline={ask.deadline} className="shrink-0 max-md:hidden" />
      <div className="shrink-0 max-md:hidden">
        <AskActions {...actions} onEdit={isEmail ? () => router.push(`${chat}&edit=1`) : undefined} />
      </div>
      <div className="shrink-0 md:hidden">
        <AskActions {...actions} compact />
      </div>
    </li>
  );
}

/**
 * Everything waiting for the user, grouped under each Clot's name in the rail's order, oldest first. The summary counts what
 * is urgent (under a minute left). With nothing waiting it says so, kindly. On a phone the groups' headings go: each row
 * names its Clot instead.
 */
export function WaitingView() {
  const { asks, clots } = useAppState();
  const now = useNow(asks[0]?.deadline);
  const groups = clots.map((clot) => ({ clot, asks: asks.filter((a) => a.clot === clot.name).sort((a, b) => a.openedAt - b.openedAt) })).filter((g) => g.asks.length > 0);
  const urgent = countUrgent(asks, now);

  return (
    <div tabIndex={0} aria-label="Waiting for you" role="region" className="flex h-full flex-col overflow-y-auto pb-28 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring md:pb-0">
      <div className="content-width flex flex-1 flex-col md:gap-7 md:p-10">
        <div className="flex items-baseline justify-between gap-3 max-md:px-5 max-md:pb-3 max-md:pt-[max(env(safe-area-inset-top),48px)]">
          <h1 className="text-title-mobile leading-normal md:text-title">Waiting for you</h1>
          {asks.length > 0 ? (
            <p suppressHydrationWarning className="text-label font-normal text-muted-foreground md:text-body" aria-live="polite">
              {asks.length}
              <span className="max-md:hidden"> waiting</span> · {urgent} urgent
            </p>
          ) : null}
        </div>
        <div className="md:hidden">
          <NotificationsRow />
        </div>
        {asks.length === 0 ? (
          <Empty className="flex-1 pb-20">
            <EmptyHeader className="items-center gap-3.5">
              <EmptyMedia variant="icon" className="size-16 rounded-tile-xl text-foreground-soft [&_svg:not([class*='size-'])]:size-8">
                <CoffeeIcon />
              </EmptyMedia>
              <EmptyTitle role="heading" aria-level={2} className="text-empty font-bold">
                Continue with your life!
              </EmptyTitle>
              <EmptyDescription className="text-chat text-muted-foreground">None of your Clots are waiting for you.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="flex flex-col md:gap-7">
            {groups.map(({ clot, asks: list }) => (
              <section key={clot.name} aria-label={clotLabel(clot)} className="flex flex-col md:gap-0.5">
                <h2 className="mb-1 flex items-center gap-2 text-body font-bold text-foreground-soft max-md:hidden">
                  <ClotIcon icon={clot.icon} home={clot.home} size={16} tile={18} />
                  {clotLabel(clot)}
                </h2>
                <ul className="flex flex-col">
                  {list.map((ask) => (
                    <AskRow key={ask.id} ask={ask} clot={clot} />
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
