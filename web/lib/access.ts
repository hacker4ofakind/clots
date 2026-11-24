/** What the access check decides about one request. */
export type Access = { ok: true; login: string } | { ok: false; status: 403 | 503; reason: string };

export interface AccessInput {
  /** The request's headers. */
  headers: { get(name: string): string | null };
  /** `ui.owner` from the daemon's config, or undefined when it is not set. */
  owner: string | undefined;
  /** The host the app is served on (the machine's tailnet name), or undefined when unknown. */
  serveHost: string | undefined;
}

/** The host without its port, lower case. */
export function bareHost(host: string | null): string {
  return (host ?? "").trim().toLowerCase().replace(/:\d+$/, "");
}

/**
 * Only the owner, arriving through `tailscale serve`, gets in. `Tailscale-User-Login` is set by serve
 * for tailnet users, and a request straight to port 3000 has none. The Host must be the serve host,
 * so a request that reached the port some other way (a rebinding page, a proxy) is refused too. A
 * missing `ui.owner` fails closed.
 */
export function checkAccess(input: AccessInput): Access {
  const { owner, serveHost } = input;
  if (owner === undefined || owner.trim() === "") return { ok: false, status: 503, reason: "ui.owner is not set in clots.config.json" };
  const login = input.headers.get("tailscale-user-login");
  if (login === null || login.trim().toLowerCase() !== owner.trim().toLowerCase()) return { ok: false, status: 403, reason: "not the owner" };
  if (serveHost === undefined || bareHost(input.headers.get("host")) !== serveHost.toLowerCase()) return { ok: false, status: 403, reason: "wrong host" };
  return { ok: true, login };
}
