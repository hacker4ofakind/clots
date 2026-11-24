"use client";

import { useEffect, useState } from "react";
import { ArrowLeftIcon, ArrowSquareOutIcon, CheckCircleIcon } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import type { Toolkit } from "@/lib/integrations";
import { ToolLogo } from "../tool-logo";
import { StepFrame } from "./step-frame";

/** How long Done stays off after this step is shown, so the sign-in cannot be skipped by a quick click. */
export const DONE_DELAY_MS = 5000;

/** Seconds left of the delay, counting from `since` (and not before the daemon's own `readyAt`). */
function useCountdown(since: number, readyAt?: number): number {
  const [now, setNow] = useState(() => Date.now());
  const end = Math.max(since + DONE_DELAY_MS, readyAt ?? 0);
  useEffect(() => {
    if (Date.now() >= end) return;
    const timer = setInterval(() => {
      setNow(Date.now());
      if (Date.now() >= end) clearInterval(timer);
    }, 250);
    return () => clearInterval(timer);
  }, [end]);
  return Math.max(0, Math.ceil((end - now) / 1000));
}

/**
 * Step four for an OAuth toolkit: a button that opens Composio's sign-in in a new tab. Done is off for five seconds after the
 * step is shown, and stays off until the daemon reports the connection active.
 */
export function OAuthStep({ toolkit, link, active, needsRestart, shownAt, readyAt, onBack, onDone }: { toolkit: Toolkit; link: string | undefined; active: boolean; needsRestart: boolean; shownAt: number; readyAt?: number; onBack: () => void; onDone: () => void }) {
  const left = useCountdown(shownAt, readyAt);
  return (
    <StepFrame
      title={`Configure ${toolkit.name}`}
      logo={<ToolLogo toolkit={toolkit.slug} name={toolkit.name} logo={toolkit.logo} size="sm" />}
      footer={
        <>
          <Button variant="outline" onClick={onBack}>
            <ArrowLeftIcon /> Back
          </Button>
          <Button disabled={left > 0 || !active} onClick={onDone}>
            Done {left > 0 ? <span className="tabular-nums opacity-80">({left})</span> : null}
          </Button>
        </>
      }
    >
      <div className="flex flex-1 flex-col items-center justify-center gap-4 text-center">
        <p className="text-chat font-semibold">You’re almost done!</p>
        <p className="max-w-95 text-body text-muted-foreground">Sign in to {toolkit.name} and let Composio connect it. The sign-in opens in a new tab.</p>
        <Button variant="outline" size="lg" className="px-4.5 text-chat" asChild>
          <a href={link} target="_blank" rel="noopener noreferrer">
            Sign in to {toolkit.name}
            <ArrowSquareOutIcon />
          </a>
        </Button>
        <p aria-live="polite" className="flex h-5 items-center gap-1.5 text-label font-normal text-muted-foreground">
          {active ? (
            <>
              <CheckCircleIcon weight="fill" aria-hidden className="text-highlight-ink" /> {needsRestart ? "Connected. Restart the daemon to finish." : "Connected"}
            </>
          ) : null}
        </p>
      </div>
    </StepFrame>
  );
}
