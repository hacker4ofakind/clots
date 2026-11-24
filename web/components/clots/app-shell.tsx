"use client";

import type { ReactNode } from "react";
import { WarningCircleIcon } from "@phosphor-icons/react";
import { useAppState } from "./app-state";
import { PushClient } from "./notifications-row";
import { Rail } from "./rail";
import { TabBar } from "./tab-bar";
import { PaneLayout } from "./side-pane";

/** The banner the whole app shows while the daemon cannot be reached. Actions stay off until it is back. */
export function ConnectionBanner() {
  const { connection } = useAppState();
  if (connection !== "down") return null;
  return (
    <div role="alert" className="flex items-center justify-center gap-2 border-b bg-calling-soft px-4 py-2 text-body text-calling-ink">
      <WarningCircleIcon size={18} weight="bold" aria-hidden />
      Can&apos;t reach the Clots daemon. Retrying…
    </div>
  );
}

/**
 * The desktop frame: the icon rail on the background, one page container that runs the full height of the window,
 * and the side pane when one is open. On a phone the rail is gone and the page fills the screen; each page adds
 * its own tab bar.
 */
export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-dvh bg-background">
      <Rail />
      <PushClient />
      <PaneLayout>
        <div className="flex h-full min-h-0 flex-col">
          <ConnectionBanner />
          <div className="min-h-0 flex-1">{children}</div>
        </div>
      </PaneLayout>
      <TabBar />
    </div>
  );
}
