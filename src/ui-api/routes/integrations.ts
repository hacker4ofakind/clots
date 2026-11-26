import { configureBodySchema, inboxBodySchema, jobKeyBodySchema, type ToolView } from "@clots/ui-api-schemas";
import { isBuiltinToolkit } from "../../events/kinds.js";
import type { ConfigStore } from "../../config-store.js";
import { JobError, type IntegrationJobs } from "../../integrations/jobs.js";
import { isGmail, needServers, serversFor } from "../../email-providers.js";
import { ApiError, ApiResult, parseBody, type UiApi } from "../server.js";

/** The provider of an inbox, from the domain of its address: it picks the icon. */
export function providerOf(address: string): "Gmail" | "Email" {
  const domain = address.split("@")[1]?.toLowerCase() ?? "";
  return domain === "gmail.com" || domain === "googlemail.com" ? "Gmail" : "Email";
}

const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
/** The `.env` key for an inbox's password: `EMAIL_<ACCOUNT>_PASSWORD`, the account made safe for a key name. */
export const passwordKey = (account: string) => `EMAIL_${account.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_PASSWORD`;

type Endpoint = { host: string; port: number };

/**
 * The servers an inbox entry gets: those the form gave; else, on an edit that keeps the address's domain, the ones it already had; else
 * the provider's own, from the domain; else a refusal that says what to give. Gmail addresses need none (the loader knows them).
 */
function serversOf(body: { address: string; imap?: Endpoint; smtp?: Endpoint }, before?: { address?: unknown; imap?: unknown; smtp?: unknown }): { imap?: Endpoint; smtp?: Endpoint } | { error: string } {
  const domain = (a: string) => a.split("@")[1]?.toLowerCase();
  const kept = before !== undefined && typeof before.address === "string" && domain(before.address) === domain(body.address);
  const known = serversFor(body.address);
  const imap = body.imap ?? (kept ? (before!.imap as Endpoint | undefined) : undefined) ?? known?.imap;
  const smtp = body.smtp ?? (kept ? (before!.smtp as Endpoint | undefined) : undefined) ?? known?.smtp;
  if ((imap === undefined || smtp === undefined) && !isGmail(body.address)) return { error: needServers(body.address) };
  return { ...(imap === undefined || (isGmail(body.address) && body.imap === undefined) ? {} : { imap }), ...(smtp === undefined || (isGmail(body.address) && body.smtp === undefined) ? {} : { smtp }) };
}

export interface IntegrationRouteDeps {
  config: ConfigStore;
  /** The connecting-services jobs. Absent while the daemon has no Composio key: the routes that need Composio then say so. */
  jobs?: IntegrationJobs;
  /** What the daemon last read of a tool's connection, by `<toolkit>:<account>`. */
  statusOf?: (id: string) => ToolView["status"];
  /** Whether a built-in tool added since the daemon started still needs a restart to be wired. */
  restartNeeded?: (id: string) => boolean;
}

/** A refusal from the jobs becomes an answer with its status. */
async function answer<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof JobError) throw new ApiError(error.status, error.message);
    throw error;
  }
}

const NO_COMPOSIO = "Composio is not set up: put COMPOSIO_API_KEY in .env and restart the daemon.";

