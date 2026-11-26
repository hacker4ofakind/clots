"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { BellIcon } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import { useViewport } from "@/lib/viewport";
import { useAppState } from "./app-state";
import { Mark } from "./logo";

/**
 * The phone's floating tab bar, a glass pill with two tabs: Clots and Waiting. It sits inside the safe areas, and is gone in a chat
 * and while the keyboard is open.
 */
export function TabBar() {
  const pathname = usePathname();
  const { asks } = useAppState();
  const { keyboard } = useViewport();

  if (pathname.startsWith("/c/") || keyboard) return null;
  const clotsActive = pathname.startsWith("/clots");
  const waitingActive = pathname.startsWith("/waiting");
  const tab = "flex h-13 w-19 flex-col items-center justify-center gap-0.5 rounded-2xl text-tab text-muted-foreground";
  return (
    <nav aria-label="Pages" className="fixed bottom-[max(env(safe-area-inset-bottom),24px)] left-1/2 z-30 flex -translate-x-1/2 gap-1 rounded-bar bg-popover/92 p-1.5 shadow-bar ring-1 ring-border backdrop-blur-md md:hidden">
      <Link href="/clots" aria-current={clotsActive ? "page" : undefined} className={cn(tab, clotsActive && "bg-muted text-foreground")}>
        <Mark className="size-6" title="" />
        Clots
      </Link>
      <Link href="/waiting" aria-current={waitingActive ? "page" : undefined} className={cn(tab, waitingActive && "bg-muted text-foreground")}>
        <span className="relative">
          <BellIcon size={24} weight={waitingActive ? "bold" : "regular"} aria-hidden />
          {asks.length > 0 ? <span className="absolute -right-0.5 -top-px size-2 rounded-full bg-highlight ring-2 ring-popover" aria-label="Something is waiting" /> : null}
        </span>
        Waiting
      </Link>
    </nav>
  );
}
