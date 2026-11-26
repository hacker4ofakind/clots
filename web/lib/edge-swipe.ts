"use client";

import { useEffect, useEffectEvent } from "react";

/** How close to the left edge, in pixels, a swipe must start. */
export const EDGE_PX = 24;
/** How far right it must travel, and how far off straight it may drift, to count as a swipe back. */
export const MIN_TRAVEL_PX = 72;
export const MAX_DRIFT = 0.5;
export const MAX_MS = 800;

export interface Point {
  x: number;
  y: number;
  /** Milliseconds, from any clock. */
  t: number;
}

/** Whether a touch that went from `start` to `end` is a swipe back: from the left edge, rightwards, fairly straight, and quick. */
export function isBackSwipe(start: Point, end: Point): boolean {
  const dx = end.x - start.x;
  const dy = Math.abs(end.y - start.y);
  return start.x <= EDGE_PX && dx >= MIN_TRAVEL_PX && dy <= dx * MAX_DRIFT && end.t - start.t <= MAX_MS;
}

/**
 * Calls `onBack` when the user swipes right from the screen's left edge, on a phone. It listens to touch events, which a
 * scrolling page keeps delivering (pointer events are cancelled the moment the browser takes the touch to scroll). The
 * installed app on iOS has no browser back gesture of its own, which is why the chat needs this.
 */
export function useEdgeSwipeBack(onBack: () => void): void {
  const back = useEffectEvent(onBack);

  useEffect(() => {
    let start: Point | undefined;
    const onStart = (e: TouchEvent) => {
      const touch = e.touches[0];
      start = e.touches.length === 1 && touch && touch.clientX <= EDGE_PX ? { x: touch.clientX, y: touch.clientY, t: e.timeStamp } : undefined;
    };
    const onEnd = (e: TouchEvent) => {
      const touch = e.changedTouches[0];
      const from = start;
      start = undefined;
      if (!from || !touch || !window.matchMedia("(max-width: 767px)").matches) return;
      if (isBackSwipe(from, { x: touch.clientX, y: touch.clientY, t: e.timeStamp })) back();
    };
    const onCancel = () => {
      start = undefined;
    };
    document.addEventListener("touchstart", onStart, { passive: true });
    document.addEventListener("touchend", onEnd, { passive: true });
    document.addEventListener("touchcancel", onCancel, { passive: true });
    return () => {
      document.removeEventListener("touchstart", onStart);
      document.removeEventListener("touchend", onEnd);
      document.removeEventListener("touchcancel", onCancel);
    };
  }, []);
}
