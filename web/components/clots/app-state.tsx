"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTheme } from "next-themes";
import { toast } from "sonner";
import { uiPrefsSchema, type AnswerResponse, type AskAnswerBody, type AskSnapshot, type ClotSummary, type UiPrefs } from "@clots/ui-api-schemas";
import { api, ApiFailure } from "@/lib/api-client";
import { CONFIG_FILE_PROBLEM, readableError, readableText } from "@/lib/readable-error";
import { useStream, type StreamEvent, type StreamStatus } from "@/lib/stream";

export type AnswerOutcome = { kind: "answered"; outcome: string | null } | { kind: "closed"; outcome: string } | { kind: "busy" } | { kind: "failed"; message: string };

export interface AppStateValue {
  clots: ClotSummary[];
  asks: AskSnapshot[];
  prefs: UiPrefs;
  /** "down" while the daemon cannot be reached: the banner shows, and actions are off. */
  connection: StreamStatus;
  /** Fetches the clots, the asks and the preferences again. */
  refresh: () => Promise<void>;
  /** Calls fn for every stream event, until the returned function is called. */
  subscribe: (fn: (event: StreamEvent) => void) => () => void;
  /** Calls fn when the stream has opened again, or said to resync. */
  onResync: (fn: () => void) => () => void;
  /** The chat that is open and visible: its replies are read at once. */
  setActiveClot: (clot: string | undefined) => void;
  updatePrefs: (patch: Partial<UiPrefs>) => Promise<void>;
  /** Answers an ask. Returns how it went; never throws for an ask that had closed already. */
  answer: (id: number, answer: AskAnswerBody, key: string) => Promise<AnswerOutcome>;
}

const Context = createContext<AppStateValue | undefined>(undefined);

export function useAppState(): AppStateValue {
  const value = useContext(Context);
  if (!value) throw new Error("useAppState needs the AppStateProvider");
  return value;
}

