"use client";

import Link from "next/link";
import { CaretRightIcon } from "@phosphor-icons/react";
import type { ClotSummary } from "@clots/ui-api-schemas";
import { clotLabel, pausedLine } from "@/lib/clots";
import { cn } from "@/lib/utils";
import { useAppState } from "./app-state";
import { ClotIcon } from "./clot-icon";
import { IconTile } from "./icon-tile";

/** What a Clot's row says under its name: what waits for the user, why it is paused, or the start of its last reply. */
function subLine(clot: ClotSummary): { text: string; waiting: boolean } {
  if (clot.waiting > 0) return { text: `${clot.waiting} waiting for you`, waiting: true };
  if (clot.state === "paused") return { text: pausedLine(clot), waiting: false };
  if (clot.state === "failed") return { text: clot.reason ?? "Needs a look", waiting: false };
  if (clot.preview !== null) return { text: clot.preview, waiting: false };
  return { text: clot.state === "working" ? "Working" : "Nothing said yet", waiting: false };
}

/** The phone's first screen: every Clot with what is going on in it, and a chevron into its chat. */
export function ClotsList() {
  const { clots } = useAppState();
  return (
    <div tabIndex={0} aria-label="Clots" role="region" className="h-full overflow-y-auto pb-28 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
      <div className="content-width">
        <h1 className="px-5 pb-3 pt-[max(calc(env(safe-area-inset-top)+12px),62px)] text-title-mobile md:p-10 md:text-title">Clots</h1>
        <ul className="flex flex-col">
          {clots.map((clot) => {
            const line = subLine(clot);
            return (
              <li key={clot.name}>
                <Link href={`/c/${encodeURIComponent(clot.name)}`} className="flex min-h-16 items-center gap-3.5 px-5 py-3 active:bg-muted">
                  <IconTile size="phone">
                    <ClotIcon icon={clot.icon} home={clot.home} size={24} tile={44} />
                  </IconTile>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className="block truncate text-[17px] font-semibold">{clotLabel(clot)}</span>
                      {clot.unread > 0 ? <span className="size-2 shrink-0 rounded-full bg-primary" aria-label={`${clot.unread} unread`} /> : null}
                    </span>
                    <span className={cn("block truncate text-label font-normal text-muted-foreground", line.waiting && "font-semibold text-highlight-ink")}>{line.text}</span>
                  </span>
                  <CaretRightIcon size={20} className="shrink-0 text-muted-foreground" aria-hidden />
                </Link>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
