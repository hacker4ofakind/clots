import { NextResponse, type NextRequest } from "next/server";
import { checkAccess } from "@/lib/access";
import { getIdentity } from "@/lib/identity";

const page = (title: string, text: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{font:16px system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#faf6f6;color:#2a2222}main{max-width:28rem;padding:1.5rem}h1{font-size:1.4rem}</style></head><body><main><h1>${title}</h1><p>${text}</p></main></body></html>`;

/** The site-wide content security policy. Scripts need the per-request nonce. */
export function contentSecurityPolicy(nonce: string, dev: boolean): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https://logos.composio.dev",
    "font-src 'self'",
    "connect-src 'self'",
    "manifest-src 'self'",
    "worker-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

export async function proxy(request: NextRequest): Promise<NextResponse> {
  const identity = await getIdentity();
  const access = checkAccess({ headers: request.headers, owner: identity.owner, serveHost: identity.serveHost });
  if (!access.ok) {
    const html = access.status === 503 ? page("Clots is not set up", "Set <code>ui.owner</code> in clots.config.json to your Tailscale login, then reload.") : page("Not allowed", "This app is private to its owner on their tailnet.");
    return new NextResponse(html, { status: access.status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" } });
  }
  const nonce = btoa(crypto.randomUUID());
  const csp = contentSecurityPolicy(nonce, process.env.NODE_ENV !== "production");
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("content-security-policy", csp);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("content-security-policy", csp);
  response.headers.set("x-content-type-options", "nosniff");
  response.headers.set("referrer-policy", "same-origin");
  return response;
}

export const config = {
  // Everything but Next's own static assets. The service worker and the manifest are checked too.
  matcher: ["/((?!_next/static|_next/image).*)"],
};
