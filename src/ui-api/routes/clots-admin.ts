import { z } from "zod";
import type { ConfigStore } from "../../config-store.js";
import type { ClotCreator } from "../../onboarding/create.js";
import { bytesOfDataUrl, IconError, type IconStore } from "../../onboarding/icons.js";
import { ApiError, ApiResult, parseBody, RawResult, type UiApi } from "../server.js";

const iconSchema = z.union([z.object({ phosphor: z.string().regex(/^[A-Z][A-Za-z0-9]{0,40}$/), color: z.string().min(1).max(30) }), z.object({ upload: z.string().regex(/^[a-f0-9]{16}$/) })]);
const validateSchema = z.object({ name: z.string().max(80), repo: z.string().max(200) });
// `toolJobs`: the connection jobs of services chosen in New Clot's Tools step; their entries are written with the Clot's own.
const createSchema = validateSchema.extend({ icon: iconSchema.optional(), toolJobs: z.array(z.string().min(1).max(64)).max(30).optional() });
const uploadSchema = z.object({ dataUrl: z.string().max(4_000_000) });

export interface AdminDeps {
  creator: ClotCreator;
  icons: IconStore;
  config: ConfigStore;
  /** The secret GitHub signs webhooks with, for the checklist's copy button. */
  webhookSecret: () => string;
  /** What the daemon can say of a Clot's onboarding. */
  onboarding: (name: string) => { id: string; done: boolean; detail: string }[];
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
    if (!png) throw new ApiError(404, "no such icon");
    return new RawResult("image/png", png);
  });

  // Editing a Clot: its icon and its repository. A Clot's name is fixed once it is made. A new repository is cloned into a fresh workspace
  // in the background (202, with `clot.build` events, the entry changing only once it has worked); the icon alone is saved at once.
  api.route("PUT", "/clots/:clot", async (req) => {
    const { icon, repo } = parseBody(z.object({ icon: iconSchema.optional(), repo: z.string().max(200).optional() }).refine((b) => b.icon !== undefined || b.repo !== undefined, "give an icon or a repository"), req.body);
    const name = req.params.clot!;
    const current = d.config.json().clots as { name: string }[];
    if (!current.some((c) => c.name === name)) throw new ApiError(404, "no such Clot");
    if (repo !== undefined) {
      const moved = await d.creator.changeRepo(name, repo, icon);
      if (!moved.ok) return new ApiResult(moved.status, { errors: moved.errors });
      if (moved.moving) return new ApiResult(202, { ok: true, moving: true });
    }
    if (icon !== undefined) {
      const result = await d.config.save({ clots: current.map((c) => (c.name === name ? { ...c, icon } : c)) });
      if (!result.ok) throw new ApiError(400, "the icon could not be saved");
    }
    return { ok: true };
  });

  // Read only when the user presses Copy: the secret is in no message and no list.
  api.route("GET", "/clots/:clot/webhook-secret", () => ({ secret: d.webhookSecret() }));

  api.route("GET", "/clots/:clot/onboarding", (req) => ({ items: d.onboarding(req.params.clot!) }));
}
