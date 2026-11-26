import { NextResponse, type NextRequest } from "next/server";
import { checkAccess } from "@/lib/access";
import { devLogin, getIdentity } from "@/lib/identity";
import { accessDeniedHtml, notSetUpHtml } from "@/lib/status-document";

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
  const access = checkAccess({ headers: request.headers, owner: identity.owner, serveHost: identity.serveHost, devLogin: devLogin() });
  if (!access.ok) {
    const html = access.status === 503 ? notSetUpHtml() : accessDeniedHtml();
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
