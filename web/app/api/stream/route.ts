import { type NextRequest } from "next/server";
import { daemon } from "@/lib/daemon";
import { guard } from "@/lib/guard";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** The daemon says something (a heartbeat at least) every 20 seconds; this long without a byte and its end of the stream is taken as gone. */
const UPSTREAM_SILENCE_MS = 50_000;
/**
 * While the stream is quiet the browser is told every couple of seconds that the app itself is alive, so it can tell a dead stream from a quiet
 * one. The ping is also what lets it notice a break fast when something between the browser and this route (a proxy) swallows the end of the
 * stream: the pings stop, and the browser gives up on the silence (see SILENCE_MS in lib/stream.ts).
 */
const PING_EVERY_MS = 2_000;

const encoder = new TextEncoder();
const PING = encoder.encode("event: ping\ndata: {}\n\n");

/**
 * The daemon's event stream, passed through with the secret added. Compression is off for it and the daemon's heartbeat keeps it
 * open. The stream ends the moment the daemon's does (it stops, it dies, or it goes quiet for longer than its heartbeat allows),
 * so the browser sees the break at once and shows the banner instead of waiting on a connection that is not coming back. When the
 * browser goes away the upstream request is aborted with it.
 */
export async function GET(req: NextRequest): Promise<Response> {
  const refused = await guard(req, { mutating: false });
  if (refused) return refused;
  const last = req.headers.get("last-event-id") ?? req.nextUrl.searchParams.get("last") ?? undefined;
  const upstream = new AbortController();
  req.signal.addEventListener("abort", () => upstream.abort());
  const unreachable = () => Response.json({ error: "The Clots daemon cannot be reached.", code: "daemon-unreachable" }, { status: 502, headers: { "cache-control": "no-store" } });
  try {
    const res = await daemon("/stream", { headers: last === undefined ? {} : { "last-event-id": last }, signal: upstream.signal }, req.headers);
    if (!res.ok || !res.body) return unreachable();
    const reader = res.body.getReader();
    let timer: ReturnType<typeof setInterval> | undefined;
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        let heard = Date.now();
        // A ping may only go between two events, never into the middle of one.
        let between = true;
        timer = setInterval(() => {
          if (Date.now() - heard > UPSTREAM_SILENCE_MS) {
            upstream.abort();
            controller.error(new Error("the daemon went quiet"));
          } else if (between) controller.enqueue(PING);
        }, PING_EVERY_MS);
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            heard = Date.now();
            between = value.length >= 2 && value[value.length - 1] === 10 && value[value.length - 2] === 10;
            controller.enqueue(value);
          }
          controller.close();
        } catch (error) {
          controller.error(error);
        } finally {
          clearInterval(timer);
        }
      },
      cancel() {
        clearInterval(timer);
        upstream.abort();
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", "x-accel-buffering": "no", "content-encoding": "identity" } });
  } catch {
    return unreachable();
  }
}
