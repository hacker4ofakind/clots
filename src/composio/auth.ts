import crypto from "node:crypto";
import type { ComposioAccount } from "../config.js";

/** What Composio says of a toolkit's way of connecting, read once per toolkit per daemon life. */
export interface ToolkitInfo {
  slug: string;
  /** Composio's display name, for the sign-in message. */
  name: string;
  /** The schemes Composio has its own app for (`OAUTH2`, ...). */
  managed: string[];
  /** Every scheme the toolkit accepts, with the names of the fields a connection needs and may take. */
  schemes: {
    scheme: string;
    required: string[];
    optional: string[];
    /** Fields an auth config of this scheme needs (a user's own OAuth app needs client_id and client_secret). */
    creationRequired: string[];
  }[];
  /** A toolkit that needs no connection at all. */
  noAuth?: boolean;
}

/** One toolkit's `toolkits.get` answer as `ToolkitInfo`. */
export function toolkitInfoFrom(raw: any): ToolkitInfo {
  const names = (list: any): string[] => (Array.isArray(list) ? list.map((f: any) => String(f?.name)).filter((n) => n !== "undefined") : []);
  return {
    slug: String(raw?.slug ?? "").toLowerCase(),
    name: String(raw?.name ?? raw?.slug ?? ""),
    managed: (raw?.composioManagedAuthSchemes ?? []).map(String),
    // A toolkit that needs no connection lists the scheme NO_AUTH (found live on hackernews); it is not a way of connecting.
    schemes: (raw?.authConfigDetails ?? [])
      .filter((d: any) => d?.mode !== "NO_AUTH")
      .map((d: any) => ({
        scheme: String(d?.mode),
        required: names(d?.fields?.connectedAccountInitiation?.required),
        optional: names(d?.fields?.connectedAccountInitiation?.optional),
        creationRequired: names(d?.fields?.authConfigCreation?.required),
      })),
    ...((raw?.authConfigDetails ?? []).some((d: any) => d?.mode === "NO_AUTH") || raw?.noAuth === true ? { noAuth: true } : {}),
  };
}

/**
 * How an account connects. `key` and `oauthApp` name `.env` keys, never values: the values go to Composio
 * in `connectWithKey` and `ensureAuthConfig` and nowhere else. `none`: the toolkit needs no connection.
 */
export type AuthChoice =
  | { kind: "managed" }
  | { kind: "none" }
  | { kind: "key"; scheme: string; /** Composio's field name → the `.env` key holding its value. */ fields: Record<string, string> }
  | { kind: "oauthApp"; clientId: string; clientSecret: string };

/** What the choice reads of an account's entry. */
export type AuthEntry = Pick<ComposioAccount, "toolkit" | "account" | "apiKeyName" | "fieldKeys" | "scheme" | "oauthApp">;

const isOAuth = (scheme: string) => scheme.startsWith("OAUTH");

/** What the toolkit accepts, in the order the error text lists it. */
function acceptedText(info: ToolkitInfo): string {
  if (info.noAuth === true) return `${info.name} needs no connection`;
  const parts = info.schemes.map((s) => {
    if (!isOAuth(s.scheme)) return s.required.length > 0 ? `${s.scheme} (fields: ${s.required.join(", ")})` : s.scheme;
    return info.managed.includes(s.scheme) ? `${s.scheme} (Composio's sign-in)` : `${s.scheme} (your own OAuth app: oauthApp)`;
  });
  return `${info.name} accepts: ${parts.join(", ") || "nothing Composio offers"}`;
}

/**
 * The way to connect an account, from its entry and what Composio says of its toolkit, or why it cannot. Pure.
 * `provided` names the fields the toolkit's def adds itself (PostHog's `subdomain`), which an entry need not give.
 */
