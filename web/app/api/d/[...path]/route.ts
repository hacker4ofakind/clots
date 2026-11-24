import { type NextRequest } from "next/server";
import { daemon } from "@/lib/daemon";
import { guard } from "@/lib/guard";

export const dynamic = "force-dynamic";

/** The areas of the daemon's API the browser may reach. Anything else is not forwarded. */
const AREAS = new Set(["clots", "asks", "commands", "settings", "keys", "integrations", "inboxes", "push", "turns", "uploads", "config"]);

const MAX_BODY = 26 * 1024 * 1024;

/** Passes one request to the daemon, after the checks every handler makes. The browser never calls the daemon itself. */
async function forward(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }): Promise<Response> {
  const { path } = await ctx.params;
  const mutating = req.method !== "GET" && req.method !== "HEAD";
  const refused = await guard(req, { mutating });
  if (refused) return refused;
  if (!AREAS.has(path[0] ?? "")) return Response.json({ error: "not found" }, { status: 404 });
  const length = Number(req.headers.get("content-length") ?? "0");
  if (length > MAX_BODY) return Response.json({ error: "too large" }, { status: 413 });
  const body = mutating && req.method !== "DELETE" ? await req.text() : undefined;
  if (body !== undefined && body.length > MAX_BODY) return Response.json({ error: "too large" }, { status: 413 });
  const target = `/${path.map(encodeURIComponent).join("/")}${req.nextUrl.search}`;
  try {
    const res = await daemon(target, { method: req.method, headers: body === undefined ? {} : { "content-type": "application/json" }, ...(body === undefined ? {} : { body }) }, req.headers);
    const headers = new Headers({ "cache-control": "no-store", "x-content-type-options": "nosniff" });
    const type = res.headers.get("content-type");
    if (type) headers.set("content-type", type);
    // Anything that is not JSON (an image) is shown as itself and nothing else.
    if (type && !type.startsWith("application/json")) headers.set("content-security-policy", "default-src 'none'; sandbox");
    return new Response(res.body, { status: res.status, headers });
  } catch {
    return Response.json({ error: "the daemon cannot be reached" }, { status: 502, headers: { "cache-control": "no-store" } });
  }
}

export { forward as GET, forward as POST, forward as PUT, forward as DELETE };
