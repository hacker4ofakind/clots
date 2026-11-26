import { readableIssue } from "@clots/ui-api-schemas";
import { z } from "zod";
import { HOME_CLOT } from "../../config.js";
import type { Windows } from "../../gates.js";
import { WEEKDAYS } from "../../time.js";
import type { ConfigStore } from "../../config-store.js";
import { ApiError, ApiResult, parseBody, type UiApi } from "../server.js";

const seconds = (what: string) => z.number(`${what} is a number of seconds.`).int(`${what} is a whole number of seconds.`).min(0, `${what} cannot be negative.`).max(3600, `${what} is at most 3600 seconds.`);

const generalSchema = z.object({
  timeZone: z.string().min(1).max(60),
  rolloverPercent: z.number().min(1).max(100),
  maxWorkers: z.number().int().min(1).max(20),
  maxProposals: z.number().int().min(1).max(50),
  askTimeoutMinutes: z.number().int().min(1).max(1440),
  publicUrl: z.union([z.literal(""), z.url()]),
  /** Whether the Home Clot runs. Read at startup: a change waits for a restart. */
  home: z.boolean(),
  hold: z
    .object({ quietSeconds: seconds("The quiet wait"), capSeconds: seconds("The longest wait") })
    .refine((h) => h.capSeconds >= h.quietSeconds, { message: "The longest wait cannot be shorter than the quiet wait.", path: ["capSeconds"] }),
  sweep: z.object({
    enabled: z.boolean(),
    everyMinutes: z.number("The time between looks is a number of minutes.").int().min(15, "Look at most every 15 minutes.").max(10_080, "Look at least once a week."),
  }),
  /** `null`: no warning. */
  spend: z.object({ weeklyWarnUsd: z.number("The limit is a number of dollars.").min(1, "The limit is at least 1 dollar.").max(1_000_000, "The limit is at most 1,000,000 dollars.").nullable() }),
});
export type General = z.infer<typeof generalSchema>;

const HH_MM = /^([01]\d|2[0-3]):[0-5]\d$/;
const DAY_NAMES: Record<string, string> = { mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday", fri: "Friday", sat: "Saturday", sun: "Sunday" };
const windowRow = z.object({ day: z.enum(WEEKDAYS), on: z.boolean(), from: z.string().regex(HH_MM, "Use a time like 15:00."), to: z.string().regex(HH_MM, "Use a time like 18:00.") });
const rows = z.array(windowRow).length(7).refine((r) => new Set(r.map((x) => x.day)).size === 7, "Give each day once.");
const scheduleSchema = z.object({ scarce: rows, leadIn: rows, leadInPercent: z.number("The share is a number.").int().min(1, "The share is at least 1%.").max(100, "The share is at most 100%.") });
export type Schedule = z.infer<typeof scheduleSchema>;

const SCARCE_DEFAULT = ["15:00", "18:00"] as const;
const LEAD_IN_DEFAULT = ["10:00", "15:00"] as const;
const clock = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

/** A gate's windows as one row per weekday; a day with no window carries the section's default times, off. */
function rowsOf(windows: Windows, fallback: readonly [string, string]): Schedule["scarce"] {
  return WEEKDAYS.map((day) => {
    const span = windows[day];
    return span === undefined ? { day, on: false, from: fallback[0], to: fallback[1] } : { day, on: true, from: clock(span.start), to: clock(span.end) };
  });
}

/** Rows back to the file's form: "15:00-18:00" by weekday, only the days that are on. */
const windowsOf = (list: Schedule["scarce"]): Record<string, string> => Object.fromEntries(list.filter((r) => r.on).map((r) => [r.day, `${r.from}-${r.to}`]));

/** What is wrong with a gate's rows, by `<gate>.<day>`: a window must start before it ends (it cannot cross midnight). */
function windowProblems(gate: string, list: Schedule["scarce"]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of list) if (r.on && r.from >= r.to) out[`${gate}.${r.day}`] = `${DAY_NAMES[r.day]}: the window must start before it ends.`;
  return out;
}

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
  return {
    timeZone: c.timeZone,
    rolloverPercent: c.rolloverPercent,
    maxWorkers: c.maxWorkers,
    maxProposals: c.maxProposals,
    askTimeoutMinutes: c.askTimeoutMinutes,
    publicUrl: c.publicUrl,
    home: c.home,
    hold: { quietSeconds: c.hold.quietMs / 1000, capSeconds: c.hold.capMs / 1000 },
    sweep: { enabled: c.sweep.enabled, everyMinutes: c.sweep.everyMinutes },
    spend: { weeklyWarnUsd: c.spend.weeklyWarnUsd ?? null },
    needsRestart: [],
    ...(store.error === undefined ? {} : { error: store.error }),
  };
};

