import { createHmac } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readEnvFile } from "../src/env-file.js";
import type { ClotEvent } from "../src/events/types.js";
import { parseWebhook, type WebhookRecipe } from "../src/rulebook.js";
import { readRecipe, recipeHandler, verifyRecipe } from "../src/webhook-recipe.js";

const recipe: WebhookRecipe = parseWebhook({
  name: "linear-second",
  verify: { scheme: "hmac-sha256", header: "Linear-Signature", encoding: "hex", signed: "body", secret: "RECIPE_LINEAR_SECOND" },
  delivery: { header: "Linear-Delivery" },
  kinds: [
    { kind: "issue_opened", when: { type: "Issue", action: "create" } },
    { kind: "comment", when: { type: "Comment", action: "create" } },
  ],
  event: { actor: "{actor.name}", title: "{data.title}", body: "{data.description}{data.body}", url: "{url}", ref: "{data.identifier}", place: "{data.team.key}", subject: "issue:{data.identifier}{data.issue.identifier}" },
  automatedWhen: { "actor.type": "integration" },
});

const issue = { type: "Issue", action: "create", actor: { name: "Ann", type: "user" }, data: { identifier: "SEC-4", title: "Sign-up broken", description: "Steps.", team: { key: "SEC" } }, url: "https://linear.app/x/issue/SEC-4" };
const NOW = 1_760_000_000_000;
const hex = (body: string, secret = "s3") => createHmac("sha256", secret).update(body).digest("hex");

describe("parseWebhook", () => {
  it("fills in the defaults, and wants a RECIPE_ secret, a kind for each entry and a title", () => {
    expect(recipe.verify).toEqual({ scheme: "hmac-sha256", header: "linear-signature", prefix: "", encoding: "hex", signed: "body", toleranceSeconds: 300, secret: "RECIPE_LINEAR_SECOND" });
    const base = { name: "x", verify: { scheme: "token", header: "X-Token", secret: "RECIPE_X" }, kinds: [{ kind: "ping", when: {} }], event: { title: "{t}" } };
    expect(() => parseWebhook(base)).not.toThrow();
    expect(() => parseWebhook({ ...base, verify: { ...base.verify, secret: "CLOT_GITHUB_TOKEN" } })).toThrow("RECIPE_");
    expect(() => parseWebhook({ ...base, kinds: [{ kind: "batch", when: {} }] })).toThrow();
    expect(() => parseWebhook({ ...base, event: {} })).toThrow();
    expect(() => parseWebhook({ ...base, name: "stripe" })).toThrow("built-in source");
    expect(() => parseWebhook({ ...base, verify: { scheme: "hmac-sha256", header: "S", secret: "RECIPE_X", signed: "timestamp.body" } })).toThrow("timestampHeader");
  });
});

describe("verifyRecipe", () => {
  const req = (body: string, headers: Record<string, string>) => ({ headers, rawBody: Buffer.from(body) });

  it("checks an HMAC of the body, in hex or base64, with a prefix", () => {
    const body = JSON.stringify(issue);
    expect(verifyRecipe(recipe.verify, "s3", req(body, { "linear-signature": hex(body) }), NOW)).toBe(true);
    expect(verifyRecipe(recipe.verify, "s3", req(body, { "linear-signature": hex(body, "other") }), NOW)).toBe(false);
    const prefixed = { ...recipe.verify, prefix: "sha256=", encoding: "base64" as const };
    const b64 = createHmac("sha256", "s3").update(body).digest("base64");
    expect(verifyRecipe(prefixed, "s3", req(body, { "linear-signature": `sha256=${b64}` }), NOW)).toBe(true);
    expect(verifyRecipe(prefixed, "s3", req(body, { "linear-signature": b64 }), NOW)).toBe(false);
  });

  it("checks an HMAC of the timestamp and the body, within the tolerance", () => {
    const verify = { ...recipe.verify, signed: "timestamp.body" as const, timestampHeader: "x-time" };
    const body = "{}";
    const at = String(Math.floor(NOW / 1000));
    const signature = createHmac("sha256", "s3").update(`${at}.${body}`).digest("hex");
    expect(verifyRecipe(verify, "s3", req(body, { "linear-signature": signature, "x-time": at }), NOW)).toBe(true);
    expect(verifyRecipe(verify, "s3", req(body, { "linear-signature": signature, "x-time": at }), NOW + 301_000)).toBe(false);
  });

  it("checks a static token", () => {
    const verify = { ...recipe.verify, scheme: "token" as const, header: "x-clots-token" };
    expect(verifyRecipe(verify, "s3", req("{}", { "x-clots-token": "s3" }), NOW)).toBe(true);
    expect(verifyRecipe(verify, "s3", req("{}", { "x-clots-token": "s4" }), NOW)).toBe(false);
  });
});

