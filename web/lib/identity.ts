import "server-only";

export interface Identity {
  owner: string | undefined;
  serveHost: string | undefined;
}

const TTL_MS = 60_000;
let cached: { at: number; value: Identity } | undefined;

/** Where the daemon's UI API listens. */
export const daemonUrl = (): string => process.env.CLOTS_DAEMON_URL ?? "http://127.0.0.1:8788";

/**
 * The owner and serve host, read from the daemon and kept for 60 seconds. A test-only override from the
 * environment is ignored in production. When the daemon cannot be reached the owner is unknown, which
 * fails closed.
 */
export async function getIdentity(now: () => number = Date.now): Promise<Identity> {
  if (process.env.NODE_ENV !== "production" && process.env.CLOTS_UI_DEV_OWNER !== undefined) {
    return { owner: process.env.CLOTS_UI_DEV_OWNER, serveHost: process.env.CLOTS_UI_DEV_HOST };
  }
  if (cached && now() - cached.at < TTL_MS) return cached.value;
  try {
    const res = await fetch(`${daemonUrl()}/api/v1/identity`, { headers: { "x-clots-ui-secret": process.env.CLOTS_UI_SECRET ?? "" }, cache: "no-store", signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as Identity;
    cached = { at: now(), value: { owner: body.owner, serveHost: body.serveHost } };
    return cached.value;
  } catch {
    // Stale beats unknown for a short while, but never for long.
    if (cached && now() - cached.at < 5 * TTL_MS) return cached.value;
    return { owner: undefined, serveHost: undefined };
  }
}

/** Forgets the cached identity. For tests. */
export function resetIdentity(): void {
  cached = undefined;
}
