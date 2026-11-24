import { type NextRequest } from "next/server";
import { daemon } from "@/lib/daemon";
import { guard } from "@/lib/guard";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * The daemon's event stream, passed through with the secret added. Compression is off for it and the daemon's
 * heartbeat keeps it open. When the browser goes away the upstream request is aborted with it.
 */
export async function GET(req: NextRequest): Promise<Response> {
  const refused = await guard(req, { mutating: false });
  if (refused) return refused;
  const last = req.headers.get("last-event-id") ?? req.nextUrl.searchParams.get("last") ?? undefined;
  const upstream = new AbortController();
  req.signal.addEventListener("abort", () => upstream.abort());
  try {
    const res = await daemon("/stream", { headers: last === undefined ? {} : { "last-event-id": last }, signal: upstream.signal }, req.headers);
    if (!res.ok || !res.body) return Response.json({ error: "the daemon cannot be reached" }, { status: 502, headers: { "cache-control": "no-store" } });
    return new Response(res.body, { status: 200, headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", "x-accel-buffering": "no", "content-encoding": "identity" } });
  } catch {
    return Response.json({ error: "the daemon cannot be reached" }, { status: 502, headers: { "cache-control": "no-store" } });
  }
}
