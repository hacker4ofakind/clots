import { z } from "zod";
import type { ConfigStore } from "../../config-store.js";
import { ApiError, ApiResult, parseBody, type UiApi } from "../server.js";

/** The provider of an inbox, from the domain of its address: it picks the icon. */
export function providerOf(address: string): "Gmail" | "Email" {
  const domain = address.split("@")[1]?.toLowerCase() ?? "";
  return domain === "gmail.com" || domain === "googlemail.com" ? "Gmail" : "Email";
}

const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
/** The `.env` key for an inbox's password: `EMAIL_<ACCOUNT>_PASSWORD`, the account made safe for a key name. */
export const passwordKey = (account: string) => `EMAIL_${account.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_PASSWORD`;

const inboxSchema = z.object({
  address: z.email().max(200),
  account: z.string().regex(/^[a-z][a-z0-9-]{0,30}$/).optional(),
  password: z.string().min(1).max(500),
  mailboxes: z.array(z.string().min(1).max(100)).min(1).max(10).default(["INBOX"]),
  clot: z.string().optional(),
  imap: z.object({ host: z.string().min(1).max(200), port: z.number().int().min(1).max(65535) }).optional(),
  smtp: z.object({ host: z.string().min(1).max(200), port: z.number().int().min(1).max(65535) }).optional(),
});

export function registerIntegrationRoutes(api: UiApi, d: { config: ConfigStore; logoOf?: (toolkit: string) => string | undefined }): void {
  const sourcesOf = () => d.config.json().sources as { email?: Record<string, unknown>[]; composio?: Record<string, unknown>[] } | undefined;

  api.route("GET", "/integrations", () => {
    const c = d.config.current;
    return {
      inboxes: c.sources.email.map((a) => ({ account: a.account, address: a.address, clot: a.clot ?? null, shared: a.shared, provider: providerOf(a.address) })),
      tools: c.sources.composio.map((a) => ({ id: `${a.toolkit}:${a.account}`, toolkit: a.toolkit, account: a.account, clot: a.clot ?? null, shared: a.shared, audience: a.audience, ...(d.logoOf?.(a.toolkit) === undefined ? {} : { logo: d.logoOf(a.toolkit) }) })),
    };
  });

  // An inbox: the password goes straight to .env, and the entry names its key.
  api.route("POST", "/inboxes", async (req) => {
    const body = parseBody(inboxSchema, req.body);
    const account = body.account ?? (slug(body.address.split("@")[0]!).slice(0, 30) || "inbox");
    const sources = sourcesOf() ?? {};
    const email = [...(sources.email ?? [])];
    if (email.some((e) => e.account === account)) throw new ApiError(409, `There is an inbox named ${account} already.`);
    const key = passwordKey(account);
    const written = d.config.setKey(key, body.password);
    if (!written.ok) throw new ApiError(400, written.error);
    const entry = { account, ...(body.clot === undefined ? { shared: true } : { clot: body.clot }), address: body.address, password: key, mailboxes: body.mailboxes, ...(body.imap ? { imap: body.imap } : {}), ...(body.smtp ? { smtp: body.smtp } : {}) };
    const result = await d.config.save({ sources: { ...sources, email: [...email, entry] } });
    if (!result.ok) {
      d.config.removeKey(key);
      return new ApiResult(400, { errors: result.errors });
    }
    return new ApiResult(201, { account, provider: providerOf(body.address) });
  });

  api.route("DELETE", "/inboxes/:account", async (req) => {
    const sources = sourcesOf() ?? {};
    const email = sources.email ?? [];
    const found = email.find((e) => e.account === req.params.account);
    if (!found) throw new ApiError(404, "no such inbox");
    const result = await d.config.save({ sources: { ...sources, email: email.filter((e) => e !== found) } });
    if (!result.ok) throw new ApiError(400, "the inbox could not be removed");
    // The password goes with it when nothing else names it.
    if (typeof found.password === "string" && d.config.usersOf(found.password).length === 0) d.config.removeKey(found.password);
    return { ok: true };
  });

  api.route("DELETE", "/integrations/tools/:id", async (req) => {
    const sources = sourcesOf() ?? {};
    const composio = sources.composio ?? [];
    const found = composio.find((e) => `${String(e.toolkit)}:${String(e.account)}` === req.params.id);
    if (!found) throw new ApiError(404, "no such tool");
    const result = await d.config.save({ sources: { ...sources, composio: composio.filter((e) => e !== found) } });
    if (!result.ok) throw new ApiError(400, "the tool could not be removed");
    for (const key of [found.apiKey, found.apiKeyName].filter((k): k is string => typeof k === "string")) if (d.config.usersOf(key).length === 0) d.config.removeKey(key);
    return { ok: true };
  });
}
