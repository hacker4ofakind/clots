import http from "node:http";
import { normalizeGithub, verifySignature } from "./events/github.js";
import type { ClotEvent } from "./events/types.js";

/** Larger requests are refused. Every source's payloads are far smaller. */
const MAX_REQUEST_BYTES = 5 * 1024 * 1024;

/** A request as a handler sees it. Header names are lowercase. */
export interface Incoming {
  method: string;
  headers: Record<string, string>;
  query: URLSearchParams;
  rawBody: Buffer;
}

/** What to answer, and the event that was stored before answering, if any. */
export interface Answer {
  status: number;
  text: string;
  /** Default: plain text. */
  contentType?: string;
  /** A new event, stored before the answer. */
  event?: ClotEvent;
  /** Set when the stored event goes no further, with the reason: the source already knew it was the Clots' own. */
  dropped?: string;
}

/** Answers one path. It stores what it accepts before it returns, so an event that was answered is never lost. */
export type Handler = (req: Incoming) => Answer | Promise<Answer>;

/** Stores a new event and answers for it. A repeat is acknowledged and goes no further. */
export function storeEvent(event: ClotEvent, insertEvent: (event: ClotEvent) => boolean, dropped?: string): Answer {
  if (!insertEvent(event)) return { status: 200, text: "duplicate" };
  return dropped === undefined ? { status: 202, text: "accepted", event } : { status: 202, text: "accepted", event, dropped };
}

/** A request's body as JSON, or undefined when it is not JSON. */
export function jsonBody(raw: Buffer): unknown {
  try {
    return JSON.parse(raw.toString("utf8"));
  } catch {
    return undefined;
  }
}

export interface Delivery {
  signature: string | undefined;
  eventName: string | undefined;
  deliveryId: string | undefined;
  rawBody: Buffer;
}

export interface IntakeDeps {
  secret: string;
  /** Stores a new event; false when one with that ID is already stored. */
  insertEvent: (event: ClotEvent) => boolean;
  now: () => number;
}

/**
 * Decides what to answer GitHub, and returns the event when it is new and one
 * of the kinds the Clots react to. Stores it before returning, so an event
 * that was answered is never lost.
 */
export function acceptGithub(d: Delivery, deps: IntakeDeps): Answer {
  if (!verifySignature(deps.secret, d.rawBody, d.signature)) return { status: 401, text: "bad signature" };
  if (!d.eventName || !d.deliveryId) return { status: 400, text: "missing GitHub headers" };
  const payload = jsonBody(d.rawBody);
  if (payload === undefined) return { status: 400, text: "body is not JSON" };
  const event = normalizeGithub(d.eventName, d.deliveryId, payload, deps.now());
  if (!event) return { status: 200, text: "ignored" };
  return storeEvent(event, deps.insertEvent);
}

/** GitHub's path. */
export function githubHandler(deps: IntakeDeps): Handler {
  return (req) => acceptGithub({ signature: req.headers["x-hub-signature-256"], eventName: req.headers["x-github-event"], deliveryId: req.headers["x-github-delivery"], rawBody: req.rawBody }, deps);
}

/**
 * Listens on localhost; a tunnel makes the port reachable. Each path has a handler, which
 * stores what it accepts. The source is answered first, and an answer that carries an event
 * is passed on after.
 */
export function startIntake(o: { port: number; handlerFor: (path: string) => Handler | undefined; onAnswer: (answer: Answer) => void }): http.Server {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const handler = o.handlerFor(url.pathname);
    if (!handler) {
      if (req.method === "POST") console.log(`[intake] POST ${url.pathname}: 404, no such path`);
      res.writeHead(req.method === "GET" && url.pathname === "/" ? 200 : 404).end("clots intake");
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_REQUEST_BYTES) {
        console.log(`[intake] ${req.method} ${url.pathname}: 413 too large`);
        res.writeHead(413).end("too large");
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (res.writableEnded) return;
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(req.headers)) if (value !== undefined) headers[name] = Array.isArray(value) ? value[0] : value;
      Promise.resolve()
        .then(() => handler({ method: req.method ?? "GET", headers, query: url.searchParams, rawBody: Buffer.concat(chunks) }))
        .catch((error): Answer => {
          console.error(`[intake] ${url.pathname} failed:`, error);
          return { status: 500, text: "error" };
        })
        .then((answer) => {
          res.writeHead(answer.status, { "content-type": answer.contentType ?? "text/plain; charset=utf-8" }).end(answer.text);
          if (answer.event) o.onAnswer(answer);
          // A delivery that is not stored leaves a line, so a source that seems silent can be told apart from one refused.
          else if (answer.contentType === undefined) console.log(`[intake] ${req.method} ${url.pathname}: ${answer.status} ${answer.text}`);
        });
    });
  });
  server.listen(o.port, "127.0.0.1");
  return server;
}
