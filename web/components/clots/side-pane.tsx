"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { useAppState } from "./app-state";

/** What a pane shows: the Clot's info now, a Clapboard later. */
export interface PaneContent {
  /** Which Clot's width it keeps. */
  clot: string;
  /** Names the pane for a screen reader. */
  label: string;
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

/** The pane's width as a share of the space beside the rail. Below the low mark it closes; above the high one it fills the space. */
export const PANE_MIN = 0.14;
export const PANE_MAX = 0.94;
export const PANE_DEFAULT = 0.25;
const STEP = 0.03;

/**
 * The page container and, when one is open, the side pane beside it. The pane is a column on the rail's background, not
 * part of the rounded page: its grip sits in the gap. Dragging the grip resizes it; dragging to the far left makes it
 * the whole width, to the right edge closes it. There are no close or full-screen buttons.
 */
export function PaneLayout({ children }: { children: ReactNode }) {
  const { pane, close } = useSidePane();
  const { prefs, updatePrefs } = useAppState();
  const area = useRef<HTMLDivElement>(null);
  const saved = pane ? (prefs.paneWidths[pane.clot] ?? PANE_DEFAULT) : PANE_DEFAULT;
  const [fraction, setFraction] = useState(saved);
  const [dragging, setDragging] = useState(false);
  const latest = useRef(fraction);

  useEffect(() => {
    setFraction(saved);
    latest.current = saved;
  }, [saved, pane?.clot]);

  const commit = useCallback(
    (next: number) => {
      if (!pane) return;
      if (next < PANE_MIN) {
        close();
        return;
      }
      const clamped = Math.min(1, Math.max(PANE_MIN, next));
      void updatePrefs({ paneWidths: { [pane.clot]: clamped } });
    },
    [pane, close, updatePrefs],
  );

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragging || !area.current) return;
    const rect = area.current.getBoundingClientRect();
    const next = (rect.right - e.clientX) / rect.width;
    // The far left makes the pane the whole width.
    const value = next > PANE_MAX ? 1 : Math.max(0, next);
    latest.current = value;
    setFraction(value);
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    e.currentTarget.releasePointerCapture(e.pointerId);
    setDragging(false);
    commit(latest.current);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const change = (delta: number) => {
      e.preventDefault();
      const next = Math.min(1, latest.current + delta);
      latest.current = next;
      setFraction(next);
      commit(next);
    };
    if (e.key === "ArrowLeft") change(STEP);
    else if (e.key === "ArrowRight") change(-STEP);
    else if (e.key === "Home") change(1);
    else if (e.key === "End" || e.key === "Escape") {
      e.preventDefault();
      close();
    }
  };

  const full = pane !== undefined && fraction >= PANE_MAX;
  const width = pane ? `${Math.round(Math.min(1, fraction) * 100)}%` : "0%";

  return (
    <div ref={area} className="relative flex min-w-0 flex-1 gap-0 py-0">
      <main data-page="container" className={cn("min-w-0 flex-1 overflow-hidden bg-card md:rounded-panel md:border", full && "hidden")}>
        {children}
      </main>
      {pane ? (
        <>
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize the side pane"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(fraction * 100)}
            tabIndex={0}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onKeyDown={onKeyDown}
            className="group relative z-10 w-3 shrink-0 cursor-col-resize touch-none outline-none"
          >
            <span className={cn("absolute inset-y-1/2 left-1/2 h-12 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-input transition-colors group-hover:bg-muted-foreground group-focus-visible:bg-brand", dragging && "bg-brand")} />
          </div>
          <aside aria-label={pane.label} style={full ? undefined : { width }} className={cn("min-w-0 overflow-y-auto bg-background py-5 pr-5 pl-6", full ? "flex-1" : "shrink-0")}>
            {pane.render()}
          </aside>
        </>
      ) : null}
    </div>
  );
}
