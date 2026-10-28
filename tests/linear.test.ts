import { createHmac } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { LinearAccount } from "../src/config.js";
import type { ClotEvent } from "../src/events/types.js";
import { linearCommentSender, linearEnricher, linearHandler, normalizeLinear, verifyLinear } from "../src/sources/linear.js";

const account: LinearAccount = { account: "tady", shared: true, webhookSecret: "lin_wh_test", apiKey: "lin_api_test" };
const NOW = 1_760_000_000_000;

const issueCreated = {
  action: "create",
  type: "Issue",
  actor: { id: "user-1", name: "Nicholas", type: "user" },
  data: { id: "uuid-12", identifier: "ENC-12", title: "Export fails on Safari", description: "Steps: open export.", team: { key: "ENC" } },
  url: "https://linear.app/tady/issue/ENC-12/export-fails-on-safari",
  webhookTimestamp: NOW - 2000,
};
const commentCreated = {
  action: "create",
  type: "Comment",
  actor: { id: "member-clots", name: "Clots", type: "user" },
  data: { id: "c-1", body: "Looking into it.", issueId: "uuid-12", issue: { id: "uuid-12", identifier: "ENC-12", title: "Export fails on Safari" } },
  url: "https://linear.app/tady/issue/ENC-12/export-fails-on-safari#comment-c-1",
  webhookTimestamp: NOW - 2000,
};

const sign = (body: string, secret = account.webhookSecret) => createHmac("sha256", secret).update(body).digest("hex");

describe("verifyLinear", () => {
  it("accepts the hex HMAC of the raw body, and refuses anything else", () => {
    const body = JSON.stringify(issueCreated);
    expect(verifyLinear(account.webhookSecret, Buffer.from(body), sign(body))).toBe(true);
    expect(verifyLinear(account.webhookSecret, Buffer.from(body), sign(body, "other"))).toBe(false);
    expect(verifyLinear(account.webhookSecret, Buffer.from(body), `sha256=${sign(body)}`)).toBe(false);
    expect(verifyLinear(account.webhookSecret, Buffer.from(body), undefined)).toBe(false);
  });
});

describe("normalizeLinear", () => {
  it("turns a new issue into an event in its team", () => {
    expect(normalizeLinear(account, issueCreated, "dl-1", NOW)).toEqual({
      actorId: "user-1",
      event: {
        id: "linear:tady:dl-1",
        source: "linear",
        account: "tady",
        kind: "issue_opened",
        place: "ENC",
        actor: "Nicholas",
        title: "Issue ENC-12 opened: Export fails on Safari",
        body: "Steps: open export.",
        url: "https://linear.app/tady/issue/ENC-12/export-fails-on-safari",
        ref: "ENC-12",
        subject: "issue:ENC-12",
        automated: false,
        outsider: false,
        receivedAt: NOW,
      },
    });
  });

  it("turns a new comment into an event about its issue, and marks an integration's as automated", () => {
    const { event } = normalizeLinear(account, { ...commentCreated, actor: { id: "app-1", name: "GitHub", type: "integration" } }, "dl-2", NOW)!;
    expect(event).toMatchObject({ kind: "comment", place: "ENC", title: "Comment on ENC-12: Export fails on Safari", body: "Looking into it.", ref: "ENC-12", subject: "issue:ENC-12", automated: true });
  });

  it("ignores updates and removals, and anything that is not an issue or a comment", () => {
    expect(normalizeLinear(account, { ...issueCreated, action: "update" }, "dl-3", NOW)).toBeUndefined();
    expect(normalizeLinear(account, { ...issueCreated, type: "Project" }, "dl-4", NOW)).toBeUndefined();
    expect(normalizeLinear(account, "junk", "dl-5", NOW)).toBeUndefined();
  });
});

