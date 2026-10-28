import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { clip } from "./events/body.js";
import type { ClotEvent } from "./events/types.js";
import { jsonBody, storeEvent, type Handler } from "./intake.js";
import type { WebhookRecipe } from "./rulebook.js";
import { fillPaths, pathGet } from "./watch.js";

const same = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/** Checks a delivery the way its recipe says the service signs it. */
export function verifyRecipe(verify: WebhookRecipe["verify"], secret: string, req: { headers: Record<string, string>; rawBody: Buffer }, nowMs: number): boolean {
  const header = req.headers[verify.header];
  if (header === undefined) return false;
  if (verify.scheme === "token") return same(header, secret);
  if (!header.startsWith(verify.prefix)) return false;
  const mac = createHmac("sha256", secret);
  if (verify.signed === "timestamp.body") {
    const at = req.headers[verify.timestampHeader!];
    if (at === undefined || !/^\d+$/.test(at)) return false;
    // Seconds, or milliseconds when the number is that large.
    const atMs = at.length > 11 ? Number(at) : Number(at) * 1000;
    if (Math.abs(nowMs - atMs) > verify.toleranceSeconds * 1000) return false;
    mac.update(`${at}.`);
  }
  mac.update(req.rawBody);
  return same(header.slice(verify.prefix.length), mac.digest(verify.encoding));
}

const matches = (payload: unknown, when: Record<string, string | number | boolean>) => Object.entries(when).every(([path, value]) => pathGet(payload, path) === value);

/** A delivery as the common event, or nothing when no kind of the recipe matches it. */
export function readRecipe(recipe: WebhookRecipe, payload: unknown, req: { headers: Record<string, string>; rawBody: Buffer }, receivedAt: number): ClotEvent | undefined {
  const kind = recipe.kinds.find((entry) => matches(payload, entry.when))?.kind;
  if (kind === undefined) return undefined;
  const fromHeader = recipe.delivery?.header === undefined ? undefined : req.headers[recipe.delivery.header];
  const fromField = recipe.delivery?.field === undefined ? undefined : pathGet(payload, recipe.delivery.field);
  const delivery = fromHeader ?? (fromField === undefined || fromField === null ? undefined : String(fromField)) ?? createHash("sha256").update(req.rawBody).digest("hex").slice(0, 16);
  const fill = (template: string | undefined) => (template === undefined ? "" : fillPaths(template, payload).trim());
  const ref = fill(recipe.event.ref);
  return {
    id: `${recipe.name}:${delivery}`,
    source: recipe.name,
    account: recipe.name,
    kind,
    place: fill(recipe.event.place),
    actor: fill(recipe.event.actor) || recipe.name,
    title: fill(recipe.event.title) || `${recipe.name}: ${kind}`,
    body: clip(recipe.event.body === undefined ? JSON.stringify(payload, null, 1) : fill(recipe.event.body)),
    url: fill(recipe.event.url),
    ref,
    subject: fill(recipe.event.subject) || `${recipe.name}:${ref || delivery}`,
    automated: recipe.automatedWhen !== undefined && matches(payload, recipe.automatedWhen),
    outsider: false,
    receivedAt,
  };
}

/**
 * The handler for /webhooks/r/<name>: there only while the recipe is in force and its secret is
 * in .env. A recipe whose secret is missing is reported once.
 */
export function recipeHandler(d: { recipe: (name: string) => WebhookRecipe | undefined; secret: (key: string) => string | undefined; insertEvent: (event: ClotEvent) => boolean; now: () => number; missingSecret: (recipe: WebhookRecipe) => void }): (name: string) => Handler | undefined {
  const reported = new Set<string>();
  return (name) => {
    const recipe = d.recipe(name);
    if (recipe === undefined) return undefined;
    const secret = d.secret(recipe.verify.secret);
    if (secret === undefined || secret === "") {
      if (!reported.has(recipe.name)) {
        reported.add(recipe.name);
        d.missingSecret(recipe);
      }
      return undefined;
    }
    reported.delete(recipe.name);
    return (req) => {
      if (!verifyRecipe(recipe.verify, secret, req, d.now())) return { status: 401, text: "bad signature" };
      const payload = jsonBody(req.rawBody);
      if (payload === undefined) return { status: 400, text: "body is not JSON" };
      const event = readRecipe(recipe, payload, req, d.now());
      if (!event) return { status: 200, text: "ignored" };
      return storeEvent(event, d.insertEvent);
    };
  };
}
