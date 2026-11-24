import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";

/** Whether an address is one a fetch made for a stranger's URL must never reach: this machine, the local network, link-local, carrier, multicast. */
export function isPrivateAddress(address: string): boolean {
  const ip = address.toLowerCase();
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number) as [number, number];
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (net.isIPv6(ip)) {
    if (ip === "::" || ip === "::1") return true;
    const mapped = /^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
    if (mapped) return isPrivateAddress(mapped[1]!);
    const hex = /^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(ip);
    if (hex) return isPrivateAddress(`${parseInt(hex[1]!, 16) >> 8}.${parseInt(hex[1]!, 16) & 255}.${parseInt(hex[2]!, 16) >> 8}.${parseInt(hex[2]!, 16) & 255}`);
    const first = parseInt(ip.split(":")[0] || "0", 16);
    return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00;
  }
  return true;
}

export class BlockedError extends Error {}

export interface SafeFetchOptions {
  /** At most this many bytes of body are read; the rest is cut off. */
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
  /** Replaces DNS, for tests. */
  lookup?: (host: string) => Promise<string[]>;
  headers?: Record<string, string>;
}

export interface SafeResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
  truncated: boolean;
  /** The address that was finally fetched. */
  url: string;
}

/**
 * Fetches a URL a stranger chose, without letting it reach this machine or its network: only http and https on their usual ports, every
 * address the name resolves to checked, the connection made to the very address that was checked (so the name cannot be changed
 * between the check and the connection), and every redirect checked again. The size and the time are capped.
 */
export async function safeFetch(url: string, o: SafeFetchOptions = {}): Promise<SafeResponse> {
  const maxRedirects = o.maxRedirects ?? 5;
  let current = url;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const res = await once(current, o);
    if (res.status >= 300 && res.status < 400 && res.headers.location) {
      current = new URL(res.headers.location, current).toString();
      continue;
    }
    return res;
  }
  throw new BlockedError("too many redirects");
}

function once(raw: string, o: SafeFetchOptions): Promise<SafeResponse> {
  const maxBytes = o.maxBytes ?? 5 * 1024 * 1024;
  let target: URL;
  try {
    target = new URL(raw);
  } catch {
    return Promise.reject(new BlockedError("not a URL"));
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") return Promise.reject(new BlockedError("only http and https"));
  if (target.username !== "" || target.password !== "") return Promise.reject(new BlockedError("no credentials in a URL"));
  const port = target.port === "" ? (target.protocol === "https:" ? 443 : 80) : Number(target.port);
  if (port !== 80 && port !== 443) return Promise.reject(new BlockedError("only the usual web ports"));
  const host = target.hostname.replace(/^\[|\]$/g, "");
  // Node does not look an address up, so a literal is checked here.
  if (net.isIP(host) && isPrivateAddress(host)) return Promise.reject(new BlockedError(`${host} is an address that is not allowed`));

  const lookup = async (name: string): Promise<string[]> => {
    if (net.isIP(name)) return [name];
    if (o.lookup) return o.lookup(name);
    return (await dns.promises.lookup(name, { all: true })).map((a) => a.address);
  };

  return new Promise((resolve, reject) => {
    const client = target.protocol === "https:" ? https : http;
    const req = client.request(
      {
        host,
        port,
        path: `${target.pathname}${target.search}`,
        method: "GET",
        servername: host,
        headers: { host: target.host, "user-agent": "clots", accept: "*/*", ...o.headers },
        // The check and the connection use the same answer.
        lookup: (name, _opts, cb) => {
          lookup(name)
            .then((addresses) => {
              const bad = addresses.find(isPrivateAddress);
              if (addresses.length === 0 || bad !== undefined) return cb(new BlockedError(`${name} resolves to an address that is not allowed`) as NodeJS.ErrnoException, "", 4);
              cb(null, addresses[0]!, net.isIPv6(addresses[0]!) ? 6 : 4);
            })
            .catch((error) => cb(error as NodeJS.ErrnoException, "", 4));
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        let truncated = false;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) {
            truncated = true;
            chunks.push(chunk.subarray(0, Math.max(0, chunk.length - (size - maxBytes))));
            res.destroy();
            return;
          }
          chunks.push(chunk);
        });
        const finish = () => {
          const headers: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) headers[k] = Array.isArray(v) ? v[0]! : v;
          resolve({ status: res.statusCode ?? 0, headers, body: Buffer.concat(chunks), truncated, url: raw });
        };
        res.on("end", finish);
        res.on("close", () => {
          if (truncated) finish();
        });
      },
    );
    req.setTimeout(o.timeoutMs ?? 10_000, () => req.destroy(new BlockedError("timed out")));
    req.on("error", (error) => reject(error));
    req.end();
  });
}
