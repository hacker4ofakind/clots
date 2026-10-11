import http from "node:http";
import { normalizeGithub, verifySignature } from "./events/github.js";
import type { ClotEvent } from "./events/types.js";

/** Larger requests are refused. GitHub's payloads are far smaller. */
const MAX_REQUEST_BYTES = 5 * 1024 * 1024;

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
export function acceptGithub(d: Delivery, deps: IntakeDeps): { status: number; text: string; event?: ClotEvent } {
  if (!verifySignature(deps.secret, d.rawBody, d.signature)) return { status: 401, text: "bad signature" };
  if (!d.eventName || !d.deliveryId) return { status: 400, text: "missing GitHub headers" };
  let payload: unknown;
  try {
    payload = JSON.parse(d.rawBody.toString("utf8"));
  } catch {
    return { status: 400, text: "body is not JSON" };
  }
  const event = normalizeGithub(d.eventName, d.deliveryId, payload, deps.now());
  if (!event) return { status: 200, text: "ignored" };
  if (!deps.insertEvent(event)) return { status: 200, text: "duplicate" };
  return { status: 202, text: "accepted", event };
}

function header(req: http.IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Listens for GitHub's webhooks on localhost; a tunnel makes the port reachable.
 * GitHub is answered as soon as the event is stored, and onEvent is called after.
 */
export function startIntake(o: IntakeDeps & { port: number; onEvent: (event: ClotEvent) => void }): http.Server {
  const server = http.createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/webhooks/github") {
      res.writeHead(req.method === "GET" && req.url === "/" ? 200 : 404).end("clots intake");
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_REQUEST_BYTES) {
        res.writeHead(413).end("too large");
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (res.writableEnded) return;
      const answer = acceptGithub(
        { signature: header(req, "x-hub-signature-256"), eventName: header(req, "x-github-event"), deliveryId: header(req, "x-github-delivery"), rawBody: Buffer.concat(chunks) },
        o,
      );
      res.writeHead(answer.status).end(answer.text);
      if (answer.event) o.onEvent(answer.event);
    });
  });
  server.listen(o.port, "127.0.0.1");
  return server;
}