describe("linearHandler", () => {
  const req = (body: string, headers: Record<string, string>) => ({ method: "POST", headers, query: new URLSearchParams(), rawBody: Buffer.from(body) });
  const handler = (seen = new Set<string>()) => linearHandler(account, { insertEvent: (e: ClotEvent) => (seen.has(e.id) ? false : (seen.add(e.id), true)), now: () => NOW, memberId: () => "member-clots" });

  it("stores a signed delivery, and drops what the Clots' member did", async () => {
    const body = JSON.stringify(issueCreated);
    expect(await handler()(req(body, { "linear-signature": sign(body), "linear-delivery": "dl-1" }))).toMatchObject({ status: 202, event: { id: "linear:tady:dl-1" } });
    const own = JSON.stringify(commentCreated);
    expect(await handler()(req(own, { "linear-signature": sign(own), "linear-delivery": "dl-2" }))).toMatchObject({ status: 202, dropped: "caused by the Clot itself" });
  });

  it("refuses a bad signature, a missing delivery ID and a stale delivery", async () => {
    const body = JSON.stringify(issueCreated);
    expect((await handler()(req(body, { "linear-signature": sign(body, "x"), "linear-delivery": "dl-1" }))).status).toBe(401);
    expect((await handler()(req(body, { "linear-signature": sign(body) }))).status).toBe(400);
    const stale = JSON.stringify({ ...issueCreated, webhookTimestamp: NOW - 120_000 });
    expect((await handler()(req(stale, { "linear-signature": sign(stale), "linear-delivery": "dl-9" }))).status).toBe(401);
  });
});

describe("Linear's API", () => {
  function api(answers: Record<string, unknown>) {
    const calls: { body: any; auth: string }[] = [];
    const fetchFn = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      calls.push({ body, auth: String((init.headers as Record<string, string>).authorization) });
      const key = Object.keys(answers).find((k) => body.query.includes(k))!;
      return Response.json({ data: answers[key] });
    }) as unknown as typeof fetch;
    return { calls, fetchFn };
  }

  it("adds the issue's state, people and latest comments, read as the Clots' member", async () => {
    const { calls, fetchFn } = api({
      issue: {
        issue: {
          identifier: "ENC-12",
          description: "Steps: open export.",
          state: { name: "Todo" },
          priorityLabel: "High",
          assignee: { name: "Lukas" },
          labels: { nodes: [{ name: "Bug" }] },
          comments: { nodes: [{ body: "Same here.", createdAt: "2026-10-14T09:00:00.000Z", user: { name: "Ann" } }] },
        },
      },
    });
    const { event } = normalizeLinear(account, commentCreated, "dl-2", NOW)!;
    const read = await linearEnricher([account], fetchFn)(event);
    expect(calls[0].auth).toBe("lin_api_test");
    expect(calls[0].body.variables).toEqual({ id: "ENC-12" });
    expect(read.body).toContain("State: Todo; priority High; assigned to Lukas; labels Bug");
    expect(read.body).toContain("Description:\nSteps: open export.");
    expect(read.body).toContain("- Ann (2026-10-14): Same here.");
  });

  it("comments on the issue an event is about, as the Clots' member", async () => {
    const { calls, fetchFn } = api({ "issue(": { issue: { id: "uuid-12" } }, commentCreate: { commentCreate: { success: true, comment: { url: "https://linear.app/tady/issue/ENC-12#comment-9" } } } });
    let member = "member-1";
    const sender = linearCommentSender([account], () => member, fetchFn);
    const { event } = normalizeLinear(account, issueCreated, "dl-1", NOW)!;
    expect(sender.reach(event)).toBeUndefined();
    expect(sender.reach({ ...event, source: "github" })).toContain("Linear");
    // Until the Clots' member is known, its own comment would come back looking like anyone's.
    member = "";
    expect(sender.reach(event)).toContain("not known yet");
    member = "member-1";
    expect(await sender.send(event, "Thanks, looking into it.")).toEqual({ ok: true, url: "https://linear.app/tady/issue/ENC-12#comment-9" });
    expect(calls[1].body.variables).toEqual({ input: { issueId: "uuid-12", body: "Thanks, looking into it." } });
  });
});

describe("recorded Linear deliveries", () => {
  const dir = "tests/fixtures/linear";
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".json")) : [];

  it.skipIf(files.length === 0)("turn into an issue or a comment event, or are ignored", () => {
    for (const file of files) {
      const recording = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
      const found = normalizeLinear(account, recording.body, String(recording.headers["linear-delivery"]), NOW);
      if (recording.body.action !== "create" || !["Issue", "Comment"].includes(recording.body.type)) {
        expect(found, file).toBeUndefined();
        continue;
      }
      expect(found!.event, file).toMatchObject({ source: "linear", kind: recording.body.type === "Issue" ? "issue_opened" : "comment" });
      expect(found!.event.subject, file).toMatch(/^issue:/);
      expect(found!.actorId, file).not.toBe("");
    }
  });
});
