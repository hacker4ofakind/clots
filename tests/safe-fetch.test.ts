import http from "node:http";
import type net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { BlockedError, isPrivateAddress, safeFetch } from "../src/net/safe-fetch.js";

describe("isPrivateAddress", () => {
  it("blocks this machine, the local network, link-local, carrier and multicast ranges, in both families", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "198.18.0.1", "224.0.0.1", "255.255.255.255", "::1", "::", "fc00::1", "fd12::1", "fe80::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "::ffff:7f00:1", "64:ff9b::a00:1"]) expect(isPrivateAddress(ip), ip).toBe(true);
  });
  it("lets public addresses through", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "172.15.255.255", "100.63.255.255", "93.184.216.34", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) expect(isPrivateAddress(ip), ip).toBe(false);
  });
  it("blocks what is not an address at all", () => {
    expect(isPrivateAddress("not-an-ip")).toBe(true);
  });
});

let server: http.Server | undefined;
afterEach(() => void server?.close());

describe("safeFetch", () => {
  it("refuses a URL with another scheme, credentials, another port, or a name that resolves to a private address", async () => {
    await expect(safeFetch("file:///etc/passwd")).rejects.toThrow(BlockedError);
    await expect(safeFetch("ftp://example.com/x")).rejects.toThrow(/only http/);
    await expect(safeFetch("http://user:pw@example.com/")).rejects.toThrow(/credentials/);
    await expect(safeFetch("http://example.com:8080/")).rejects.toThrow(/ports/);
    await expect(safeFetch("http://localhost/")).rejects.toThrow();
    await expect(safeFetch("http://127.0.0.1/")).rejects.toThrow(/not allowed/);
    await expect(safeFetch("http://[::1]/")).rejects.toThrow(/not allowed/);
    await expect(safeFetch("http://metadata.test/", { lookup: async () => ["169.254.169.254"] })).rejects.toThrow(/not allowed/);
    await expect(safeFetch("http://mixed.test/", { lookup: async () => ["8.8.8.8", "10.0.0.5"] })).rejects.toThrow(/not allowed/);
  });

  it("checks every redirect again, so a public page cannot send it inside", async () => {
    server = http.createServer((_req, res) => res.writeHead(302, { location: "http://127.0.0.1/secret" }).end());
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    const port = (server.address() as net.AddressInfo).port;
    // The public name resolves to the test server's loopback address, which is refused at the first step already.
    await expect(safeFetch(`http://public.test:${port}/`, { lookup: async () => ["127.0.0.1"] })).rejects.toThrow();
  });
});
