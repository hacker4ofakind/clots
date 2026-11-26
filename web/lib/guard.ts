import "server-only";
import { assertOwner, DaemonError } from "@/lib/daemon";
import { bareHost } from "@/lib/access";
import { getIdentity } from "@/lib/identity";

const json = (status: number, error: string) => Response.json({ error }, { status, headers: { "cache-control": "no-store" } });

/**
 * The one check every route handler goes through. The owner is checked again here (the proxy did already), and a
 * request that changes something must come from this site's own pages: its Origin is the serve host, it is JSON
 * (a form or a cross-site fetch cannot send that without a preflight), and the browser did not mark it cross-site.
 * Returns the refusal, or null when the request may go on.
 */
export async function guard(req: Request, o: { mutating: boolean }): Promise<Response | null> {
  try {
    await assertOwner(req.headers);
  } catch (error) {
    if (error instanceof DaemonError) return json(error.status === 503 ? 503 : 403, "not allowed");
    throw error;
  }
  if (req.headers.get("sec-fetch-site") === "cross-site") return json(403, "cross-site request");
  if (!o.mutating) return null;
  const { serveHost } = await getIdentity();
  const origin = req.headers.get("origin");
  let originHost: string | undefined;
  try {
    originHost = origin === null ? undefined : new URL(origin).hostname.toLowerCase();
  } catch {
    originHost = undefined;
  }
  if (originHost === undefined || originHost !== serveHost?.toLowerCase() || bareHost(req.headers.get("host")) !== originHost) return json(403, "the request did not come from this site");
  const type = req.headers.get("content-type") ?? "";
  if (req.method !== "DELETE" && !type.toLowerCase().startsWith("application/json")) return json(415, "send JSON");
  return null;
}
