"use client";

import { usePathname } from "next/navigation";
import { Skeleton } from "@/components/ui/skeleton";
import { IconTile } from "./icon-tile";
import { PageTitle } from "./page-title";

/** What a chat shows while its first page loads: bubbles and text where they will be, with the composer's height kept. */
export function ChatSkeleton() {
  return (
    <div className="flex h-full flex-col" aria-busy="true" aria-label="Loading the chat" role="status">
      <div className="content-width chat-gutter flex flex-1 flex-col justify-end gap-4 px-4 pb-4">
        <Skeleton className="h-12 w-1/3 self-end rounded-card" />
        <div className="flex w-2/3 flex-col gap-2">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-5/6" />
          <Skeleton className="h-4 w-1/2" />
        </div>
        <Skeleton className="h-12 w-1/4 self-end rounded-card" />
        <div className="flex w-1/2 flex-col gap-2">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-2/3" />
        </div>
      </div>
      <div className="content-width chat-gutter px-3 pb-[max(env(safe-area-inset-bottom),34px)] md:pb-4">
        <Skeleton className="h-13 rounded-composer" />
      </div>
    </div>
  );
}

/** What the phone's Clots list shows while the Clots load: the title is already there, the rows are shaped like the real ones. */
export function ClotsListSkeleton() {
  return (
    <div className="h-full" aria-busy="true" aria-label="Loading the Clots" role="status">
      <div className="content-width">
        <PageTitle>Clots</PageTitle>
        <ul className="flex flex-col">
          {[0, 1, 2, 3].map((i) => (
            <li key={i} className="flex min-h-16 items-center gap-3.5 px-5 py-3">
              <IconTile size="phone">
                <Skeleton className="size-full rounded-card" />
              </IconTile>
              <span className="flex flex-1 flex-col gap-2">
                <Skeleton className="h-4 w-1/3" />
                <Skeleton className="h-3.5 w-3/5" />
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/**
 * The first paint of the app, before the Clots have come from the daemon: the screen's own skeleton, chosen by the address,
 * so a chat does not flash a list and the other way round.
 */
export function AppLoading() {
  const pathname = usePathname();
  return (
    <div className="h-dvh bg-card">
      {pathname.startsWith("/c/") ? <ChatSkeleton /> : pathname.startsWith("/clots") ? <ClotsListSkeleton /> : null}
    </div>
  );
}