const scheduleOf = (store: ConfigStore): Schedule & { timeZone: string; error?: string } => {
  const c = store.current;
  return { timeZone: c.timeZone, scarce: rowsOf(c.gates.scarce, SCARCE_DEFAULT), leadIn: rowsOf(c.gates.leadIn, LEAD_IN_DEFAULT), leadInPercent: c.gates.leadInPercent, ...(store.error === undefined ? {} : { error: store.error }) };
};

/** A refusal in the form the pages read: the message beside each field, under `errors`, by the field's path. */
const refused = (error: z.ZodError) => new ApiResult(400, { errors: Object.fromEntries(error.issues.map((i) => [i.path.join(".") || "config", readableIssue(i)]).reverse()) });

export function registerSettingsRoutes(api: UiApi, d: SettingsDeps): void {
  api.route("GET", "/settings/general", () => publicOf(d.config));

  api.route("PUT", "/settings/general", async (req) => {
    // A value the page's own limits refuse is answered as the store's refusals are: the error beside the field, under `errors`.
    const parsed = generalSchema.partial().safeParse(req.body);
    if (!parsed.success) return refused(parsed.error);
    const { spend, ...rest } = parsed.data;
    // No warning is an explicit empty `spend` (an absent one means the default of 50 dollars).
    const patch = { ...rest, ...(spend === undefined ? {} : { spend: spend.weeklyWarnUsd === null ? {} : { weeklyWarnUsd: spend.weeklyWarnUsd } }) };
    const result = await d.config.save(patch);
    if (!result.ok) return new ApiResult(400, { errors: result.errors });
    d.announce({ applied: result.applied, needsRestart: result.needsRestart, fromFile: false });
    return { ...publicOf(d.config), applied: result.applied, needsRestart: result.needsRestart };
  });

  api.route("GET", "/settings/schedule", () => scheduleOf(d.config));

  api.route("PUT", "/settings/schedule", async (req) => {
    const parsed = scheduleSchema.partial().safeParse(req.body);
    if (!parsed.success) return refused(parsed.error);
    const current = scheduleOf(d.config);
    const next = { scarce: parsed.data.scarce ?? current.scarce, leadIn: parsed.data.leadIn ?? current.leadIn, leadInPercent: parsed.data.leadInPercent ?? current.leadInPercent };
    const problems = { ...windowProblems("scarce", next.scarce), ...windowProblems("leadIn", next.leadIn) };
    if (Object.keys(problems).length > 0) return new ApiResult(400, { errors: problems });
    const result = await d.config.save({ gates: { scarce: windowsOf(next.scarce), leadIn: windowsOf(next.leadIn), leadInPercent: next.leadInPercent } });
    if (!result.ok) return new ApiResult(400, { errors: result.errors });
    d.announce({ applied: result.applied, needsRestart: result.needsRestart, fromFile: false });
    return { ...scheduleOf(d.config), applied: result.applied, needsRestart: result.needsRestart };
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
    if (!result.ok) throw new ApiError(400, "The new order could not be saved. Try again.");
    d.reorder([...(d.config.current.home ? [HOME_CLOT] : []), ...sorted.map((c) => c.name)]);
    return { ok: true };
  });

  // Deleting a Clot: the name is typed in, the home Clot is refused, an account scoped to it must go first.
  api.route("DELETE", "/clots/:clot", async (req) => {
    const name = req.params.clot!;
    if (name === HOME_CLOT) throw new ApiError(409, "The home Clot cannot be deleted.");
    if (req.query.get("confirm") !== name) throw new ApiError(400, "Type the Clot's name to delete it.");
    const config = d.config.current;
    if (!config.clots.some((c) => c.name === name)) throw new ApiError(404, "That Clot could not be found.");
    if (d.building?.(name)) throw new ApiError(409, `${name} is being set up right now. Wait for that to finish.`);
    // From the file itself: an entry the loader left out as unusable still names the Clot, and would break once the Clot is gone.
    const sources = (d.config.json().sources ?? {}) as { email?: { account?: string; clot?: string }[]; composio?: { toolkit?: string; account?: string; clot?: string }[] };
    const users = [...(sources.email ?? []).filter((a) => a.clot === name).map((a) => `the inbox ${a.account}`), ...(sources.composio ?? []).filter((a) => a.clot === name).map((a) => `the tool ${a.toolkit}:${a.account}`)];
    if (users.length > 0) throw new ApiError(409, `${name} still has ${users.join(", ")}. Remove ${users.length === 1 ? "it" : "them"} first.`, { users });
    const result = await d.config.save({ clots: config.clots.filter((c) => c.name !== name) });
    if (!result.ok) throw new ApiError(400, "The Clot could not be removed. Try again.");
    await d.removeClot(name);
    return { ok: true };
  });
}
