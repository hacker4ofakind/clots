"use client";

import { CheckCircleIcon, CircleIcon, WarningIcon } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { readableBuildFailure } from "@/lib/readable-error";
import { CodeBlock } from "./code-block";
import type { Build } from "./new-clot-state";

const ORDER = ["cloning", "building", "starting", "done"] as const;
const LABEL = { cloning: "Cloning the repository", building: "Building the container", starting: "Starting" } as const;

/**
 * Where the daemon is in making a Clot, or in moving it to another repository (which clones into a fresh workspace first): each step
 * done, under way or waiting. A failure shows what the daemon said, with Retry.
 */
export function BuildProgress({ name, build, moving, onRetry, onStartOver }: { name: string; build: Build | undefined; moving: boolean; onRetry: () => void; onStartOver: () => void }) {
  if (build?.step === "failed") {
    return (
      <div className="flex flex-col gap-4" role="alert">
        <p className="flex items-center gap-2 text-body text-primary-ink">
          <WarningIcon aria-hidden /> {moving ? `${name} could not be moved to the new repository.` : `${name} could not be created.`}
        </p>
        <p className="text-body text-muted-foreground">{readableBuildFailure(build.log)}</p>
        <CodeBlock>{build.log}</CodeBlock>
        <div className="flex gap-2">
          <Button variant="outline" onClick={onStartOver}>
            {moving ? "Back to Clots" : "Start over"}
          </Button>
          <Button onClick={onRetry}>Retry</Button>
        </div>
      </div>
    );
  }
  const at = ORDER.indexOf(build?.step ?? "cloning");
  return (
    <div className="flex flex-col gap-4" aria-live="polite">
      <ul className="flex flex-col gap-2.5">
        {(["cloning", "building", "starting"] as const).map((s) => {
          const index = ORDER.indexOf(s);
          const state = index < at ? "done" : index === at ? "now" : "next";
          return (
            <li key={s} className="flex items-center gap-2.5 text-body" data-build-step={s} data-state={state}>
              {state === "done" ? <CheckCircleIcon size={20} weight="fill" className="text-highlight-ink" aria-label="Done" /> : state === "now" ? <Spinner className="size-5" aria-label="Under way" /> : <CircleIcon size={20} className="text-muted-foreground" aria-label="Waiting" />}
              <span className={state === "next" ? "text-muted-foreground" : state === "done" ? "text-muted-foreground" : "font-medium"}>{LABEL[s]}</span>
            </li>
          );
        })}
      </ul>
      {moving ? <p className="max-w-130 text-label font-normal text-muted-foreground">{name} is cloned from the new repository into a fresh workspace. The old workspace is kept, and {name} stays on it if this fails.</p> : null}
    </div>
  );
}
