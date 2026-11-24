"use client";

import { useState } from "react";
import { CheckCircleIcon } from "@phosphor-icons/react";
import type { AskCard as AskCardData, AskSnapshot } from "@clots/ui-api-schemas";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { useAppState } from "./app-state";
import { Timer, useNow } from "./timer";
import { timerView } from "@/lib/timer";
import { useAnswer } from "./use-answer";

/** What a card that has ended shows: one quiet line, as the activity lines do. */
export function AskOutcome({ text }: { text: string }) {
  return (
    <p className="flex items-center gap-2 py-1 text-caption text-muted-foreground" data-ask-outcome>
      <CheckCircleIcon size={16} aria-hidden />
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
  if (card.state === "closed") return <AskOutcome text={card.outcome ?? "Closed"} />;
  if (!card.snapshot) return null;
  return <OpenAsk snapshot={card.snapshot} focus={focus} />;
}

function OpenAsk({ snapshot, focus }: { snapshot: AskSnapshot; focus?: boolean }) {
  const { connection } = useAppState();
  const { busy, error, outcome, send } = useAnswer(snapshot.id);
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
      className={cn("gap-3 px-4 py-4 shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring md:gap-3.5 md:px-5 md:py-5", focus && "ring-2 ring-ring")}
    >
      <div className="flex items-start justify-between gap-3">
        <h3 className="text-dialog-title text-pretty max-md:hidden">{view.heading}</h3>
        <h3 className="text-dialog-title text-pretty md:hidden">{view.shortHeading}</h3>
        <Timer deadline={snapshot.deadline} prefix="Blocks in" className="hidden shrink-0 md:inline-flex" />
      </div>
      {view.warning ? <p className="text-caption text-muted-foreground">{view.warning}</p> : null}
      <div className="flex flex-col gap-3">
        <Details view={view} />
        {view.previous !== undefined ? (
          <div>
            <p className="mb-1 text-caption text-muted-foreground">Now</p>
            <pre className="max-h-40 overflow-auto rounded-control bg-muted p-3 font-mono text-code whitespace-pre-wrap">{view.previous}</pre>
          </div>
        ) : null}
        {view.bodyEditable ? (
          <div>
            <Label htmlFor={`ask-body-${snapshot.id}`} className="mb-1.5 text-caption font-semibold text-foreground-soft">
              Message, editable
            </Label>
            <Textarea id={`ask-body-${snapshot.id}`} value={body} onChange={(e) => setBody(e.target.value)} disabled={working || outcome !== undefined} className="h-37.5 resize-none text-[16px] leading-relaxed md:h-26 md:text-body" />
            {edited ? <p className="mt-1 text-caption text-muted-foreground">Your changes are sent, and {snapshot.clot} is told what you changed.</p> : null}
          </div>
        ) : view.body !== undefined ? (
          <pre className="max-h-72 overflow-auto rounded-control bg-muted p-3 font-mono text-code whitespace-pre-wrap">{view.body}</pre>
        ) : null}
      </div>
      {outcome !== undefined ? <p className="text-body text-muted-foreground">{outcome}</p> : null}
      {error ? (
        <p role="alert" className="text-body text-primary-ink">
          {error}
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
            <span className="tabular-nums text-muted-foreground md:hidden">{timerView(snapshot.deadline, now).text}</span>
          </Button>
          <Button size="lg" disabled={off} onClick={allow} className="h-11 flex-1 md:h-9 md:flex-none">
            {working ? <Spinner /> : null}
            {error ? "Retry" : labels.allow}
          </Button>
        </div>
      )}
    </Card>
  );
}
