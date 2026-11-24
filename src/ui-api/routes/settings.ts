import { z } from "zod";
import { HOME_CLOT } from "../../config.js";
import type { ConfigStore } from "../../config-store.js";
import { ApiError, ApiResult, parseBody, type UiApi } from "../server.js";

const generalSchema = z.object({
  timeZone: z.string().min(1).max(60),
  rolloverPercent: z.number().min(1).max(100),
  maxWorkers: z.number().int().min(1).max(20),
  maxProposals: z.number().int().min(1).max(50),
  askTimeoutMinutes: z.number().int().min(1).max(1440),
  publicUrl: z.union([z.literal(""), z.url()]),
});
export type General = z.infer<typeof generalSchema>;

const valueSchema = z.object({ value: z.string().max(10_000) });
const orderSchema = z.object({ order: z.array(z.string().max(64)).max(200) });

export interface SettingsDeps {
  config: ConfigStore;
  /** Stops a Clot's container and forgets what is waiting for it. Its volumes and chat stay. */
  removeClot: (name: string) => Promise<void>;
  /** The names of the Clots that run, in the rail's order; changed when the order or the set changes. */
  reorder: (names: string[]) => void;
  /** Whether a Clot is being made or moved to another repository right now: it cannot be deleted until that ends. */
  building?: (name: string) => boolean;
  /** What the rest of the daemon wants said when the configuration changes. */
  announce: (e: { applied: string[]; needsRestart: string[]; fromFile: boolean; error?: string }) => void;
}

const publicOf = (store: ConfigStore): General & { error?: string; needsRestart: string[] } => {
  const c = store.current;
  return { timeZone: c.timeZone, rolloverPercent: c.rolloverPercent, maxWorkers: c.maxWorkers, maxProposals: c.maxProposals, askTimeoutMinutes: c.askTimeoutMinutes, publicUrl: c.publicUrl, needsRestart: [], ...(store.error === undefined ? {} : { error: store.error }) };
};

export function registerSettingsRoutes(api: UiApi, d: SettingsDeps): void {
  api.route("GET", "/settings/general", () => publicOf(d.config));

  api.route("PUT", "/settings/general", async (req) => {
    const patch = parseBody(generalSchema.partial(), req.body);
    const result = await d.config.save(patch);
    if (!result.ok) return new ApiResult(400, { errors: result.errors });
    d.announce({ applied: result.applied, needsRestart: result.needsRestart, fromFile: false });
    return { ...publicOf(d.config), applied: result.applied, needsRestart: result.needsRestart };
  });

  api.route("GET", "/keys", () => d.config.keys());

  api.route("PUT", "/keys/:name", async (req) => {
    const { value } = parseBody(valueSchema, req.body);
    const res = d.config.setKey(req.params.name!, value);
    if (!res.ok) throw new ApiError(400, res.error);
    // An entry that waited for this key loads now; an account that uses it reconnects with the new value.
    await d.config.reapply();
    return d.config.keys().find((k) => k.name === req.params.name);
  });

  api.route("DELETE", "/keys/:name", async (req) => {
    const res = d.config.removeKey(req.params.name!);
    if (!res.ok) throw new ApiError(409, res.error);
    await d.config.reapply();
    return { ok: true };
  });

  // The rail's order is the order of the Clots in the file: dragging in the rail writes it.
  api.route("POST", "/clots/order", async (req) => {
    const { order } = parseBody(orderSchema, req.body);
    const clots = d.config.current.clots;
    const sorted = [...clots].sort((a, b) => (order.indexOf(a.name) === -1 ? 999 : order.indexOf(a.name)) - (order.indexOf(b.name) === -1 ? 999 : order.indexOf(b.name)));
    const result = await d.config.save({ clots: sorted });
    if (!result.ok) throw new ApiError(400, "that order could not be saved");
    d.reorder([...(d.config.current.home ? [HOME_CLOT] : []), ...sorted.map((c) => c.name)]);
    return { ok: true };
  });

  // Deleting a Clot: the name is typed in, the home Clot is refused, an account scoped to it must go first.
  api.route("DELETE", "/clots/:clot", async (req) => {
    const name = req.params.clot!;
    if (name === HOME_CLOT) throw new ApiError(409, "The home Clot cannot be deleted.");
    if (req.query.get("confirm") !== name) throw new ApiError(400, "Type the Clot's name to delete it.");
    const config = d.config.current;
    if (!config.clots.some((c) => c.name === name)) throw new ApiError(404, "no such Clot");
    if (d.building?.(name)) throw new ApiError(409, `${name} is being set up right now. Wait for that to finish.`);
    // From the file itself: an entry the loader left out as unusable still names the Clot, and would break once the Clot is gone.
    const sources = (d.config.json().sources ?? {}) as { email?: { account?: string; clot?: string }[]; composio?: { toolkit?: string; account?: string; clot?: string }[] };
    const users = [...(sources.email ?? []).filter((a) => a.clot === name).map((a) => `the inbox ${a.account}`), ...(sources.composio ?? []).filter((a) => a.clot === name).map((a) => `the tool ${a.toolkit}:${a.account}`)];
    if (users.length > 0) throw new ApiError(409, `${name} still has ${users.join(", ")}. Remove ${users.length === 1 ? "it" : "them"} first.`, { users });
    const result = await d.config.save({ clots: config.clots.filter((c) => c.name !== name) });
    if (!result.ok) throw new ApiError(400, "the Clot could not be removed");
    await d.removeClot(name);
    return { ok: true };
  });
}
