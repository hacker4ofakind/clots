"use client";

import { useSyncExternalStore } from "react";

/** The visible part of the page. While the on-screen keyboard is open it is the area above the keyboard. */
export interface ViewportState {
  keyboard: boolean;
  /** Height of the visible area, in pixels; meaningful only while `keyboard` is true. */
  height: number;
  /** How far the visible area has scrolled from the top of the layout viewport (iOS scrolls the page to show the input). */
  top: number;
}

/** A visual viewport this much shorter than the window is a keyboard, not a zoom or a collapsing address bar. */
const KEYBOARD_MIN_PX = 150;

const CLOSED: ViewportState = { keyboard: false, height: 0, top: 0 };

/**
 * The viewport's state given the tallest the window has been without a keyboard and the visual viewport now. Only a touch device
 * has a keyboard that covers the page. (Android with the keyboard resizing the page shrinks the window too, which is why the
 * reference is the tallest height seen, not the window's current one.)
 */
export function viewportState(fullHeight: number, visual: { height: number; offsetTop: number }, touch: boolean): ViewportState {
  if (!touch || fullHeight - visual.height < KEYBOARD_MIN_PX) return CLOSED;
  return { keyboard: true, height: Math.round(visual.height), top: Math.round(visual.offsetTop) };
}

let current = CLOSED;
let full = { width: 0, height: 0 };
const listeners = new Set<() => void>();

const same = (a: ViewportState, b: ViewportState) => a.keyboard === b.keyboard && a.height === b.height && a.top === b.top;

function update() {
  const vv = window.visualViewport;
  // A turn of the phone starts the reference over.
  if (full.width !== window.innerWidth) full = { width: window.innerWidth, height: 0 };
  if (!current.keyboard) full.height = Math.max(full.height, window.innerHeight);
  const next = vv ? viewportState(full.height, vv, window.matchMedia("(pointer: coarse)").matches) : CLOSED;
  if (same(current, next)) return;
  current = next;
  for (const fn of listeners) fn();
}

function subscribe(fn: () => void): () => void {
  if (listeners.size === 0) {
    window.visualViewport?.addEventListener("resize", update);
    window.visualViewport?.addEventListener("scroll", update);
    window.addEventListener("orientationchange", update);
    update();
  }
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
    if (listeners.size === 0) {
      window.visualViewport?.removeEventListener("resize", update);
      window.visualViewport?.removeEventListener("scroll", update);
      window.removeEventListener("orientationchange", update);
    }
  };
}

/** Whether the keyboard is open and the area it leaves. The shell fits itself to that area, so the composer stays above the keyboard. */
export function useViewport(): ViewportState {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => CLOSED,
  );
}
