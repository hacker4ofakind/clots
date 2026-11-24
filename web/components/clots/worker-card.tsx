"use client";

import { useState } from "react";
import { CaretDownIcon, GitPullRequestIcon, HourglassIcon, WarningIcon } from "@phosphor-icons/react";
import type { WorkerView } from "@clots/ui-api-schemas";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { StatusDot } from "./status-dot";

function Row({ worker }: { worker: WorkerView }) {
  const failed = worker.status === "failed";
  const Icon = failed ? WarningIcon : worker.status === "queued" ? HourglassIcon : GitPullRequestIcon;
  const text = (
    <>
      <Icon size={16} className={cn("shrink-0", failed ? "text-primary-ink" : "text-highlight-ink")} aria-hidden />
      <span className="min-w-0 flex-1 truncate text-body">{worker.title}</span>
      <span className="shrink-0 text-caption text-muted-foreground">
        {worker.model} · {worker.effort}
      </span>
    </>
  );
  return (
    <li className="flex items-center gap-3" data-worker-status={worker.status}>
      {worker.pr ? (
        <a href={worker.pr} target="_blank" rel="noopener noreferrer" className="flex min-w-0 flex-1 items-center gap-3 rounded-sm hover:underline" aria-label={`${worker.title}, pull request`}>
          {text}
        </a>
      ) : (
        text
      )}
    </li>
  );
}

/** The footer's words: what the group is doing, in the accent while any worker runs. */
export function workersSummary(workers: WorkerView[]): { text: string; running: boolean } {
  const count = (status: WorkerView["status"]) => workers.filter((w) => w.status === status).length;
  const running = count("running") + count("queued");
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  if (running > 0) return { text: `${plural(running, "worker", "workers")} running`, running: true };
  const failed = count("failed");
  const opened = count("pr-open");
  const parts = [opened > 0 ? plural(opened, "pull request opened", "pull requests opened") : "", failed > 0 ? `${plural(failed, "worker", "workers")} failed` : ""].filter(Boolean);
  return { text: parts.length > 0 ? parts.join(", ") : `${plural(workers.length, "worker", "workers")} done`, running: false };
}

/**
 * One card after the turn that started workers: the first two with their title, model and effort, "N more" for the rest,
 * and a footer that says where the group stands. No cards inside it and no dividers; each row links to its pull request
 * once there is one.
 */
export function WorkerCard({ workers }: { workers: WorkerView[] }) {
  const [all, setAll] = useState(false);
  if (workers.length === 0) return null;
  const shown = all ? workers : workers.slice(0, 2);
  const rest = workers.length - shown.length;
  const summary = workersSummary(workers);
  return (
    <Card role="region" aria-label="Workers" data-workers className="gap-3 px-4.5 py-4">
      <ul className="flex flex-col gap-3">
        {shown.map((w) => (
          <Row key={w.id} worker={w} />
        ))}
      </ul>
      <div className="flex items-center justify-between">
        {rest > 0 ? (
          <Button variant="ghost" size="sm" onClick={() => setAll(true)} className="-ml-2.5 text-muted-foreground">
            {rest} more <CaretDownIcon />
          </Button>
        ) : (
          <span />
        )}
        <p className={cn("flex items-center gap-2 text-label", summary.running ? "text-highlight-ink" : "font-normal text-muted-foreground")} aria-live="polite">
          {summary.running ? <StatusDot tone="highlight" className="size-2" /> : null}
          {summary.text}
        </p>
      </div>
    </Card>
  );
}
