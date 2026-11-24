import fs from "node:fs";
import type net from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventBus } from "../../src/ui-api/events.js";
import { registerIntegrationRoutes } from "../../src/ui-api/routes/integrations.js";
import { UiApi } from "../../src/ui-api/server.js";
import { makeJobs, posthogScript, settle, slackScript } from "../helpers/integrations.js";

let api: UiApi;
let h: ReturnType<typeof makeJobs>;
let call: (method: string, path: string, body?: unknown) => Promise<{ status: number; body: any }>;
let statuses: Record<string, "active" | "waiting" | "failed" | "unknown">;
let restart: Set<string>;

beforeEach(async () => {
  h = makeJobs();
  statuses = {};
  restart = new Set();
  api = new UiApi({ secret: () => "s", bus: new EventBus("b") });
  registerIntegrationRoutes(api, { config: h.config, jobs: h.jobs, statusOf: (id) => statuses[id] ?? "unknown", restartNeeded: (id) => restart.has(id) });
  const server = await api.listen(0);
  const port = (server.address() as net.AddressInfo).port;
  call = async (method, path, body) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1${path}`, { method, headers: { "x-clots-ui-secret": "s", "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
});
afterEach(() => api.close());

const OPTIONS = { audience: "private", selfIsUser: false, events: true };

describe("connecting a toolkit over the API", () => {
  it("lists toolkits, filtered, and answers 503 naming the key when there is no Composio", async () => {
    h.api.toolkitList = [
      { slug: "slack", name: "Slack", auth: "oauth", logo: "https://logo.example/slack.png" },
      { slug: "reddit", name: "Reddit", auth: "oauth" },
    ];
    expect((await call("GET", "/integrations/toolkits")).body.toolkits).toHaveLength(2);
    expect((await call("GET", "/integrations/toolkits?q=SLA")).body).toEqual({ toolkits: [{ slug: "slack", name: "Slack", auth: "oauth", logo: "https://logo.example/slack.png" }] });

    const bare = new UiApi({ secret: () => "s", bus: new EventBus("b") });
    registerIntegrationRoutes(bare, { config: h.config });
    const server = await bare.listen(0);
    const res = await fetch(`http://127.0.0.1:${(server.address() as net.AddressInfo).port}/api/v1/integrations/toolkits`, { headers: { "x-clots-ui-secret": "s" } });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toContain("COMPOSIO_API_KEY");
    await bare.close();
  });

  it("configure answers 201 with a job id; the job reaches the link, and abandon removes it", async () => {
    h.state.script = slackScript;
    const created = await call("POST", "/integrations/configure", { toolkit: "slack", ...OPTIONS });
    expect(created.status).toBe(201);
    await settle();
    const job = await call("GET", `/integrations/jobs/${created.body.jobId}`);
    expect(job.body).toMatchObject({ jobId: created.body.jobId, toolkit: "slack", name: "Slack", clot: null, state: "oauth" });
    expect(job.body.oauthReadyAt).toBe(h.clock.now + 5000);
    expect((await call("POST", `/integrations/jobs/${created.body.jobId}/abandon`)).body).toEqual({ ok: true });
    expect((await call("GET", `/integrations/jobs/${created.body.jobId}`)).status).toBe(404);
    expect(h.api.connections.size).toBe(0);
  });

  it("refuses a bad body, an unknown toolkit and a job that is not there", async () => {
    expect((await call("POST", "/integrations/configure", { toolkit: "Slack!", ...OPTIONS })).status).toBe(400);
    expect((await call("POST", "/integrations/configure", { toolkit: "slack", audience: "everyone", selfIsUser: false, events: true })).status).toBe(400);
    h.api.failNext.set("toolkitInfo", new Error("no such toolkit"));
    expect((await call("POST", "/integrations/configure", { toolkit: "nothing", ...OPTIONS })).status).toBe(404);
    expect((await call("POST", "/integrations/configure", { toolkit: "slack", ...OPTIONS, jobId: "gone" })).status).toBe(404);
    expect((await call("PUT", "/integrations/jobs/gone/key", { value: "x" })).status).toBe(404);
  });

  it("takes the key at PUT /integrations/jobs/:jobId/key and the value is in no answer", async () => {
    h.state.script = posthogScript;
    const created = await call("POST", "/integrations/configure", { toolkit: "posthog", ...OPTIONS });
    await settle();
    expect((await call("GET", `/integrations/jobs/${created.body.jobId}`)).body).toMatchObject({ state: "key", keyName: "POSTHOG_SHARED_KEY" });
    expect((await call("PUT", `/integrations/jobs/${created.body.jobId}/key`, { value: "" })).status).toBe(400);
    const put = await call("PUT", `/integrations/jobs/${created.body.jobId}/key`, { value: "phx_SECRET_VALUE" });
    expect(put).toEqual({ status: 200, body: { ok: true } });
    const after = await call("GET", `/integrations/jobs/${created.body.jobId}`);
    expect(after.body.state).toBe("active");
    expect(JSON.stringify(after.body)).not.toContain("phx_SECRET_VALUE");
    expect(fs.readFileSync(h.envFile, "utf8")).toContain("POSTHOG_SHARED_KEY=phx_SECRET_VALUE");
    // The key does not answer twice.
    expect((await call("PUT", `/integrations/jobs/${created.body.jobId}/key`, { value: "again" })).status).toBe(409);
  });

  it("reconnect answers a job id", async () => {
    h.state.script = slackScript;
    await call("POST", "/integrations/configure", { toolkit: "slack", ...OPTIONS });
    await settle();
    [...h.api.connections.values()][0]!.status = "active";
    await h.jobs.tick();
    const res = await call("POST", `/integrations/tools/${encodeURIComponent("slack:shared")}/reconnect`);
    expect(res.status).toBe(200);
    await settle();
    expect((await call("GET", `/integrations/jobs/${res.body.jobId}`)).body.state).toBe("oauth");
    expect((await call("POST", `/integrations/tools/${encodeURIComponent("slack:nope")}/reconnect`)).status).toBe(404);
  });
});

