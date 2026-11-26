import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { checkAccess } from "@/lib/access";

const headers = (h: Record<string, string>) => new Headers(h);

describe("checkAccess", () => {
  const ok = { "tailscale-user-login": "me@example.com", host: "box.tail1234.ts.net:8443" };
  it("lets the owner in through the serve host", () => {
    expect(checkAccess({ headers: headers(ok), owner: "me@example.com", serveHost: "box.tail1234.ts.net" }).ok).toBe(true);
  });
  it("compares the login without regard to case", () => {
    expect(checkAccess({ headers: headers({ ...ok, "tailscale-user-login": "ME@Example.com" }), owner: "me@example.com", serveHost: "box.tail1234.ts.net" }).ok).toBe(true);
  });
  it("refuses another login, and no login", () => {
    expect(checkAccess({ headers: headers({ ...ok, "tailscale-user-login": "x@example.com" }), owner: "me@example.com", serveHost: "box.tail1234.ts.net" })).toMatchObject({ ok: false, status: 403 });
    expect(checkAccess({ headers: headers({ host: ok.host }), owner: "me@example.com", serveHost: "box.tail1234.ts.net" })).toMatchObject({ ok: false, status: 403 });
  });
  it("refuses a request whose Host is not the serve host", () => {
    expect(checkAccess({ headers: headers({ ...ok, host: "evil.example.com" }), owner: "me@example.com", serveHost: "box.tail1234.ts.net" })).toMatchObject({ ok: false, status: 403 });
    expect(checkAccess({ headers: headers({ ...ok, host: "127.0.0.1:3000" }), owner: "me@example.com", serveHost: "box.tail1234.ts.net" })).toMatchObject({ ok: false, status: 403 });
  });
  it("takes the development login only when the request carries none, and still checks the host", () => {
    const base = { owner: "me@example.com", serveHost: "localhost", devLogin: "me@example.com" };
    expect(checkAccess({ headers: headers({ host: "localhost:3000" }), ...base }).ok).toBe(true);
    expect(checkAccess({ headers: headers({ host: "localhost:3000", "tailscale-user-login": "x@example.com" }), ...base })).toMatchObject({ ok: false, status: 403 });
    expect(checkAccess({ headers: headers({ host: "evil.example.com" }), ...base })).toMatchObject({ ok: false, status: 403 });
    expect(checkAccess({ headers: headers({ host: "localhost:3000" }), owner: "me@example.com", serveHost: "localhost" })).toMatchObject({ ok: false, status: 403 });
  });
  it("fails closed when ui.owner is not set", () => {
    expect(checkAccess({ headers: headers(ok), owner: undefined, serveHost: "box.tail1234.ts.net" })).toMatchObject({ ok: false, status: 503 });
    expect(checkAccess({ headers: headers(ok), owner: "", serveHost: "box.tail1234.ts.net" })).toMatchObject({ ok: false, status: 503 });
  });
});

describe("proxy", () => {
  beforeEach(() => vi.resetModules());
  const load = async (identity: { owner?: string; serveHost?: string }) => {
    vi.doMock("@/lib/identity", () => ({ getIdentity: async () => identity, devLogin: () => undefined, daemonUrl: () => "http://x" }));
    return (await import("../proxy")).proxy;
  };
  const request = (h: Record<string, string>) => new NextRequest("http://127.0.0.1:3000/waiting", { headers: h });

  it("renders for the owner and sets the CSP with a nonce", async () => {
    const proxy = await load({ owner: "me@example.com", serveHost: "box.ts.net" });
    const res = await proxy(request({ "tailscale-user-login": "me@example.com", host: "box.ts.net:8443" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toMatch(/script-src 'self' 'nonce-[^']+'/);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });
  it("answers 403 for a mismatched or missing login", async () => {
    const proxy = await load({ owner: "me@example.com", serveHost: "box.ts.net" });
    expect((await proxy(request({ "tailscale-user-login": "x@example.com", host: "box.ts.net:8443" }))).status).toBe(403);
    expect((await proxy(request({ host: "127.0.0.1:3000" }))).status).toBe(403);
  });
  it("answers with a setup page naming the key when ui.owner is missing", async () => {
    const proxy = await load({ serveHost: "box.ts.net" });
    const res = await proxy(request({ "tailscale-user-login": "me@example.com", host: "box.ts.net:8443" }));
    expect(res.status).toBe(503);
    expect(await res.text()).toContain("ui.owner");
  });
});
