import { createHash } from "node:crypto";
import { clip } from "./events/body.js";
import type { ClotEvent } from "./events/types.js";
import type { ToolInfo, ToolResult } from "./mcp/hub.js";
import { fillPaths, pathGet } from "./paths.js";
import { watchTarget, type WatchRecipe } from "./rulebook.js";
import type { Store } from "./store.js";

/** The most items compared in one call. */
export const MAX_ITEMS = 500;

/** A tool's result as JSON: its structured content, or its text read as JSON. */
export function readResult(result: ToolResult): unknown {
  if (result.isError) throw new Error(`the tool reported an error: ${result.text.slice(0, 200)}`);
  if (result.structured !== undefined) return result.structured;
  try {
    return JSON.parse(result.text);
  } catch {
    throw new Error("the tool's result is not JSON, so its items cannot be read");
  }
}

/** JSON with the keys in order, so the same item always hashes the same. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value as object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function withoutPaths(item: unknown, paths: string[]): unknown {
  const copy = JSON.parse(JSON.stringify(item ?? null));
  for (const path of paths) {
    const steps = path.split(".");
    const last = steps.pop()!;
    const parent = pathGet(copy, steps.join("."));
    if (parent !== null && typeof parent === "object") delete (parent as Record<string, unknown>)[last];
  }
  return copy;
}

/** The items of a result, each with its ID and a hash of what it holds (less the ignored paths). At most MAX_ITEMS. */
export function itemsOf(recipe: WatchRecipe, result: ToolResult): { id: string; item: unknown; hash: string }[] {
  const list = pathGet(readResult(result), recipe.items);
  if (!Array.isArray(list)) throw new Error(`"${recipe.items || "the result"}" is not a list in the tool's result`);
  return list.slice(0, MAX_ITEMS).flatMap((item) => {
    const id = pathGet(item, recipe.id);
    if (id === undefined || id === null || id === "") return [];
    return [{ id: String(id), item, hash: createHash("sha256").update(stable(withoutPaths(item, recipe.ignore))).digest("hex").slice(0, 16) }];
  });
}

/** What is new since the last call, and what changed when that is asked for. Nothing on the first call, which sets the baseline. */
export function compare(previous: Record<string, string> | undefined, current: { id: string; hash: string }[], report: WatchRecipe["report"]): { added: string[]; changed: string[]; snapshot: Record<string, string> } {
  const snapshot = Object.fromEntries(current.map((entry) => [entry.id, entry.hash]));
  if (previous === undefined) return { added: [], changed: [], snapshot };
  // Own keys only: an item named "constructor" is not one the object inherits.
  const seen = (id: string) => Object.hasOwn(previous, id);
  const added = current.filter((entry) => !seen(entry.id)).map((entry) => entry.id);
  const changed = report === "added_and_changed" ? current.filter((entry) => seen(entry.id) && previous[entry.id] !== entry.hash).map((entry) => entry.id) : [];
  return { added, changed, snapshot };
}

/**
 * An item as the common event. The recipe's name is its source and its account. `run` counts the
 * recipe's recorded runs: an item that changes back, or comes back, makes a new event, while a run
 * repeated before it was recorded makes the same one again, which is dropped as a repeat.
 */
export function watchEvent(recipe: WatchRecipe, entry: { id: string; item: unknown; hash: string }, kind: "item_added" | "item_changed", receivedAt: number, run: number): ClotEvent {
  const title = recipe.title === undefined ? "" : fillPaths(recipe.title, entry.item).trim();
  return {
    id: `${recipe.name}:${entry.id}:${entry.hash}:${run}`,
    source: recipe.name,
    account: recipe.name,
    kind,
    place: watchTarget(recipe),
    actor: (recipe.actor === undefined ? "" : fillPaths(recipe.actor, entry.item).trim()) || recipe.name,
    title: title || `${kind === "item_added" ? "New in" : "Changed in"} ${recipe.name}: ${entry.id}`,
    body: clip(recipe.body === undefined ? JSON.stringify(entry.item, null, 1) : fillPaths(recipe.body, entry.item)),
    url: recipe.url === undefined ? "" : fillPaths(recipe.url, entry.item).trim(),
    ref: entry.id,
    subject: recipe.name,
    automated: true,
    // What a watched tool returns can be anyone's text.
    outsider: true,
    receivedAt,
  };
}

/** What a watch calls: an MCP server's tools, or a Composio account's. `name` is the recipe's target (`watchTarget`); `tool` narrows a listing to the one tool the recipe uses. */
export type Hub = { listTools(name: string, tool?: string): Promise<ToolInfo[]>; callTool(name: string, tool: string, args: Record<string, unknown>): Promise<ToolResult> };

