// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useUnsavedGuard } from "@/lib/use-unsaved-guard";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

function link(href: string, attrs: Record<string, string> = {}) {
  const a = document.createElement("a");
  a.href = href;
  for (const [k, v] of Object.entries(attrs)) a.setAttribute(k, v);
  document.body.append(a);
  return a;
}

const click = (el: Element, init: MouseEventInit = {}) => {
  const event = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...init });
  // Registered after the hook's own listener: reads what it decided, then stops jsdom from trying to follow the link.
  let prevented = false;
  const observe = (e: Event) => ((prevented = e.defaultPrevented), e.preventDefault());
  document.addEventListener("click", observe, true);
  act(() => void el.dispatchEvent(event));
  document.removeEventListener("click", observe, true);
  return { defaultPrevented: prevented };
};

beforeEach(() => {
  push.mockClear();
  window.history.replaceState(null, "", "/settings/general");
});
afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

describe("useUnsavedGuard", () => {
  it("lets links through while nothing is edited", () => {
    const { result } = renderHook(() => useUnsavedGuard(false));
    const event = click(link("/waiting"));
    expect(event.defaultPrevented).toBe(false);
    expect(result.current.pending).toBe(false);
  });

  it("holds a click on an in-app link while dirty, and Discard carries it out", () => {
    const { result } = renderHook(() => useUnsavedGuard(true));
    const event = click(link("/waiting?x=1#top"));
    expect(event.defaultPrevented).toBe(true);
    expect(result.current.pending).toBe(true);
    expect(push).not.toHaveBeenCalled();
    act(() => result.current.proceed());
    expect(push).toHaveBeenCalledWith("/waiting?x=1#top");
    expect(result.current.pending).toBe(false);
  });

  it("stays on the page when cancelled", () => {
    const { result } = renderHook(() => useUnsavedGuard(true));
    click(link("/waiting"));
    act(() => result.current.cancel());
    expect(result.current.pending).toBe(false);
    expect(push).not.toHaveBeenCalled();
  });

  it("leaves modified clicks, new-tab links, downloads, other origins and the same page alone", () => {
    const { result } = renderHook(() => useUnsavedGuard(true));
    for (const event of [click(link("/waiting"), { ctrlKey: true }), click(link("/waiting"), { metaKey: true }), click(link("/waiting"), { button: 1 }), click(link("/waiting", { target: "_blank" })), click(link("/f.zip", { download: "" })), click(link("https://example.com/")), click(link("/settings/general#top"))]) {
      expect(event.defaultPrevented).toBe(false);
    }
    expect(result.current.pending).toBe(false);
  });

  it("holds the Back button, and putting the page back keeps the guard", () => {
    const { result } = renderHook(() => useUnsavedGuard(true));
    const forward = vi.spyOn(window.history, "pushState");
    act(() => void window.dispatchEvent(new PopStateEvent("popstate")));
    expect(result.current.pending).toBe(true);
    act(() => result.current.cancel());
    expect(forward).toHaveBeenCalledTimes(1);
    expect(result.current.pending).toBe(false);
  });

  it("warns before the tab closes while dirty, and not after", () => {
    const { rerender } = renderHook(({ dirty }) => useUnsavedGuard(dirty), { initialProps: { dirty: true } });
    const warned = () => {
      const event = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    };
    expect(warned()).toBe(true);
    rerender({ dirty: false });
    expect(warned()).toBe(false);
  });
});
