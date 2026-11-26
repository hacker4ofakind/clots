"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { usePanelRef } from "react-resizable-panels";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";

/** What a pane shows: the Clot's info now, a Clapboard later. */
export interface PaneContent {
  /** Which Clot opened it; the Info button uses it to tell its own pane from another one. */
  clot: string;
  /** Names the pane for a screen reader. */
  label: string;
  /** The width it opens at, in pixels. Panes that need more room than the default give their own. */
  width?: number;
  render: () => ReactNode;
}

interface SidePaneApi {
  pane: PaneContent | undefined;
  open: (pane: PaneContent) => void;
  close: () => void;
}

const Context = createContext<SidePaneApi | undefined>(undefined);

export function useSidePane(): SidePaneApi {
  const value = useContext(Context);
  if (!value) throw new Error("useSidePane needs the SidePaneProvider");
  return value;
}

export function SidePaneProvider({ children }: { children: ReactNode }) {
  const [pane, setPane] = useState<PaneContent>();
  const open = useCallback((next: PaneContent) => setPane(next), []);
  const close = useCallback(() => setPane(undefined), []);
  return <Context.Provider value={{ pane, open, close }}>{children}</Context.Provider>;
}

/** The width a pane opens at: the design's 300px. Every opening starts here, whatever the pane was dragged to before. */
export const PANE_WIDTH = 300;
/** Letting go with the pane narrower than this share of the space beside the rail (and never under the floor) closes it. */
export const CLOSE_BELOW = 0.12;
export const CLOSE_FLOOR = 96;

/**
 * The page container and, when one is open, the side pane beside it. The pane is a column on the rail's background, not part of
 * the rounded page: its grip sits at its left edge. The two share one resizable group that stays mounted, so opening or closing a
 * pane never rebuilds the page. Dragging the grip makes the pane follow the pointer all the way: to the far left it is the
 * whole width, and letting go near the right edge closes it. There are no close or full-screen buttons.
 */
export function PaneLayout({ children }: { children: ReactNode }) {
  const { pane, close } = useSidePane();
  const panel = usePanelRef();
  const isOpen = pane !== undefined;
  const width = useRef(PANE_WIDTH);
  width.current = pane?.width ?? PANE_WIDTH;
  const [opened, setOpened] = useState(false);

  // Opening always starts at the pane's own width, never the last one dragged to; closing folds it away.
  useEffect(() => {
    panel.current?.resize(isOpen ? width.current : 0);
    setOpened(isOpen);
  }, [isOpen, panel]);

  const onLayoutChanged = useCallback(
    (_layout: unknown, meta: { isUserInteraction: boolean }) => {
      if (!meta.isUserInteraction) return;
      const size = panel.current?.getSize();
      if (!size) return;
      const space = size.asPercentage > 0 ? (size.inPixels / size.asPercentage) * 100 : 0;
      // Nothing left of it (the End key, or a drag to the right edge) is below the mark too.
      if (size.inPixels < Math.max(CLOSE_FLOOR, space * CLOSE_BELOW)) close();
    },
    [panel, close],
  );

  return (
    // The group lets the page's 1px ring show outside it (the rail's side); the page panel carries the ring and the rounded corners.
    <ResizablePanelGroup orientation="horizontal" className="min-w-0 flex-1" style={{ overflow: "visible" }} onLayoutChanged={onLayoutChanged}>
      <ResizablePanel id="page" defaultSize="100%" minSize="0%" className="h-full bg-card md:rounded-panel md:shadow-panel">
        <main data-page="container" className="h-full min-w-0 overflow-hidden">
          {children}
        </main>
      </ResizablePanel>
      <ResizableHandle id="pane-grip" aria-label="Resize the side pane" disableDoubleClick className={opened ? "max-md:hidden" : "pointer-events-none invisible after:hidden [&>span]:hidden"} />
      <ResizablePanel id="pane" panelRef={panel} defaultSize="0%" minSize="0%" groupResizeBehavior="preserve-pixel-size" className="h-full">
        {pane ? (
          <aside aria-label={pane.label} className="h-full overflow-y-auto bg-background py-5 pr-5 pl-6">
            {pane.render()}
          </aside>
        ) : null}
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}
