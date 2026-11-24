import "server-only";
import { headers } from "next/headers";
import { checkAccess } from "@/lib/access";
import { daemonUrl, getIdentity } from "@/lib/identity";

/** Thrown when the daemon answers with an error status. */
export class DaemonError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`The daemon answered ${status}`);
  }
}

/**
 * Re-checks the owner from the request's own headers. The proxy already did, so this is defence in depth:
 * a bypass of the proxy still cannot reach the daemon.
 */
export async function assertOwner(h?: Headers): Promise<void> {
  const identity = await getIdentity();
  const access = checkAccess({ headers: h ?? (await headers()), owner: identity.owner, serveHost: identity.serveHost });
  if (!access.ok) throw new DaemonError(access.status, { error: access.reason });
}

/** Calls the daemon's UI API as the web app: with the shared secret, after the owner check. */
export async function daemon(path: string, init: RequestInit & { headers?: Headers | Record<string, string> } = {}, h?: Headers): Promise<Response> {
  await assertOwner(h);
  const merged = new Headers(init.headers);
  merged.set("x-clots-ui-secret", process.env.CLOTS_UI_SECRET ?? "");
  return fetch(`${daemonUrl()}/api/v1${path}`, { ...init, headers: merged, cache: "no-store" });
}

/** GET a JSON document from the daemon. */
export async function daemonJson<T>(path: string): Promise<T> {
  const res = await daemon(path);
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) throw new DaemonError(res.status, body);
  return body as T;
}
