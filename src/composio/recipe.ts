import { createHash } from "node:crypto";
import { clip } from "../events/body.js";
import type { ClotEvent } from "../events/types.js";
import type { Enricher } from "../enrich.js";
import { fillKey, fillPaths } from "../paths.js";
import type { ComposioRecipe, ComposioTriggerRecipe } from "../rulebook.js";
import { triggerName } from "../sources/generic.js";
import type { ComposioAccount } from "../config.js";
import type { ToolInfo } from "./api.js";
import type { Composio } from "./component.js";
import type { Mapped, Mapper } from "./intake.js";
import { isRead } from "./rating.js";
import type { DeliveryRow } from "./store.js";

/** What a recipe's templates read: the delivery's payload, and each read's data by its `as`. */
export interface RecipeContext {
  payload: unknown;
  enrich: Record<string, unknown>;
}

/** The data of a payload that arrived clipped, shown for the body when a recipe fills none. */
const payloadText = (payload: unknown): string => clip(typeof payload === "string" ? payload : JSON.stringify(payload ?? null, null, 2));

const matches = (ctx: RecipeContext, when: Record<string, string | number | boolean>): boolean =>
  Object.entries(when).every(([path, value]) => {
    const found = fillPathValue(ctx, path);
    return found === value;
  });

/** The raw value at a path of the context (not the text the path would fill). */
function fillPathValue(ctx: RecipeContext, path: string): unknown {
  let at: unknown = ctx;
  for (const step of path.split(".")) {
    if (at === null || typeof at !== "object") return undefined;
    at = (at as Record<string, unknown>)[step];
  }
  return at;
}

/**
 * One trigger's event, from a recipe: the one function behind both steps (the mapper at intake, which has no reads
 * yet, and the enricher, which fills the text again once they are in) and behind `composio_try`. Pure. The
 * fallbacks are the generic mapping's: the event's ID to the delivery's, the actor to `unknown`, the title to the
 * trigger's name, the body to the payload, the subject to `<toolkit>:<slug>`, the place to the account's name, and
 * `url` and `ref` to empty. A key (`id`, `actorId`, each of `objects`) with any path missing fills empty. `lines`
 * are notes about reads that did not happen, added to the body.
 */
export function renderRecipe(recipe: ComposioRecipe, slug: string, account: Pick<ComposioAccount, "toolkit" | "account">, payload: unknown, enrich: Record<string, unknown>, webhookId: string, receivedAt: number, lines: string[] = []): Mapped {
  const t: ComposioTriggerRecipe = recipe.triggers[slug];
  const ctx: RecipeContext = { payload, enrich };
  const fill = (template: string | undefined): string => (template === undefined ? "" : fillPaths(template, ctx).trim());
  const id = t.id === undefined ? undefined : fillKey(t.id, ctx);
  const objectIds = (t.objects ?? []).flatMap((o) => fillKey(o, ctx) ?? []);
  const body = [fill(t.body) || payloadText(payload), ...lines].filter((x) => x !== "").join("\n");
  const subject = fill(t.subject) || `${account.toolkit}:${slug}`;
  const event: ClotEvent = {
    id: id === undefined ? `composio:${webhookId}` : `${account.toolkit}:${account.account}:${id}`,
    source: account.toolkit,
    account: account.account,
    kind: t.kind,
    place: fill(t.place) || account.account,
    actor: fill(t.actor) || "unknown",
    title: fill(t.title) || triggerName(slug, account.toolkit),
    body: clip(body),
    url: fill(t.url),
    ref: fill(t.ref),
    subject,
    automated: t.automatedWhen !== undefined && matches(ctx, t.automatedWhen),
    // Whoever can reach the service writes what its deliveries carry.
    outsider: true,
    receivedAt,
  };
  return { event, actorId: (t.actorId === undefined ? undefined : fillKey(t.actorId, ctx)) ?? "", objectIds };
}

/** The mapper of a toolkit's recipe, at intake: no reads yet, so the text that needs one is provisional. A trigger the recipe does not list is not its to map. */
export function recipeMapper(recipe: ComposioRecipe): Mapper {
  return (account, slug, data, webhookId, receivedAt) => (recipe.triggers[slug] === undefined ? undefined : renderRecipe(recipe, slug, account, data, {}, webhookId, receivedAt));
}

/** A string that is a template is filled, nested objects and lists too; anything else passes through. */
function fillArgs(value: unknown, ctx: RecipeContext): unknown {
  if (typeof value === "string") return fillPaths(value, ctx);
  if (Array.isArray(value)) return value.map((v) => fillArgs(v, ctx));
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fillArgs(v, ctx)]));
  return value;
}

const stable = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
};

/** How much of a pool's allowance recipe reads may use before they are skipped. */
export const READ_BUDGET = 0.8;

export interface RecipeReader {
  composio: Pick<Composio, "run" | "tool" | "account" | "managed" | "connectionId">;
  /** The month's usage of a pool, as fractions. Absent: no budget. */
  used?: (managed: boolean) => { calls: number; events: number };
  cached(account: string, tool: string, argsHash: string, now: number): unknown | undefined;
  keep(account: string, tool: string, argsHash: string, data: unknown, now: number): void;
  now(): number;
}