export function AppStateProvider({ initial, children }: { initial: { clots: ClotSummary[]; asks: AskSnapshot[]; prefs: UiPrefs | undefined }; children: ReactNode }) {
  const [clots, setClots] = useState(initial.clots);
  const [asks, setAsks] = useState(initial.asks);
  // Until the daemon has said what the preferences are, the defaults stand in for them on screen but are never applied: a daemon that was
  // down at load must not turn the saved theme into "system".
  const [prefs, setPrefsValue] = useState(initial.prefs ?? uiPrefsSchema.parse({}));
  const [prefsKnown, setPrefsKnown] = useState(initial.prefs !== undefined);
  const setPrefs = useCallback((next: UiPrefs) => (setPrefsValue(next), setPrefsKnown(true)), []);
  const listeners = useRef(new Set<(event: StreamEvent) => void>());
  const resyncs = useRef(new Set<() => void>());
  const active = useRef<string | undefined>(undefined);
  /** What the stream said about asks while a fetch of the lists was on its way: the fetch's answer may be older than that. */
  const meanwhile = useRef({ running: 0, opened: new Set<number>(), closed: new Set<number>() });
  const { setTheme } = useTheme();

  // The theme and the content width are preferences kept by the daemon, so they follow the user across devices.
  useEffect(() => {
    if (!prefsKnown) return;
    setTheme(prefs.theme);
    document.documentElement.dataset.width = prefs.contentWidth;
  }, [prefsKnown, prefs.theme, prefs.contentWidth, setTheme]);

  const refresh = useCallback(async () => {
    const seen = meanwhile.current;
    seen.running += 1;
    const [nextClots, nextAsks, nextPrefs] = await Promise.all([api<ClotSummary[]>("/clots"), api<AskSnapshot[]>("/asks"), api<UiPrefs>("/settings/ui")]).catch(() => [undefined, undefined, undefined] as const);
    if (nextClots) setClots(nextClots.map((c) => (c.name === active.current ? { ...c, unread: 0 } : c)));
    // An ask the stream opened while the fetch was out stays, and one it closed stays closed, whatever the (older) answer says.
    // (Copied now: the updater below runs later, after the sets have been cleared.)
    const opened = new Set(seen.opened);
    const closed = new Set(seen.closed);
    if (nextAsks) setAsks((current) => [...nextAsks.filter((a) => !closed.has(a.id)), ...current.filter((a) => opened.has(a.id) && !nextAsks.some((n) => n.id === a.id))]);
    if (nextPrefs) setPrefs(nextPrefs);
    seen.running -= 1;
    if (seen.running === 0) {
      seen.opened.clear();
      seen.closed.clear();
    }
  }, []);

  const onEvent = useCallback((event: StreamEvent) => {
    switch (event.type) {
      case "clot.state":
        setClots((list) => list.map((c) => (c.name === event.data.clot ? { ...c, state: event.data.state, reason: event.data.reason } : c)));
        break;
      case "message.created":
      case "message.done": {
        const message = event.data.message;
        if (message?.kind === "clot") {
          setClots((list) => list.map((c) => (c.name === message.clot && active.current !== message.clot ? { ...c, unread: c.unread + 1 } : c)));
        }
        break;
      }
      case "ask.opened":
        if (meanwhile.current.running > 0) meanwhile.current.opened.add(event.data.id);
        setAsks((list) => (list.some((a) => a.id === event.data.id) ? list : [...list, event.data]));
        setClots((list) => list.map((c) => (c.name === event.data.clot ? { ...c, waiting: c.waiting + 1 } : c)));
        break;
      case "ask.updated":
        setAsks((list) => list.map((a) => (a.id === event.data.id ? event.data : a)));
        break;
      case "ask.closed":
        if (meanwhile.current.running > 0) {
          meanwhile.current.closed.add(event.data.id);
          meanwhile.current.opened.delete(event.data.id);
        }
        setAsks((list) => list.filter((a) => a.id !== event.data.id));
        setClots((list) => list.map((c) => (c.name === event.data.clot ? { ...c, waiting: Math.max(0, c.waiting - 1) } : c)));
        break;
      case "config.changed":
        if (event.data?.ui) setPrefs(event.data.ui);
        // A hand edit of the file: picked up and applied, or refused with the reason.
        if (event.data?.fromFile) {
          if (event.data.error) toast.error("clots.config.json was not picked up", { description: readableText(event.data.error, CONFIG_FILE_PROBLEM) });
          else if ((event.data.keys?.length ?? 0) + (event.data.needsRestart?.length ?? 0) > 0) toast("Picked up changes to clots.config.json", event.data.needsRestart?.length ? { description: `${event.data.needsRestart.join(", ")} takes effect after a restart.` } : undefined);
        }
        break;
      default:
        break;
    }
    for (const fn of listeners.current) fn(event);
  }, []);

  const connection = useStream({
    onEvent,
    onOpen: () => {
      void refresh();
      for (const fn of resyncs.current) fn();
    },
  });

  // The functions are made once, so a component that lists one in an effect's dependencies does not run again on every change of data.
  const subscribe = useCallback((fn: (event: StreamEvent) => void) => {
    listeners.current.add(fn);
    return () => void listeners.current.delete(fn);
  }, []);
  const onResync = useCallback((fn: () => void) => {
    resyncs.current.add(fn);
    return () => void resyncs.current.delete(fn);
  }, []);
  const setActiveClot = useCallback((clot: string | undefined) => {
    active.current = clot;
    if (clot !== undefined) setClots((list) => (list.some((c) => c.name === clot && c.unread > 0) ? list.map((c) => (c.name === clot ? { ...c, unread: 0 } : c)) : list));
  }, []);
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  const updatePrefs = useCallback(async (patch: Partial<UiPrefs>) => {
    const before = prefsRef.current;
    setPrefs({ ...before, ...patch, paneWidths: { ...before.paneWidths, ...(patch.paneWidths ?? {}) } });
    try {
      setPrefs(await api<UiPrefs>("/settings/ui", { method: "PUT", body: patch }));
    } catch {
      setPrefs(before);
    }
  }, []);
  const answer = useCallback(async (id: number, body: AskAnswerBody, key: string): Promise<AnswerOutcome> => {
    try {
      const res = await api<AnswerResponse>(`/asks/${id}/answer`, { method: "POST", body: { answer: body, key } });
      return res.outcome === "in progress" ? { kind: "busy" } : { kind: "answered", outcome: res.outcome };
    } catch (error) {
      if (error instanceof ApiFailure) {
        const outcome = (error.body as { outcome?: string } | null)?.outcome;
        if (error.status === 409 && outcome !== undefined) return { kind: "closed", outcome };
        return { kind: "failed", message: readableError(error, "That answer could not be sent. Try again.") };
      }
      return { kind: "failed", message: "That answer could not be sent. Try again." };
    }
  }, []);

  const value = useMemo<AppStateValue>(() => ({ clots, asks, prefs, connection, refresh, subscribe, onResync, setActiveClot, updatePrefs, answer }), [clots, asks, prefs, connection, refresh, subscribe, onResync, setActiveClot, updatePrefs, answer]);

  return <Context.Provider value={value}>{children}</Context.Provider>;
}
