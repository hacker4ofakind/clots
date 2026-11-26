import { createHash, timingSafeEqual } from "node:crypto";
import http from "node:http";
import { z } from "zod";
import { readBody } from "../intake.js";
import { serveStream, type EventBus } from "./events.js";

export const API_BASE = "/api/v1";

/** What a handler is given. */
export interface ApiRequest {
  method: string;
  params: Record<string, string>;
  query: URLSearchParams;
  headers: Record<string, string>;
  /** The JSON body, already parsed, or undefined when there is none. */
  body: unknown;
}

/** A status other than 200 with a body. A handler that returns anything else answers 200. */
export class ApiResult {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {}
}

/** A binary answer: an image, an icon. The type is checked by the one who made it, and `nosniff` is always sent. */
export class RawResult {
  constructor(
    readonly contentType: string,
    readonly body: Buffer,
    readonly status = 200,
  ) {}
}

/** Thrown by a handler to answer an error. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export type ApiHandler = (req: ApiRequest) => Promise<unknown> | unknown;

interface Route {
  method: string;
  parts: string[];
  handler: ApiHandler;
  maxBytes: number;
}

/** Most requests are small; messages with images and icons say otherwise. */
export const DEFAULT_MAX_BYTES = 256 * 1024;

const digest = (text: string) => createHash("sha256").update(text).digest();

/** Constant-time comparison, so the secret cannot be guessed from response times. */
export function secretMatches(given: string | undefined, secret: string): boolean {
  if (given === undefined || secret === "") return false;
  return timingSafeEqual(digest(given), digest(secret));
}

/**
 * The daemon's private API for the web app: JSON over HTTP under /api/v1, plus the event stream. It
 * listens on loopback only, on a port of its own, and refuses every request without the shared secret.
 */
export class UiApi {
  private routes: Route[] = [];
  private server?: http.Server;

  constructor(
    private d: {
      /** The shared secret, read each time: it is created at first start. */
      secret: () => string;
      bus: EventBus;
      heartbeatMs?: number;
    },
  ) {}

  /** Registers a route. A path part starting with `:` is a parameter. */
  route(method: "GET" | "POST" | "PUT" | "DELETE", path: string, handler: ApiHandler, o: { maxBytes?: number } = {}): void {
    this.routes.push({ method, parts: path.split("/").filter(Boolean), handler, maxBytes: o.maxBytes ?? DEFAULT_MAX_BYTES });
  }

  private match(method: string, pathname: string): { route: Route; params: Record<string, string> } | "method" | undefined {
    const parts = pathname.split("/").filter(Boolean);
    let pathMatched = false;
    for (const route of this.routes) {
      if (route.parts.length !== parts.length) continue;
      const params: Record<string, string> = {};
      const ok = route.parts.every((part, i) => {
        if (part.startsWith(":")) {
          try {
            params[part.slice(1)] = decodeURIComponent(parts[i]!);
          } catch {
            return false;
          }
          return true;
        }
        return part === parts[i];
      });
      if (!ok) continue;
      pathMatched = true;
      if (route.method === method) return { route, params };
    }
    return pathMatched ? "method" : undefined;
  }

  /** Starts listening. Port 0 picks a free one (tests). */
  listen(port: number, host = "127.0.0.1"): Promise<http.Server> {
    const server = http.createServer((req, res) => void this.handle(req, res));
    this.server = server;
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => resolve(server));
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) return resolve();
      this.server.closeAllConnections();
      this.server.close(() => resolve());
    });
  }

  private send(res: http.ServerResponse, status: number, body: unknown): void {
    if (res.headersSent) return;
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" }).end(JSON.stringify(body ?? null));
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const secret = this.d.secret();
      const given = req.headers["x-clots-ui-secret"];
      if (!secretMatches(Array.isArray(given) ? given[0] : given, secret)) return this.send(res, 401, { error: "The Clots daemon did not accept that request." });
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname !== API_BASE && !url.pathname.startsWith(`${API_BASE}/`)) return this.send(res, 404, { error: "That could not be found." });
      const pathname = url.pathname.slice(API_BASE.length) || "/";
      const method = req.method ?? "GET";

      if (method === "GET" && pathname === "/stream") return serveStream(this.d.bus, req, res, { heartbeatMs: this.d.heartbeatMs });

      const found = this.match(method, pathname);
      if (found === undefined) return this.send(res, 404, { error: "That could not be found." });
      if (found === "method") return this.send(res, 405, { error: "That action is not available." });

      let body: unknown;
      if (method !== "GET" && method !== "DELETE") {
        const raw = await readBody(req, found.route.maxBytes, () => this.send(res, 413, { error: "That is too large to send." }));
        if (raw === undefined) return;
        if (raw.length > 0) {
          try {
            body = JSON.parse(raw.toString("utf8"));
          } catch {
            return this.send(res, 400, { error: "That request could not be read. Reload the page and try again." });
          }
        }
      }
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(req.headers)) if (value !== undefined) headers[name] = Array.isArray(value) ? value[0]! : value;
      const result = await found.route.handler({ method, params: found.params, query: url.searchParams, headers, body });
      if (result instanceof RawResult) {
        res.writeHead(result.status, { "content-type": result.contentType, "x-content-type-options": "nosniff", "cache-control": "private, max-age=3600", "content-security-policy": "default-src 'none'; sandbox" }).end(result.body);
      } else if (result instanceof ApiResult) this.send(res, result.status, result.body);
      else this.send(res, 200, result);
    } catch (error) {
      if (error instanceof ApiError) return this.send(res, error.status, { error: error.message, ...(error.details === undefined ? {} : { details: error.details }) });
      if (error instanceof z.ZodError) return this.send(res, 400, { error: "Some of that is not valid. Check it and try again.", details: z.flattenError(error) });
      console.error("[ui-api] a request failed:", error);
      this.send(res, 500, { error: "Something went wrong in the daemon. Try again in a moment." });
    }
  }
}

/** Parses a request's body with a schema; a bad body answers 400 with the field errors. */
export function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new ApiError(400, "Some of that is not valid. Check it and try again.", z.flattenError(parsed.error));
  return parsed.data;
}
