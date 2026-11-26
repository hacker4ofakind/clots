"use client";

import { useState } from "react";
import { ArrowBendUpLeftIcon, ChatCircleIcon, CheckCircleIcon, ClockCountdownIcon, SpinnerIcon, WarningCircleIcon, XCircleIcon, type Icon } from "@phosphor-icons/react";
import type { AskCard as AskCardData, AskResult, AskSnapshot } from "@clots/ui-api-schemas";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { useAppState } from "./app-state";
import { Timer, useNow } from "./timer";
import { timerView } from "@/lib/timer";
import { CodeBlock } from "./code-block";
import { useAnswer } from "./use-answer";

/** The icon for how an ask ended. A row closed before results were kept has none, and reads as approved. */
const RESULT_ICONS: Record<AskResult, Icon> = {
  approved: CheckCircleIcon,
  declined: XCircleIcon,
  timed_out: ClockCountdownIcon,
  failed: WarningCircleIcon,
  feedback: ChatCircleIcon,
  withdrawn: ArrowBendUpLeftIcon,
};

/** What a card that has ended shows: one quiet line, as the activity lines do. */
export function AskOutcome({ text, result }: { text: string; result?: AskResult }) {
  const ResultIcon = RESULT_ICONS[result ?? "approved"];
  return (
    <p className="flex items-center gap-2 text-label leading-normal font-normal text-muted-foreground" data-ask-outcome data-ask-result={result ?? "approved"}>
      <ResultIcon size={16} aria-hidden />
      {text}
    </p>
  );
}

function Details({ view }: { view: AskSnapshot["view"] }) {
  if (view.rows.length === 0) return null;
  return (
    <>
      <p className="whitespace-pre-line text-label font-normal leading-normal text-muted-foreground md:hidden">{view.rows.filter((r) => r.label !== "Subject").map((r) => `${r.label} ${r.value}`).join("\n")}</p>
      <dl className="grid grid-cols-[76px_1fr] gap-y-1 text-body max-md:hidden">
      {view.rows.map((row) => (
        <div key={row.label} className="contents">
          <dt className="text-muted-foreground">{row.label}</dt>
          <dd className="min-w-0 break-words">
            {row.href ? (
              <a href={row.href} target="_blank" rel="noopener noreferrer" className="text-primary-ink underline-offset-2 hover:underline">
                {row.value}
              </a>
            ) : (
              row.value
            )}
          </dd>
        </div>
      ))}
      </dl>
    </>
  );
}

/**
 * An ask in a Clot's chat. Open, it shows what the Clot wants to do, how long it has before it is blocked, and buttons;
 * an email's text can be changed in the card. Answered, it folds into one line saying how it ended. A failed answer keeps the
 * card, with Retry; an edited email that finds the ask closed keeps its text and shows how it ended.
 */
export function AskCard({ card, focus }: { card: AskCardData; focus?: boolean }) {
  if (card.state === "closed") return <AskOutcome text={card.outcome ?? "Closed"} result={card.result} />;
  if (!card.snapshot) return null;
  return <OpenAsk snapshot={card.snapshot} focus={focus} />;
}

function OpenAsk({ snapshot, focus }: { snapshot: AskSnapshot; focus?: boolean }) {
  const { connection } = useAppState();
  const { busy, error, outcome, send, retry } = useAnswer(snapshot.id);
  const view = snapshot.view;
  const [body, setBody] = useState(view.body ?? "");
  const now = useNow(snapshot.deadline);
  const closing = timerView(snapshot.deadline, now).state === "closing";
  const working = busy || snapshot.state === "busy";
  const off = connection === "down" || working || closing || outcome !== undefined;
  const edited = view.bodyEditable === true && body !== (view.body ?? "");
  const labels = view.labels ?? { allow: "Approve", block: "Decline" };

  const allow = () => void send(edited ? { action: "edit", body } : { action: "allow" });

  return (
    <Card
      role="region"
      aria-label={view.heading}
      data-ask-id={snapshot.id}
      data-ask-state={snapshot.state}
      tabIndex={-1}
      className={cn("gap-3 px-4 py-4 shadow-card outline-none focus-visible:ring-2 focus-visible:ring-ring md:gap-3.5 md:px-5 md:py-5", focus && "ring-2 ring-ring")}
    >
      <div className="flex items-start justify-between gap-3">
        <h2 className="text-dialog-title text-pretty md:text-section md:leading-normal">
          <span className="max-md:hidden">{view.heading}</span>
          <span className="md:hidden">{view.shortHeading}</span>
        </h2>
        <Timer deadline={snapshot.deadline} prefix="Blocks in" className="hidden shrink-0 md:inline-flex" />
      </div>
      {view.warning ? <p className="text-caption text-muted-foreground">{view.warning}</p> : null}
      <div className="flex flex-col gap-3">
        <Details view={view} />
        {view.previous !== undefined ? (
          <div>
            <p className="mb-1 text-caption text-muted-foreground">Now</p>
            <CodeBlock className="max-h-40">{view.previous}</CodeBlock>
          </div>
        ) : null}
        {view.bodyEditable ? (
          <div>
            <Label htmlFor={`ask-body-${snapshot.id}`} className="mb-1.5 text-caption leading-normal font-semibold text-foreground-soft">
              Message, editable
            </Label>
            <Textarea id={`ask-body-${snapshot.id}`} value={body} onChange={(e) => setBody(e.target.value)} disabled={working || outcome !== undefined} className="h-37.5 resize-none px-3 py-2.5 text-base leading-[1.6] md:h-26 md:text-ui dark:border-transparent dark:bg-muted" />
            {edited ? <p className="mt-1 text-caption text-muted-foreground">Your changes are sent, and {snapshot.clot} is told what you changed.</p> : null}
          </div>
        ) : view.body !== undefined ? (
          <CodeBlock>{view.body}</CodeBlock>
        ) : null}
      </div>
      {outcome !== undefined ? <p className="text-body text-muted-foreground">{outcome}</p> : null}
      {closing && outcome === undefined ? (
        <p role="status" data-ask-closing className="flex items-center gap-2 text-body text-muted-foreground">
          <SpinnerIcon className="size-4 animate-spin" aria-hidden /> Closing…
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="flex flex-wrap items-center gap-x-3 text-body text-primary-ink">
          {error}
          <Button type="button" variant="link" size="xs" disabled={connection === "down" || working} onClick={() => void retry()} className="h-auto p-0 text-primary-ink">
            Retry
          </Button>
        </p>
      ) : null}
      {view.options ? (
        <div className="flex flex-col gap-2 md:flex-row md:justify-between">
          {view.options.map((option, i) => (
            <Button key={option} variant="outline" size="lg" disabled={off} onClick={() => void send({ action: "pick", option: i as 0 | 1 })} className={cn("md:h-9", view.pick === i && "border-primary")}>
              {option}
              {view.pick === i ? <span className="text-muted-foreground">· the Clot&apos;s pick</span> : null}
            </Button>
          ))}
        </div>
      ) : (
        <div className="flex gap-2.5 md:justify-between">
          <Button variant="outline" size="lg" disabled={off} onClick={() => void send({ action: "block" })} className="h-11 flex-1 md:h-9 md:flex-none">
            {labels.block}
            <span suppressHydrationWarning className="tabular-nums text-muted-foreground md:hidden">{timerView(snapshot.deadline, now).text}</span>
          </Button>
          <Button size="lg" disabled={off} onClick={allow} className="h-11 flex-1 md:h-9 md:flex-none">
            {working ? <Spinner /> : null}
            {labels.allow}
          </Button>
        </div>
      )}
    </Card>
  );
}
