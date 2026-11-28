import type net from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventBus } from "../../src/ui-api/events.js";
import { registerClotAdminRoutes } from "../../src/ui-api/routes/clots-admin.js";
import { UiApi } from "../../src/ui-api/server.js";

let api: UiApi;
let call: (path: string, secret?: string) => Promise<Response>;

beforeEach(async () => {
  api = new UiApi({ secret: () => "s", bus: new EventBus("b") });
  registerClotAdminRoutes(api, { creator: {} as never, icons: {} as never, config: {} as never, webhookSecret: () => "whsec_123", onboarding: () => [{ id: "webhook", done: false, detail: "Waiting." }], resetWebhook: () => {} });
  const server = await api.listen(0);
  const port = (server.address() as net.AddressInfo).port;
  call = (path, secret = "s") => fetch(`http://127.0.0.1:${port}/api/v1${path}`, { headers: { "x-clots-ui-secret": secret } });
});

afterEach(() => api.close());

describe("the checklist's webhook secret", () => {
  it("is given on request, only with the UI secret, and is in no other answer", async () => {
    expect(await (await call("/clots/Truecast/webhook-secret")).json()).toEqual({ secret: "whsec_123" });
    expect((await call("/clots/Truecast/webhook-secret", "wrong")).status).toBe(401);
    expect(JSON.stringify(await (await call("/clots/Truecast/onboarding")).json())).not.toContain("whsec_123");
  });
});
