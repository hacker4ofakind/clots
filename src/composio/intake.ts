import crypto from "node:crypto";
import type { ComposioAccount } from "../config.js";
import type { ClotEvent } from "../events/types.js";
import { jsonBody, storeEvent, type Answer, type Handler } from "../intake.js";
import type { Composio } from "./component.js";
import type { Meter } from "./meter.js";
import { userOf } from "./toolkits/index.js";

/** A delivery whose timestamp is further than this from the daemon's clock is refused as a replay. */
export const REPLAY_WINDOW_SECONDS = 300;
/** An event about an object one of the Clots' own writes touched this recently is the Clots' own doing. */
export const OWN_WRITE_WINDOW_MS = 10 * 60_000;

/**
 * What a mapper makes of one trigger delivery: the common event, the actor's ID at the service (""
 * when it names none), and the service's IDs of the objects the event is about, for telling the Clots' own
 * writes apart.
 */
export interface Mapped {
  event: ClotEvent;
  actorId: string;
  objectIds?: string[];
}
export type Mapper = (account: ComposioAccount, slug: string, data: unknown, webhookId: string, receivedAt: number) => Mapped | undefined;

export interface ComposioIntakeDeps {
  composio: Composio;
  /** The webhook subscription's secret, or undefined until one is stored. */
  secret: () => string | undefined;
  /** By toolkit; `generic` is for a toolkit with none of its own whose account names triggers. */
  mappers: Record<string, Mapper>;
  insertEvent: (event: ClotEvent) => boolean;
  now: () => number;
  meter?: Meter;
  log?: (text: string) => void;
}

/** Checks `webhook-signature`: `v1,` and the base64 HMAC-SHA256 of `<id>.<timestamp>.<raw body>`; several may be listed, separated by spaces. */
export function verifyComposio(secret: string, id: string, timestamp: string, rawBody: Buffer, header: string): boolean {
  const expected = crypto.createHmac("sha256", secret).update(`${id}.${timestamp}.`).update(rawBody).digest();
  return header
    .split(" ")
    .filter((part) => part.startsWith("v1,"))
    .some((part) => {
      const given = Buffer.from(part.slice(3), "base64");
      return given.length === expected.length && crypto.timingSafeEqual(given, expected);
    });
}

const text = (value: unknown): string => (typeof value === "string" ? value : "");

/** `/webhooks/composio`: verifies the delivery, finds its account, and turns a trigger's payload into an event. */
export function composioHandler(d: ComposioIntakeDeps): Handler {
  const log = d.log ?? console.log;
  return async (req): Promise<Answer> => {
    const secret = d.secret();
    if (secret === undefined) return { status: 503, text: "not ready" };
    const id = req.headers["webhook-id"];
    const timestamp = req.headers["webhook-timestamp"];
    const signature = req.headers["webhook-signature"];
    if (!id || !timestamp || !signature) return { status: 400, text: "missing webhook headers" };
    if (!verifyComposio(secret, id, timestamp, req.rawBody, signature)) {
      log("[composio] a delivery failed its signature check");
      return { status: 401, text: "bad signature" };
    }
    if (!/^\d+$/.test(timestamp) || Math.abs(d.now() / 1000 - Number(timestamp)) > REPLAY_WINDOW_SECONDS) return { status: 401, text: "stale delivery" };
    const body = jsonBody(req.rawBody) as Record<string, any> | undefined;
    if (typeof body !== "object" || body === null) return { status: 400, text: "body is not JSON" };

    const type = text(body.type);
    const meta: Record<string, any> = body.metadata ?? {};
    const data: Record<string, any> = typeof body.data === "object" && body.data !== null ? body.data : {};
    const connectionId = text(meta.connected_account_id) || text(data.connected_account_id);

    // Only the shape is logged, never a value: the first real lifecycle delivery shows whether the fields below are the ones sent.
    if (type !== "composio.trigger.message") log(`[composio] ${type || "a delivery with no type"} (data keys: ${Object.keys(data).join(", ") || "none"})`);

    // The lifecycle deliveries, as Composio documents them: a disabled trigger's `data.id` is the trigger instance and
    // `data.disabled_reason` says why; an expired connection's `data.id` is the connection itself.
    if (type === "composio.trigger.disabled") {
      try {
        await d.composio.triggerDisabled(text(data.id) || text(meta.trigger_id) || text(data.trigger_id), text(data.disabled_reason) || text(data.reason) || undefined);
      } catch (e) {
        log(`[composio] handling a disabled trigger failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      return { status: 200, text: "noted" };
    }
    if (type === "composio.connected_account.expired") {
      try {
        await d.composio.connectionExpired(text(data.id) || connectionId);
      } catch (e) {
        log(`[composio] handling an expired connection failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      return { status: 200, text: "noted" };
    }
    if (type !== "composio.trigger.message") return { status: 200, text: "ignored" };

    const account = d.composio.byConnection(connectionId);
    if (!account) {
      log(`[composio] a delivery for an unknown connection (${connectionId || "none"}) was discarded`);
      return { status: 200, text: "unknown account" };
    }
    await d.meter?.count("delivery", userOf(account), account.apiKey === undefined);
    const mapper = d.mappers[account.toolkit] ?? (account.triggers.length > 0 ? d.mappers.generic : undefined);
    if (!mapper) return { status: 200, text: "ignored" };
    const mapped = mapper(account, text(meta.trigger_slug), body.data, id, d.now());
    if (!mapped) return { status: 200, text: "ignored" };

    const self = mapped.actorId !== "" && mapped.actorId === d.composio.identity(account);
    const own = (mapped.objectIds ?? []).some((object) => d.composio.touchedByClot(account, object, d.now() - OWN_WRITE_WINDOW_MS));
    return storeEvent(mapped.event, d.insertEvent, self || own ? "caused by the Clot itself" : undefined);
  };
}
