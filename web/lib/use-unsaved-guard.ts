"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

type Leaving = { href: string } | { back: true };

const MARKER = "clotsUnsavedGuard";

/** The in-app link a click was on, when following it would leave this page. Modified clicks, new-tab links, downloads and other origins are the browser's to handle. */
export function leavingHref(e: MouseEvent, here: URL): string | undefined {
  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return undefined;
  const anchor = e.target instanceof Element ? e.target.closest("a[href]") : null;
  if (!(anchor instanceof HTMLAnchorElement) || anchor.hasAttribute("download")) return undefined;
  if (anchor.target !== "" && anchor.target !== "_self") return undefined;
  const to = new URL(anchor.href, here);
  if (to.origin !== here.origin || (to.protocol !== "http:" && to.protocol !== "https:")) return undefined;
  if (to.pathname === here.pathname && to.search === here.search) return undefined;
  return to.pathname + to.search + to.hash;
}

/**
 * Leaving a page that holds unsaved edits asks first. While `dirty`, a click on an in-app link and the browser's back button are held
 * and `pending` turns true; `proceed` then carries the navigation out and `cancel` stays on the page. Closing or reloading the tab gets
 * the browser's own warning. Show `pending` in a ConfirmDialog.
 */
export function useUnsavedGuard(dirty: boolean) {
  const router = useRouter();
  const [leaving, setLeaving] = useState<Leaving>();
  const released = useRef(false);
  // The dialog calls both Confirm and its close handler in one click: the second must see that the first took the target.
  const held = useRef<Leaving | undefined>(undefined);
  const hold = useCallback((next: Leaving | undefined) => {
    held.current = next;
    setLeaving(next);
  }, []);

  useEffect(() => {
    if (!dirty) return;
    released.current = false;
    // One extra history entry for the same page, so Back lands on this page again and can be held.
    window.history.pushState({ ...(window.history.state as object | null), [MARKER]: true }, "", window.location.href);
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    const onClick = (e: MouseEvent) => {
      if (released.current) return;
      const href = leavingHref(e, new URL(window.location.href));
      if (href === undefined) return;
      e.preventDefault();
      e.stopPropagation();
      hold({ href });
    };
    const onPopState = (e: PopStateEvent) => {
      if (released.current) return;
      // Next's own listener would carry the page away; this runs first.
      e.stopImmediatePropagation();
      hold({ back: true });
    };
    window.addEventListener("beforeunload", warn);
    document.addEventListener("click", onClick, true);
    window.addEventListener("popstate", onPopState, true);
    return () => {
      window.removeEventListener("beforeunload", warn);
      document.removeEventListener("click", onClick, true);
      window.removeEventListener("popstate", onPopState, true);
      // Saved while still here: take the extra entry back out, unless the page is being left.
      if (!released.current && (window.history.state as Record<string, unknown> | null)?.[MARKER]) window.history.back();
    };
  }, [dirty, hold]);

  const proceed = useCallback(() => {
    const target = held.current;
    if (!target) return;
    hold(undefined);
    released.current = true;
    if ("href" in target) router.push(target.href);
    else window.history.back();
  }, [router, hold]);

  const cancel = useCallback(() => {
    const target = held.current;
    if (!target) return;
    hold(undefined);
    if ("back" in target) window.history.pushState({ ...(window.history.state as object | null), [MARKER]: true }, "", window.location.href);
  }, [hold]);

  return { pending: leaving !== undefined, proceed, cancel };
}