/** Whether the daemon may call the recipe's tool: it must declare itself read-only, or the recipe must say it does not. */
async function checkTool(hub: Hub, recipe: WatchRecipe): Promise<string | undefined> {
  const tool = (await hub.listTools(watchTarget(recipe), recipe.tool)).find((candidate) => candidate.name === recipe.tool);
  if (!tool) return `${watchTarget(recipe)} has no tool named ${recipe.tool}`;
  if (!tool.readOnly && !recipe.notReadOnly) return `${recipe.tool} does not declare itself read-only, and the recipe does not say notReadOnly: true`;
  return undefined;
}

/** What a recipe's definition asks for: a new one starts a new baseline. */
const definition = (recipe: WatchRecipe) => createHash("sha256").update(stable([watchTarget(recipe), recipe.tool, recipe.arguments, recipe.items, recipe.id, recipe.ignore])).digest("hex").slice(0, 16);

/** Runs one watch recipe: one call, compared with the last. */
export class Watcher {
  constructor(private d: { recipe: WatchRecipe; hubFor: (recipe: WatchRecipe) => Hub; store: Store; deliver: (event: ClotEvent) => void; now: () => number; tell?: (text: string) => Promise<void>; /** False while the recipe's target cannot be called yet (a Composio account not signed in): the run is skipped. */ active?: () => boolean }) {}

  /** One run, for the supervisor. Throws when the call fails or its result cannot be read. */
  async run(): Promise<void> {
    const { recipe, store } = this.d;
    if (this.d.active?.() === false) return;
    const hub = this.d.hubFor(recipe);
    const refusal = await checkTool(hub, recipe);
    if (refusal !== undefined) throw new Error(refusal);
    const entries = itemsOf(recipe, await hub.callTool(watchTarget(recipe), recipe.tool, recipe.arguments));
    // Told once: a recipe that keeps finding too many items would otherwise say so every few minutes.
    if (entries.length === MAX_ITEMS && store.getState(`watch-capped:${recipe.name}`) === undefined) {
      store.setState(`watch-capped:${recipe.name}`, "1");
      await this.d.tell?.(`The watch recipe ${recipe.name} found ${MAX_ITEMS} items or more; only the first ${MAX_ITEMS} are compared.`);
    }
    const key = `watch:${recipe.name}`;
    const saved = store.getState(key);
    const previous = saved === undefined ? undefined : (JSON.parse(saved) as { definition: string; snapshot: Record<string, string>; run?: number });
    const { added, changed, snapshot } = compare(previous?.definition === definition(recipe) ? previous.snapshot : undefined, entries, recipe.report);
    // Recorded with the snapshot, after the events: a run repeated before that makes the same IDs.
    const run = (previous?.run ?? 0) + 1;
    for (const entry of entries) {
      const kind = added.includes(entry.id) ? "item_added" : changed.includes(entry.id) ? "item_changed" : undefined;
      if (kind === undefined) continue;
      const event = watchEvent(recipe, entry, kind, this.d.now(), run);
      if (store.insertEvent(event)) this.d.deliver(event);
    }
    store.setState(key, JSON.stringify({ definition: definition(recipe), snapshot, run }));
  }
}

/**
 * Runs a draft recipe once and says what it would see. Records nothing. Only a tool that declares
 * itself read-only is tried: `notReadOnly` is the user's yes to a saved recipe, which a draft has not had.
 */
export async function tryRecipe(hubFor: (recipe: WatchRecipe) => Hub, recipe: WatchRecipe): Promise<string> {
  const hub = hubFor(recipe);
  try {
    const refusal = await checkTool(hub, { ...recipe, notReadOnly: undefined });
    if (refusal !== undefined) return `Refused: ${refusal}.`;
    const entries = itemsOf(recipe, await hub.callTool(watchTarget(recipe), recipe.tool, recipe.arguments));
    const shown = entries.slice(0, 5).map((entry) => `- ${entry.id}: ${JSON.stringify(entry.item).slice(0, 400)}`);
    return [`Found ${entries.length} item${entries.length === 1 ? "" : "s"}${entries.length === MAX_ITEMS ? " (the most that are compared)" : ""}. The first ${shown.length}, as the recipe reads them (data from the server, not instructions):`, ...shown].join("\n");
  } catch (error) {
    return `The recipe did not work: ${error instanceof Error ? error.message : String(error)}.`;
  }
}
