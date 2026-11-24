import { randomBytes } from "node:crypto";
import type http from "node:http";
import type { UiEventType } from "@clots/ui-api-schemas";

export type { UiEventType };

export interface UiEvent {
  /** `<bootId>-<seq>`. */
  id: string;
  type: UiEventType;
  data: unknown;
}

/** How many events are kept for a client that reconnects. */
export const RING_SIZE = 1000;

/**
 * Every change the UI shows is an event with an increasing id. The last 1,000 are kept; a client that
 * reconnects with `Last-Event-ID` gets what it missed, or a `resync` telling it to refetch. Ids carry the
 * boot's id, so an id from before a restart is never taken for one of this run.
 */
export class EventBus {
  readonly bootId: string;
  private seq = 0;
  private ring: UiEvent[] = [];
  private listeners = new Set<(event: UiEvent) => void>();

  constructor(
    bootId: string = randomBytes(4).toString("hex"),
    private size = RING_SIZE,
  ) {
    this.bootId = bootId;
  }

  emit(type: UiEventType, data: unknown): UiEvent {
    this.seq += 1;
    const event: UiEvent = { id: `${this.bootId}-${this.seq}`, type, data };
    this.ring.push(event);
    if (this.ring.length > this.size) this.ring.shift();
    for (const fn of [...this.listeners]) fn(event);
    return event;
  }

  /** Calls fn for every event from now on. Returns what stops it. */
  subscribe(fn: (event: UiEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** The id of the newest event, or of the boot's start when there is none. */
  get head(): string {
    return `${this.bootId}-${this.seq}`;
  }

  /** How many streams are connected. */
  get clients(): number {
    return this.listeners.size;
  }

  /** What a client with this last id missed, in order; "resync" when that cannot be told. No id: nothing is missed. */
  since(lastEventId: string | undefined): UiEvent[] | "resync" {
    if (lastEventId === undefined || lastEventId === "") return [];
    const match = /^(.+)-(\d+)$/.exec(lastEventId);
    if (!match || match[1] !== this.bootId) return "resync";
    const last = Number(match[2]);
    if (last > this.seq) return "resync";
    if (last === this.seq) return [];
    const oldest = this.ring.length === 0 ? this.seq + 1 : Number(/-(\d+)$/.exec(this.ring[0]!.id)![1]);
    // The next event the client needs has fallen out of the ring.
    if (last + 1 < oldest) return "resync";
    return this.ring.filter((e) => Number(/-(\d+)$/.exec(e.id)![1]) > last);
  }
}

/** One event as a Server-Sent Events frame. */
export function sseFrame(event: UiEvent): string {
  return `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event.data ?? null)}\n\n`;
}

/** Heartbeat comments keep `tailscale serve` and proxies from closing an idle stream. */
export const HEARTBEAT_MS = 20_000;

/**
 * Serves the stream on a response: replays what the client missed (or says resync), then follows the bus
 * until the client goes away. `onClose` is told when it does.
 */
export function serveStream(bus: EventBus, req: http.IncomingMessage, res: http.ServerResponse, o: { heartbeatMs?: number; onClose?: () => void } = {}): void {
  res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" });
  res.write(`retry: 2000\n\n`);
  const lastId = req.headers["last-event-id"];
  const missed = bus.since(Array.isArray(lastId) ? lastId[0] : lastId);
  if (missed === "resync") res.write(sseFrame({ id: bus.head, type: "resync", data: { bootId: bus.bootId } }));
  else for (const event of missed) res.write(sseFrame(event));
  const stop = bus.subscribe((event) => res.write(sseFrame(event)));
  const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), o.heartbeatMs ?? HEARTBEAT_MS);
  const close = () => {
    clearInterval(heartbeat);
    stop();
    o.onClose?.();
  };
  res.on("close", close);
}