export function chooseAuth(a: AuthEntry, info: ToolkitInfo, provided: string[] = []): AuthChoice | { error: string } {
  const fail = (reason: string) => ({ error: `${a.toolkit}:${a.account} cannot connect: ${reason}. ${acceptedText(info)}.` });
  const gave = a.apiKeyName !== undefined || a.fieldKeys !== undefined;

  if (a.oauthApp !== undefined) {
    const oauth = info.schemes.find((s) => isOAuth(s.scheme));
    if (oauth === undefined) return fail(`${info.name} has no OAuth scheme, so oauthApp does not apply`);
    const missing = oauth.creationRequired.filter((n) => n !== "client_id" && n !== "client_secret");
    if (missing.length > 0) return fail(`an OAuth app for ${info.name} also needs ${missing.join(", ")}, which an entry cannot give`);
    return { kind: "oauthApp", clientId: a.oauthApp.clientId, clientSecret: a.oauthApp.clientSecret };
  }

  if (gave) {
    if (info.noAuth === true) return fail(`${info.name} needs no connection, so the entry should not name a key`);
    const keySchemes = info.schemes.filter((s) => !isOAuth(s.scheme));
    if (keySchemes.length === 0) return fail(`${info.name} has no key scheme${info.managed.length > 0 ? ", only Composio's sign-in" : ""}, so apiKey and fields do not apply`);
    let scheme = keySchemes[0];
    if (a.scheme !== undefined) {
      const found = keySchemes.find((s) => s.scheme === a.scheme);
      if (found === undefined) return fail(`${info.name} has no key scheme ${a.scheme}`);
      scheme = found;
    } else if (keySchemes.length > 1) {
      return fail(`${info.name} has several key schemes (${keySchemes.map((s) => s.scheme).join(", ")}); say which with scheme`);
    }
    const needed = scheme.required.filter((n) => !provided.includes(n));
    if (a.fieldKeys !== undefined) {
      const named = Object.keys(a.fieldKeys);
      const unknown = named.filter((n) => !scheme.required.includes(n) && !scheme.optional.includes(n));
      if (unknown.length > 0) return fail(`${scheme.scheme} has no field ${unknown.join(", ")}`);
      const absent = needed.filter((n) => !named.includes(n));
      if (absent.length > 0) return fail(`${scheme.scheme} needs the field${absent.length === 1 ? "" : "s"} ${absent.join(", ")}`);
      return { kind: "key", scheme: scheme.scheme, fields: { ...a.fieldKeys } };
    }
    if (needed.length !== 1) return fail(needed.length === 0 ? `${scheme.scheme} takes no key field` : `${scheme.scheme} needs ${needed.length} fields (${needed.join(", ")}), so apiKey cannot fill them; use fields`);
    return { kind: "key", scheme: scheme.scheme, fields: { [needed[0]]: a.apiKeyName! } };
  }

  if (info.noAuth === true) return { kind: "none" };
  const sign = info.schemes.find((s) => isOAuth(s.scheme) && info.managed.includes(s.scheme));
  if (sign === undefined) return fail(`${info.name} has no sign-in Composio manages, so the entry needs apiKey, fields or oauthApp`);
  if (sign.required.length > 0) return fail(`Composio's sign-in for ${info.name} needs ${sign.required.join(", ")}, which a sign-in link cannot give`);
  return { kind: "managed" };
}

const sha256 = (text: string) => crypto.createHash("sha256").update(text).digest("hex");

/** SHA-256 of a service key, to tell that it changed without keeping it. */
export function keyHash(key: string): string {
  return sha256(key);
}

/** The `.env` values an account's entry names, by key: what `AuthChoice`'s names stand for. Never logged or stored. */
export function secretsOf(a: Pick<ComposioAccount, "apiKey" | "apiKeyName" | "fields" | "fieldKeys" | "oauthApp" | "oauthValues">): Record<string, string> {
  const out: Record<string, string> = {};
  if (a.apiKeyName !== undefined && a.apiKey !== undefined) out[a.apiKeyName] = a.apiKey;
  for (const [field, key] of Object.entries(a.fieldKeys ?? {})) if (a.fields?.[field] !== undefined) out[key] = a.fields[field];
  if (a.oauthApp !== undefined && a.oauthValues !== undefined) {
    out[a.oauthApp.clientId] = a.oauthValues.clientId;
    out[a.oauthApp.clientSecret] = a.oauthValues.clientSecret;
  }
  return out;
}

/**
 * A hash of what an account connects with, so that a change of any value replaces the connection. A lone
 * `generic_api_key` keeps the formula of stage 2e (the hash of the key), so upgrading replaces nothing.
 */
export function authHash(choice: AuthChoice, secrets: Record<string, string>): string {
  if (choice.kind === "managed" || choice.kind === "none") return choice.kind;
  if (choice.kind === "oauthApp") return `oauth:${sha256(JSON.stringify([secrets[choice.clientId], secrets[choice.clientSecret]]))}`;
  const pairs = Object.entries(choice.fields)
    .sort(([x], [y]) => (x < y ? -1 : 1))
    .map(([name, key]) => [name, secrets[key]]);
  if (choice.scheme === "API_KEY" && pairs.length === 1 && pairs[0][0] === "generic_api_key") return keyHash(String(pairs[0][1]));
  return sha256(JSON.stringify([choice.scheme, ...pairs]));
}

/** The fields a key connection is made with: the entry's values by field name. */
export function fieldValues(choice: Extract<AuthChoice, { kind: "key" }>, secrets: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(choice.fields).map(([name, key]) => [name, secrets[key]]));
}

/** What the entry's auth fields are called, not what they hold: a change makes the choice be made again. */
export function entryAuthKey(a: AuthEntry): string {
  return sha256(JSON.stringify([a.apiKeyName ?? null, a.fieldKeys ?? null, a.scheme ?? null, a.oauthApp ?? null]));
}