describe("readRecipe", () => {
  const req = (headers: Record<string, string> = { "linear-delivery": "dl-1" }) => ({ headers, rawBody: Buffer.from(JSON.stringify(issue)) });

  it("turns a payload into an event by the first kind whose fields match", () => {
    expect(readRecipe(recipe, issue, req(), NOW)).toEqual({
      id: "linear-second:dl-1",
      source: "linear-second",
      account: "linear-second",
      kind: "issue_opened",
      place: "SEC",
      actor: "Ann",
      title: "Sign-up broken",
      body: "Steps.",
      url: "https://linear.app/x/issue/SEC-4",
      ref: "SEC-4",
      subject: "issue:SEC-4",
      automated: false,
      // Whoever can reach the service writes what it delivers.
      outsider: true,
      receivedAt: NOW,
    } satisfies ClotEvent);
  });

  it("ignores a payload no kind matches, marks automated ones, and names a delivery by a hash without an ID", () => {
    expect(readRecipe(recipe, { ...issue, action: "update" }, req(), NOW)).toBeUndefined();
    expect(readRecipe(recipe, { ...issue, actor: { name: "Bot", type: "integration" } }, req(), NOW)!.automated).toBe(true);
    const unnamed = readRecipe({ ...recipe, delivery: undefined }, issue, req({}), NOW)!;
    expect(unnamed.id).toMatch(/^linear-second:[0-9a-f]{16}$/);
    expect(readRecipe({ ...recipe, event: { title: "{nowhere}" } }, issue, req(), NOW)!.title).toBe("linear-second: issue_opened");
  });
});

describe("recipeHandler", () => {
  const body = JSON.stringify(issue);
  const call = (handler: ReturnType<ReturnType<typeof recipeHandler>>, signature = hex(body)) => handler!({ method: "POST", headers: { "linear-signature": signature, "linear-delivery": "dl-1" }, query: new URLSearchParams(), rawBody: Buffer.from(body) });

  it("answers for a recipe whose secret is set, stores what it reads, and refuses a bad signature", async () => {
    const seen = new Set<string>();
    const make = recipeHandler({ recipe: (name) => (name === recipe.name ? recipe : undefined), secret: (key) => (key === "RECIPE_LINEAR_SECOND" ? "s3" : undefined), insertEvent: (e: ClotEvent) => (seen.has(e.id) ? false : (seen.add(e.id), true)), now: () => NOW, missingSecret: () => undefined });
    expect(make("nothing")).toBeUndefined();
    expect(await call(make(recipe.name))).toMatchObject({ status: 202, event: { id: "linear-second:dl-1" } });
    expect((await call(make(recipe.name))).text).toBe("duplicate");
    expect((await call(make(recipe.name), hex(body, "wrong"))).status).toBe(401);
  });

  it("is not there while its secret is missing, and says so once", () => {
    const missing: string[] = [];
    const make = recipeHandler({ recipe: () => recipe, secret: () => undefined, insertEvent: () => true, now: () => NOW, missingSecret: (r) => void missing.push(r.name) });
    expect(make(recipe.name)).toBeUndefined();
    expect(make(recipe.name)).toBeUndefined();
    expect(missing).toEqual(["linear-second"]);
  });
});

describe("readEnvFile", () => {
  it("reads KEY=value lines, without quotes, comments or blank lines", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "clots-env-")), ".env");
    fs.writeFileSync(file, '# a comment\nRECIPE_A=one\n\nRECIPE_B="two words"\nexport RECIPE_C=three\n');
    expect(readEnvFile(file)).toEqual({ RECIPE_A: "one", RECIPE_B: "two words", RECIPE_C: "three" });
    expect(readEnvFile(path.join(path.dirname(file), "missing"))).toEqual({});
  });
});
