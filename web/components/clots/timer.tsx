"use client";

import { useEffect, useState } from "react";
import { ClockIcon } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import { timerView, type TimerState } from "@/lib/timer";

/** The current time, ticking every second while a deadline is near, and every half minute otherwise. */
export function useNow(deadline?: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const near = deadline !== undefined && deadline - Date.now() < 6 * 60_000;
    const id = setInterval(tick, near ? 1000 : 30_000);
    tick();
    return () => clearInterval(id);
  }, [deadline]);
  return now;
}

const STYLE: Record<TimerState, string> = {
  calm: "text-muted-foreground",
  calling: "bg-calling-soft text-calling-ink",
  urgent: "bg-primary-soft text-primary-ink",
  closing: "bg-muted text-muted-foreground",
};

/**
 * A countdown to the moment an ask is blocked (silence never approves). Calm above 5 minutes, calling from 5 to 1,
 * urgent under a minute. The state is in its text as well as its colour, for a screen reader. Digits are tabular.
 */
export function Timer({ deadline, prefix, className }: { deadline: number; prefix?: string; className?: string }) {
  const now = useNow(deadline);
  const view = timerView(deadline, now);
  const label = view.state === "closing" ? "Closing" : `${view.state === "urgent" ? "Urgent: " : view.state === "calling" ? "Soon: " : ""}${prefix ?? "Blocks in"} ${view.text}`;
  return (
    <span data-timer={view.state} className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-caption font-semibold tabular-nums", STYLE[view.state], className)}>
      <ClockIcon size={16} aria-hidden />
      <span aria-hidden>{prefix === undefined || view.state === "closing" ? view.text : `${prefix} ${view.text}`}</span>
      <span className="sr-only">{label}</span>
    </span>
  );
}
