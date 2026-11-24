"use client";

import { ArrowLeftIcon, WarningIcon } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import type { Toolkit } from "@/lib/integrations";
import { ToolLogo } from "../tool-logo";
import { StepFrame } from "./step-frame";

/** What the connect steps look like while their content is still being made: the same centred shapes, as skeletons. */
function ConnectSkeleton() {
  return (
    <div aria-hidden className="flex flex-1 flex-col items-center justify-center gap-4">
      <Skeleton className="h-5 w-40 bg-muted-strong" />
      <div className="flex flex-col items-center gap-2">
        <Skeleton className="h-3.5 w-80 bg-muted-strong" />
        <Skeleton className="h-3.5 w-56 bg-muted-strong" />
      </div>
      <Skeleton className="h-10 w-48 rounded-control bg-muted-strong" />
    </div>
  );
}

/**
 * Step three: the configurer is working, shown as skeletons. There is no close button, so a stray click cannot cancel a
 * half-made connection; Back returns to the options. When it fails, the error shows with Try again and Back.
 */
export function WorkingStep({ toolkit, error, onBack, onRetry }: { toolkit: Toolkit; error?: string; onBack: () => void; onRetry: () => void }) {
  return (
    <StepFrame
      title={`Configure ${toolkit.name}`}
      logo={<ToolLogo toolkit={toolkit.slug} name={toolkit.name} logo={toolkit.logo} size="sm" />}
      footer={
        <>
          <Button variant="outline" onClick={onBack}>
            <ArrowLeftIcon /> Back
          </Button>
          {error ? <Button onClick={onRetry}>Try again</Button> : null}
        </>
      }
    >
      {error ? (
        <div role="alert" className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
          <WarningIcon size={24} aria-hidden className="text-primary-ink" />
          <p className="max-w-95 text-body text-primary-ink">{error}</p>
        </div>
      ) : (
        <div role="status" aria-label={`Setting up ${toolkit.name}`} className="flex flex-1 flex-col">
          <ConnectSkeleton />
        </div>
      )}
    </StepFrame>
  );
}
