// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useStream } from "@/lib/stream";

/** An EventSource the test drives by hand. */
class FakeSource {
  static all: FakeSource[] = [];
  static readonly CLOSED = 2;
  readonly CLOSED = 2;
  readyState = 0;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  listeners = new Map<string, ((e: MessageEvent<string>) => void)[]>();
  constructor(readonly url: string) {
    FakeSource.all.push(this);
  }
  addEventListener(type: string, fn: (e: MessageEvent<string>) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  close() {
    this.readyState = 2;
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  emit(type: string, data = "{}", lastEventId = "") {
    for (const fn of this.listeners.get(type) ?? []) fn(new MessageEvent(type, { data, lastEventId }));
  }
}

const mount = () => {
  const onEvent = vi.fn();
  const onOpen = vi.fn();
  const hook = renderHook(() => useStream({ onEvent, onOpen }));
  return { ...hook, onEvent, onOpen };
};
const live = () => FakeSource.all.filter((s) => s.readyState !== 2).at(-1)!;

beforeEach(() => {
  vi.useFakeTimers();
  FakeSource.all = [];
  vi.stubGlobal("EventSource", FakeSource);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("useStream", () => {
  it("is up once the stream opens, and asks for a fresh look each time", () => {
    const { result, onOpen } = mount();
    expect(result.current).toBe("connecting");
    act(() => live().open());
    expect(result.current).toBe("up");
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("goes down when the stream errors, and opens again after a wait that grows", () => {
    const { result } = mount();
    act(() => live().open());
    act(() => live().onerror?.());
    expect(result.current).toBe("down");
    expect(FakeSource.all).toHaveLength(1);
    act(() => void vi.advanceTimersByTime(1000));
    expect(FakeSource.all).toHaveLength(2);
    act(() => live().onerror?.());
    act(() => void vi.advanceTimersByTime(1000));
    expect(FakeSource.all).toHaveLength(2);
    act(() => void vi.advanceTimersByTime(1000));
    expect(FakeSource.all).toHaveLength(3);
  });

  it("goes down when the stream says nothing at all for 5 seconds (a proxy swallowed its end), and comes back when it reopens", () => {
    const { result, onOpen } = mount();
    act(() => live().open());
    act(() => void vi.advanceTimersByTime(4000));
    expect(result.current).toBe("up");
    act(() => void vi.advanceTimersByTime(1500));
    expect(result.current).toBe("down");
    act(() => void vi.advanceTimersByTime(1000));
    act(() => live().open());
    expect(result.current).toBe("up");
    expect(onOpen).toHaveBeenCalledTimes(2);
  });

  it("stays up while the app's pings or events keep coming", () => {
    const { result, onEvent } = mount();
    act(() => live().open());
    for (let i = 0; i < 6; i++) {
      act(() => void vi.advanceTimersByTime(2000));
      act(() => live().emit(i % 2 === 0 ? "ping" : "clot.state", '{"clot":"home"}', String(i)));
    }
    expect(result.current).toBe("up");
    expect(onEvent).toHaveBeenCalledTimes(3);
  });
});
