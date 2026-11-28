import { z } from "zod";
import type { ConfigStore } from "../../config-store.js";
import type { ClotCreator } from "../../onboarding/create.js";
import { bytesOfDataUrl, IconError, type IconStore } from "../../onboarding/icons.js";
import { ApiError, ApiResult, parseBody, RawResult, type UiApi } from "../server.js";

const iconSchema = z.union([z.object({ phosphor: z.string().regex(/^[A-Z][A-Za-z0-9]{0,40}$/), color: z.string().min(1).max(30) }), z.object({ upload: z.string().regex(/^[a-f0-9]{16}$/) })]);
const validateSchema = z.object({ name: z.string().max(80), repo: z.string().max(200) });
// `toolJobs`: the connection jobs of services chosen in New Clot's Tools step; their entries are written with the Clot's own.
const createSchema = validateSchema.extend({ icon: iconSchema.optional(), toolJobs: z.array(z.string().min(1).max(64)).max(30).optional() });
const editSchema = z
  .object({
    icon: iconSchema.optional(),
    repo: z.string().max(200).optional(),
    about: z.string().trim().max(300, "Keep it to 300 characters.").optional(),
    testCommand: z.string().trim().max(500, "Keep it to 500 characters.").optional(),
  })
  .refine((b) => b.icon !== undefined || b.repo !== undefined || b.about !== undefined || b.testCommand !== undefined, "give an icon, a repository, a description or a test command");

/** A Clot's entry with its description and test command set; an empty text removes the key. */
function withText<T extends object>(entry: T, text: { about?: string; testCommand?: string }): T {
  const next = { ...entry } as Record<string, unknown>;
  for (const [key, value] of Object.entries(text)) {
    if (value === undefined) continue;
    if (value === "") delete next[key];
    else next[key] = value;
  }
  return next as T;
}

const uploadSchema = z.object({ dataUrl: z.string().max(4_000_000) });

export interface AdminDeps {
  creator: ClotCreator;
  icons: IconStore;
  config: ConfigStore;
  /** The secret GitHub signs webhooks with, for the checklist's copy button. */
  webhookSecret: () => string;
  /** What the daemon can say of a Clot's onboarding. */
  onboarding: (name: string) => { id: string; done: boolean; detail: string }[];
  /** Opens a Clot's webhook step again: forgets GitHub's ping for its repository. */
  resetWebhook: (name: string) => void;
}

export function registerClotAdminRoutes(api: UiApi, d: AdminDeps): void {
  api.route("POST", "/clots/validate", async (req) => d.creator.validate(parseBody(validateSchema, req.body)).then(({ access: _access, ...rest }) => rest));

  api.route("POST", "/clots", async (req) => {
    const result = await d.creator.create(parseBody(createSchema, req.body));
    return result.ok ? new ApiResult(202, { ok: true }) : new ApiResult(400, { errors: result.errors });
  });

  api.route("GET", "/clots/:clot/build", (req) => {
    const build = d.creator.buildOf(req.params.clot!);
    if (build === undefined) throw new ApiError(404, "No build is kept for this Clot.");
    return build;
  });

  api.route("POST", "/clots/:clot/retry", async (req) => {
    if (!(await d.creator.retry(req.params.clot!))) throw new ApiError(409, "Nothing to retry for this Clot.");
    return new ApiResult(202, { ok: true });
  });

  // An uploaded icon: an image or an SVG, as a data URL. What is stored is a PNG drawn from it, never the upload itself.
  api.route(
    "POST",
    "/clots/icons",
    async (req) => {
      const { dataUrl } = parseBody(uploadSchema, req.body);
      try {
        return new ApiResult(201, { iconId: await d.icons.add(bytesOfDataUrl(dataUrl)) });
      } catch (error) {
        if (error instanceof IconError) throw new ApiError(400, error.message);
        throw error;
      }
    },
    { maxBytes: 4 * 1024 * 1024 },
  );

  api.route("GET", "/clots/icons/:id", (req) => {
    const png = d.icons.read(req.params.id!, req.query.get("variant") === "active");
    if (!png) throw new ApiError(404, "That icon could not be found.");
    return new RawResult("image/png", png);
  });

  // Editing a Clot: its icon and its repository. A Clot's name is fixed once it is made. A new repository is cloned into a fresh workspace
  // in the background (202, with `clot.build` events, the entry changing only once it has worked); the icon alone is saved at once.
  api.route("PUT", "/clots/:clot", async (req) => {
    const { icon, repo, about, testCommand } = parseBody(editSchema, req.body);
    const name = req.params.clot!;
    const current = d.config.json().clots as { name: string }[];
    if (!current.some((c) => c.name === name)) throw new ApiError(404, "That Clot could not be found.");
    // The one-line description and the test command are only the Clot's entry: saved at once, whatever else the edit does. An empty one clears it.
    if (about !== undefined || testCommand !== undefined) {
      const result = await d.config.save({ clots: current.map((c) => (c.name === name ? withText(c, { about, testCommand }) : c)) });
      if (!result.ok) return new ApiResult(400, { errors: result.errors });
    }
    if (repo !== undefined) {
      const moved = await d.creator.changeRepo(name, repo, icon);
      if (!moved.ok) return new ApiResult(moved.status, { errors: moved.errors });
      if (moved.moving) return new ApiResult(202, { ok: true, moving: true });
    }
    if (icon !== undefined) {
      const latest = d.config.json().clots as { name: string }[];
      const result = await d.config.save({ clots: latest.map((c) => (c.name === name ? { ...c, icon } : c)) });
      if (!result.ok) throw new ApiError(400, "The icon could not be saved. Try again.");
    }
    return { ok: true };
  });

  // What Edit shows besides the icon and the repository: the one-line description and the test command, as the file has them.
  api.route("GET", "/clots/:clot/settings", (req) => {
    const entry = (d.config.json().clots as { name: string; about?: string; testCommand?: string }[]).find((c) => c.name === req.params.clot);
    if (!entry) throw new ApiError(404, "That Clot could not be found.");
    return { about: entry.about ?? "", testCommand: entry.testCommand ?? "" };
  });

  // Read only when the user presses Copy: the secret is in no message and no list.
  api.route("GET", "/clots/:clot/webhook-secret", () => ({ secret: d.webhookSecret() }));

  api.route("GET", "/clots/:clot/onboarding", (req) => ({ items: d.onboarding(req.params.clot!) }));

  // The webhook step's redo: a deleted webhook (or a Clot remade on the same repository) leaves GitHub's old ping ticked, so the user can clear it.
  api.route("POST", "/clots/:clot/onboarding/webhook/reset", (req) => {
    d.resetWebhook(req.params.clot!);
    return { items: d.onboarding(req.params.clot!) };
  });
}