describe("GET /integrations", () => {
  it("lists each tool with the status the daemon last read of its connection, and whether it needs a restart", async () => {
    h.state.script = slackScript;
    await call("POST", "/integrations/configure", { toolkit: "slack", ...OPTIONS, clot: "graphite" });
    await settle();
    [...h.api.connections.values()][0]!.status = "active";
    await h.jobs.tick();
    h.api.toolkitList = [{ slug: "slack", name: "Slack", auth: "oauth", logo: "https://logo.example/slack.png" }];
    await h.jobs.toolkits();

    const first = (await call("GET", "/integrations")).body;
    expect(first.tools).toEqual([{ id: "slack:graphite", toolkit: "slack", account: "graphite", clot: "graphite", shared: false, audience: "private", logo: "https://logo.example/slack.png", status: "unknown" }]);
    statuses["slack:graphite"] = "waiting";
    expect((await call("GET", "/integrations")).body.tools[0].status).toBe("waiting");
    statuses["slack:graphite"] = "failed";
    restart.add("slack:graphite");
    expect((await call("GET", "/integrations")).body.tools[0]).toMatchObject({ status: "failed", restartNeeded: true });
  });

  it("removes a tool and its key, and says whether a restart is needed", async () => {
    h.state.script = posthogScript;
    const created = await call("POST", "/integrations/configure", { toolkit: "posthog", ...OPTIONS });
    await settle();
    await call("PUT", `/integrations/jobs/${created.body.jobId}/key`, { value: "phx_value" });
    expect((await call("GET", "/integrations")).body.tools).toHaveLength(1);
    expect((await call("DELETE", `/integrations/tools/${encodeURIComponent("posthog:shared")}`)).body).toEqual({ ok: true, needsRestart: true });
    expect((await call("GET", "/integrations")).body.tools).toHaveLength(0);
    expect(fs.readFileSync(h.envFile, "utf8")).not.toContain("POSTHOG_SHARED_KEY");
    expect((await call("DELETE", `/integrations/tools/${encodeURIComponent("posthog:shared")}`)).status).toBe(404);
  });
});

describe("inboxes", () => {
  const body = { address: "me@gmail.com", password: "app-password", mailboxes: ["INBOX"] };

  it("adds one with its password in .env, and answers whether a restart is needed", async () => {
    const res = await call("POST", "/inboxes", body);
    expect(res).toEqual({ status: 201, body: { account: "me", provider: "Gmail", needsRestart: true } });
    expect(fs.readFileSync(h.envFile, "utf8")).toContain("EMAIL_ME_PASSWORD=app-password");
    expect((await call("POST", "/inboxes", body)).status).toBe(409);
    expect((await call("POST", "/inboxes", { address: "x@gmail.com", mailboxes: ["INBOX"] })).status).toBe(400);
  });

  it("edits one in place: the password stays when it is left out, and changes when it is given", async () => {
    await call("POST", "/inboxes", body);
    const edited = await call("PUT", "/inboxes/me", { address: "me@example.com", mailboxes: ["INBOX", "Sent"], imap: { host: "imap.example.com", port: 993 }, smtp: { host: "smtp.example.com", port: 465 }, clot: "graphite" });
    expect(edited).toMatchObject({ status: 200, body: { account: "me", provider: "Email" } });
    const entry = (h.config.json().sources as { email: Record<string, unknown>[] }).email;
    expect(entry).toHaveLength(1);
    expect(entry[0]).toMatchObject({ account: "me", address: "me@example.com", clot: "graphite", password: "EMAIL_ME_PASSWORD", mailboxes: ["INBOX", "Sent"] });
    expect(entry[0]).not.toHaveProperty("shared");
    expect(fs.readFileSync(h.envFile, "utf8")).toContain("EMAIL_ME_PASSWORD=app-password");

    await call("PUT", "/inboxes/me", { address: "me@example.com", mailboxes: ["INBOX"], password: "new-password", imap: { host: "imap.example.com", port: 993 }, smtp: { host: "smtp.example.com", port: 465 } });
    expect(fs.readFileSync(h.envFile, "utf8")).toContain("EMAIL_ME_PASSWORD=new-password");
    expect((await call("PUT", "/inboxes/ghost", { address: "g@gmail.com", mailboxes: ["INBOX"] })).status).toBe(404);
    expect((await call("PUT", "/inboxes/me", { address: "me@gmail.com", mailboxes: ["INBOX"], account: "other" })).status).toBe(400);
  });

  it("refuses an edit the configuration will not take, and changes nothing", async () => {
    await call("POST", "/inboxes", body);
    const res = await call("PUT", "/inboxes/me", { address: "me@example.com", mailboxes: ["INBOX"] });
    expect(res.status).toBe(400);
    expect((h.config.json().sources as { email: Record<string, unknown>[] }).email[0]).toMatchObject({ address: "me@gmail.com" });
  });
});
