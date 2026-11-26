import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { expect, test } from "@playwright/test";
import { control } from "./helpers";

const WEB = Number(process.env.E2E_WEB_PORT ?? 3100);

/**
 * A proxy between the browser and the app that, like some real ones, never passes on the end of a stream that broke on the app's side:
 * the connection just goes quiet. Everything but the event stream is passed on whole.
 */
async function swallowingProxy(): Promise<{ port: number; close: () => void }> {
  const sockets = new Set<import("node:stream").Duplex>();
  const server = http.createServer((req, res) => {
    const up = http.request({ host: "127.0.0.1", port: WEB, path: req.url, method: req.method, headers: req.headers, agent: false }, (upRes) => {
      res.writeHead(upRes.statusCode ?? 502, upRes.headers);
      const stream = (req.url ?? "").startsWith("/api/stream");
      upRes.on("data", (chunk) => res.write(chunk));
      upRes.on("end", () => !stream && res.end());
      upRes.on("error", () => !stream && res.end());
      upRes.on("aborted", () => !stream && res.destroy());
    });
    up.on("error", () => res.destroy());
    res.on("close", () => up.destroy());
    req.pipe(up);
  });
  // The dev server wants its hot-reload socket; the page does not start without it.
  server.on("upgrade", (req, client, head) => {
    const up = net.connect(WEB, "127.0.0.1", () => {
      const lines = Object.entries(req.headers).map(([k, v]) => `${k}: ${v}`);
      up.write([`${req.method} ${req.url} HTTP/1.1`, ...lines, "", ""].join("\r\n"));
      up.write(head);
      client.pipe(up);
      up.pipe(client);
    });
    up.on("error", () => client.destroy());
    client.on("error", () => up.destroy());
    sockets.add(client);
  });
  server.on("connection", (s) => (sockets.add(s), s.on("close", () => sockets.delete(s))));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: (server.address() as AddressInfo).port, close: () => (sockets.forEach((s) => s.destroy()), server.close()) };
}

test("a daemon that dies shows the banner within a few seconds, even when a proxy swallows the end of the stream", async ({ page, request }) => {
  const proxy = await swallowingProxy();
  try {
    await page.goto(`http://localhost:${proxy.port}/c/home`);
    await expect(page.getByLabel("Message Home")).toBeVisible();
    await page.waitForTimeout(3000);
    const started = Date.now();
    await control(request, "/kill");
    await expect(page.getByRole("alert").filter({ hasText: "Can't reach the Clots daemon. Retrying…" })).toBeVisible({ timeout: 10_000 });
    expect(Date.now() - started).toBeLessThan(7000);
    await control(request, "/start");
    await expect(page.getByRole("alert").filter({ hasText: "Can't reach the Clots daemon" })).toHaveCount(0, { timeout: 40_000 });
  } finally {
    await control(request, "/start").catch(() => undefined);
    proxy.close();
  }
});

test("a daemon that is killed outright shows the banner at once", async ({ page, request }) => {
  await page.goto("/c/home");
  await expect(page.getByLabel("Message Home")).toBeVisible();
  await page.waitForTimeout(2000);
  const started = Date.now();
  await control(request, "/kill");
  try {
    await expect(page.getByRole("alert").filter({ hasText: "Can't reach the Clots daemon. Retrying…" })).toBeVisible({ timeout: 10_000 });
    expect(Date.now() - started).toBeLessThan(5000);
  } finally {
    await control(request, "/start");
  }
  await expect(page.getByRole("alert").filter({ hasText: "Can't reach the Clots daemon" })).toHaveCount(0, { timeout: 40_000 });
});