export function registerIntegrationRoutes(api: UiApi, d: IntegrationRouteDeps): void {
  const sourcesOf = () => d.config.json().sources as { email?: Record<string, unknown>[]; composio?: Record<string, unknown>[] } | undefined;
  const jobs = () => {
    if (d.jobs === undefined) throw new ApiError(503, NO_COMPOSIO);
    return d.jobs;
  };

  api.route("GET", "/integrations", () => {
    const c = d.config.current;
    return {
      inboxes: c.sources.email.map((a) => ({ account: a.account, address: a.address, clot: a.clot ?? null, shared: a.shared, provider: providerOf(a.address), mailboxes: a.mailboxes })),
      tools: c.sources.composio.map((a): ToolView => {
        const id = `${a.toolkit}:${a.account}`;
        const logo = d.jobs?.logoOf(a.toolkit);
        // What the entry says of how it was set up, for Edit settings to fill the options with: a built-in toolkit's events are not optional.
        const pollMinutes = a.pollMinutes ?? a.triggers.find((t) => t.pollMinutes !== undefined)?.pollMinutes;
        return { id, toolkit: a.toolkit, account: a.account, clot: a.clot ?? null, shared: a.shared, audience: a.audience, selfIsUser: a.selfIsUser, events: isBuiltinToolkit(a.toolkit) || a.triggers.length > 0, ...(pollMinutes === undefined ? {} : { pollMinutes }), ...(logo === undefined ? {} : { logo }), status: d.statusOf?.(id) ?? "unknown", ...(d.restartNeeded?.(id) ? { restartNeeded: true as const } : {}) };
      }),
    };
  });

  // ---- connecting a Composio toolkit

  api.route("GET", "/integrations/toolkits", (req) => answer(async () => ({ toolkits: await jobs().toolkits(req.query.get("q") ?? undefined) })));

  api.route("POST", "/integrations/configure", (req) => answer(async () => new ApiResult(201, { jobId: await jobs().configure(parseBody(configureBodySchema, req.body)) })));

  api.route("GET", "/integrations/jobs/:jobId", (req) => answer(async () => jobs().get(req.params.jobId!)));

  api.route("PUT", "/integrations/jobs/:jobId/key", (req) =>
    answer(async () => {
      await jobs().putKey(req.params.jobId!, parseBody(jobKeyBodySchema, req.body).value);
      return { ok: true };
    }),
  );

  api.route("POST", "/integrations/jobs/:jobId/abandon", (req) =>
    answer(async () => {
      await jobs().abandon(req.params.jobId!);
      return { ok: true };
    }),
  );

  api.route("POST", "/integrations/tools/:id/reconnect", (req) => answer(async () => ({ jobId: await jobs().reconnect(req.params.id!) })));

  api.route("DELETE", "/integrations/tools/:id", async (req) => {
    const sources = sourcesOf() ?? {};
    const composio = sources.composio ?? [];
    const found = composio.find((e) => `${String(e.toolkit)}:${String(e.account)}` === req.params.id);
    if (!found) throw new ApiError(404, "no such tool");
    const result = await d.config.save({ sources: { ...sources, composio: composio.filter((e) => e !== found) } });
    if (!result.ok) throw new ApiError(400, "the tool could not be removed");
    for (const key of [found.apiKey, found.apiKeyName].filter((k): k is string => typeof k === "string")) if (d.config.usersOf(key).length === 0) d.config.removeKey(key);
    return { ok: true, needsRestart: result.needsRestart.includes("sources") };
  });

  // ---- inboxes

  // An inbox: the password goes straight to .env, and the entry names its key.
  api.route("POST", "/inboxes", async (req) => {
    const body = parseBody(inboxBodySchema, req.body);
    if (body.password === undefined) throw new ApiError(400, "invalid request", { fieldErrors: { password: ["A password is needed."] } });
    const sources = sourcesOf() ?? {};
    const email = [...(sources.email ?? [])];
    // The form gives no name: the address's local part, made distinct when another address already took it (`me@gmail.com`, then `me@outlook.com`).
    let account = body.account;
    if (account === undefined) {
      const base = slug(body.address.split("@")[0]!).slice(0, 30) || "inbox";
      const sameAddress = email.find((e) => typeof e.address === "string" && e.address.toLowerCase() === body.address.toLowerCase());
      if (sameAddress !== undefined) throw new ApiError(409, `There is an inbox for ${body.address} already (${String(sameAddress.account)}).`);
      account = base;
      for (let n = 2; email.some((e) => e.account === account); n++) account = `${base}-${n}`;
    }
    if (email.some((e) => e.account === account)) throw new ApiError(409, `There is an inbox named ${account} already.`);
    const servers = serversOf(body);
    if ("error" in servers) return new ApiResult(400, { errors: { imap: servers.error } });
    const key = passwordKey(account);
    const undo = d.config.keyUndo(key);
    const written = d.config.setKey(key, body.password);
    if (!written.ok) throw new ApiError(400, written.error);
    const entry = { account, ...(body.clot === undefined ? { shared: true } : { clot: body.clot }), address: body.address, password: key, mailboxes: body.mailboxes, ...servers };
    const result = await d.config.save({ sources: { ...sources, email: [...email, entry] } });
    if (!result.ok) {
      undo();
      return new ApiResult(400, { errors: result.errors });
    }
    return new ApiResult(201, { account, provider: providerOf(body.address), needsRestart: result.needsRestart.includes("sources") });
  });

  // Edit: the same body as adding, the password optional (left out, the saved one stays). The account's name is fixed.
  api.route("PUT", "/inboxes/:account", async (req) => {
    const body = parseBody(inboxBodySchema, req.body);
    const account = req.params.account!;
    if (body.account !== undefined && body.account !== account) throw new ApiError(400, "An inbox keeps its name.");
    const sources = sourcesOf() ?? {};
    const email = sources.email ?? [];
    const found = email.find((e) => e.account === account);
    if (!found) throw new ApiError(404, "no such inbox");
    const servers = serversOf(body, found);
    if ("error" in servers) return new ApiResult(400, { errors: { imap: servers.error } });
    const key = typeof found.password === "string" ? found.password : passwordKey(account);
    // The password is written before the save, since the entry is checked against .env; a refused edit puts the old one back.
    let undo = () => {};
    if (body.password !== undefined) {
      undo = d.config.keyUndo(key);
      const written = d.config.setKey(key, body.password);
      if (!written.ok) throw new ApiError(400, written.error);
    }
    // The edit replaces what the form holds; what it does not hold (other addresses, whether the address is told) stays.
    const { clot: _clot, shared: _shared, imap: _imap, smtp: _smtp, ...kept } = found;
    const entry = { ...kept, account, ...(body.clot === undefined ? { shared: true } : { clot: body.clot }), address: body.address, password: key, mailboxes: body.mailboxes, ...servers };
    const result = await d.config.save({ sources: { ...sources, email: email.map((e) => (e === found ? entry : e)) } });
    if (!result.ok) {
      undo();
      return new ApiResult(400, { errors: result.errors });
    }
    return { account, provider: providerOf(body.address), needsRestart: result.needsRestart.includes("sources") };
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
    return { ok: true, needsRestart: result.needsRestart.includes("sources") };
  });
}
