import { z } from "zod";
import { allowedEndpoint, type Push, type PushStore } from "../../push.js";
import { ApiError, parseBody, type UiApi } from "../server.js";

const subscribeSchema = z.object({ endpoint: z.string().max(2000), keys: z.object({ p256dh: z.string().max(200), auth: z.string().max(100) }) });
const visibilitySchema = z.object({ clientId: z.string().min(8).max(64), visible: z.boolean() });

export function registerPushRoutes(api: UiApi, d: { push: Push; subscriptions: PushStore; publicKey: () => string; now: () => number }): void {
  api.route("GET", "/push/key", () => ({ key: d.publicKey() }));

  api.route("POST", "/push/subscribe", (req) => {
    const sub = parseBody(subscribeSchema, req.body);
    if (!allowedEndpoint(sub.endpoint)) throw new ApiError(400, "that push address is not one of the known push services");
    d.subscriptions.add(sub, d.now());
    return { ok: true };
  });

  api.route("DELETE", "/push/subscribe", (req) => {
    const endpoint = req.query.get("endpoint");
    if (!endpoint) throw new ApiError(400, "say which subscription");
    d.subscriptions.remove(endpoint);
    return { ok: true };
  });

  // The page reports whether it is visible, a few times a minute: a tab left open at home does not count as someone looking.
  api.route("POST", "/push/visibility", (req) => {
    const { clientId, visible } = parseBody(visibilitySchema, req.body);
    d.push.report(clientId, visible);
    return { ok: true };
  });

  api.route("POST", "/push/test", async () => ({ sent: await d.push.notify({ title: "Clots", body: "Notifications are on.", url: "/waiting", tag: "test" }) }));

  api.route("GET", "/push/status", () => ({ subscriptions: d.subscriptions.all().length }));
}