/**
 * Runs a recipe's reads in order on an account and gives each one's data by its name, with a line for each that
 * did not happen. A read that is not a read tool, or that fails, or that the allowance has no room for, is a line
 * and empty data, and the rest goes on. The same read (account, tool, arguments) is served from the store for 24
 * hours, and one in flight is shared. `count` is called before each call that would be made (the Clot's tool limits).
 */
export class RecipeReads {
  private inFlight = new Map<string, Promise<{ ok: true; data: unknown } | { ok: false; error: string }>>();

  constructor(private d: RecipeReader) {}

  async run(trigger: ComposioTriggerRecipe, account: ComposioAccount, payload: unknown, o: { count?: () => string | undefined } = {}): Promise<{ enrich: Record<string, unknown>; lines: string[] }> {
    const enrich: Record<string, unknown> = {};
    const lines: string[] = [];
    // A read is scoped to the connection it ran on: after a reconnect or a credential swap another service user's data is never reused, and a read still in flight for the old connection never fills the new one's cache.
    const user = `${account.toolkit}:${account.account}#${this.d.composio.connectionId(account)}`;
    for (const read of trigger.enrich ?? []) {
      const args = fillArgs(read.args ?? {}, { payload, enrich }) as Record<string, unknown>;
      const tool: ToolInfo | undefined = await this.d.composio.tool(read.tool).catch(() => undefined);
      if (tool === undefined || tool.toolkit !== account.toolkit || !isRead(tool)) {
        lines.push(`Could not read ${read.as}: ${read.tool} is not a read tool.`);
        continue;
      }
      const hash = createHash("sha256").update(stable(args)).digest("hex").slice(0, 32);
      const hit = this.d.cached(user, read.tool, hash, this.d.now());
      if (hit !== undefined) {
        enrich[read.as] = hit;
        continue;
      }
      const used = this.d.used?.(this.d.composio.managed(account));
      if (used !== undefined && (used.calls >= READ_BUDGET || used.events >= READ_BUDGET)) {
        lines.push(`Skipped reading ${read.as}: Composio's monthly allowance is 80% used.`);
        continue;
      }
      const refusal = o.count?.();
      if (refusal !== undefined) {
        lines.push(`Could not read ${read.as}: ${refusal}`);
        continue;
      }
      const key = `${user}|${read.tool}|${hash}`;
      let shared = this.inFlight.get(key);
      if (shared === undefined) {
        shared = this.d.composio
          .run(account, read.tool, args)
          .then((r): { ok: true; data: unknown } | { ok: false; error: string } => (r.ok ? { ok: true, data: r.data } : { ok: false, error: r.error }))
          .catch((e): { ok: false; error: string } => ({ ok: false, error: e instanceof Error ? e.message : String(e) }))
          .finally(() => this.inFlight.delete(key));
        this.inFlight.set(key, shared);
      }
      const result = await shared;
      if (!result.ok) {
        lines.push(`Could not read ${read.as}: ${result.error}.`);
        continue;
      }
      this.d.keep(user, read.tool, hash, result.data, this.d.now());
      enrich[read.as] = result.data;
    }
    return { enrich, lines };
  }
}

/** The line a body gets when a delivery's payload was too long to keep whole. */
export const CLIPPED_LINE = `(The payload was too large to read in full, so this event was not enriched: it keeps the text it came with.)`;

/**
 * The enricher for a toolkit with a Composio recipe: for an event whose source is that toolkit and that has a kept
 * delivery, runs the recipe's reads and renders the title, actor and body again with their data. No recipe, no kept
 * delivery or no reads: the event as it is. A clipped payload is not enriched. Never throws.
 */
export function recipeEnricher(d: {
  reads: RecipeReads;
  composio: Pick<Composio, "account">;
  recipe(toolkit: string): ComposioRecipe | undefined;
  delivery(eventId: string): DeliveryRow | undefined;
}): Enricher {
  return async (event) => {
    const recipe = d.recipe(event.source);
    const delivery = recipe === undefined ? undefined : d.delivery(event.id);
    if (recipe === undefined || delivery === undefined) return event;
    const trigger = recipe.triggers[delivery.slug];
    const account = d.composio.account(delivery.user);
    if (trigger === undefined || account === undefined || (trigger.enrich ?? []).length === 0) return event;
    if (delivery.clipped) return { ...event, body: `${event.body}\n${CLIPPED_LINE}`.trim() };
    let payload: unknown;
    try {
      payload = JSON.parse(delivery.payload);
    } catch {
      return event;
    }
    const { enrich, lines } = await d.reads.run(trigger, account, payload);
    const { event: rendered } = renderRecipe(recipe, delivery.slug, account, payload, enrich, delivery.webhookId, delivery.receivedAt, lines);
    return { ...event, title: rendered.title, actor: rendered.actor, body: rendered.body };
  };
}

