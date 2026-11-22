import { describe, expect, it } from "vitest";
import { authHash, chooseAuth, entryAuthKey, keyHash, secretsOf, toolkitInfoFrom, type AuthEntry } from "../src/composio/auth.js";
import { toolkitMeta } from "./fake-composio.js";

const info = (slug: string) => toolkitMeta(slug).info;
const entry = (toolkit: string, over: Partial<AuthEntry> = {}): AuthEntry => ({ toolkit, account: "work", ...over });

describe("chooseAuth", () => {
  it("connects Slack through Composio's sign-in when the entry gives no key", () => {
    expect(chooseAuth(entry("slack"), info("slack"))).toEqual({ kind: "managed" });
  });

  it("refuses a Slack key, naming Composio's sign-in as what Slack accepts", () => {
    expect(chooseAuth(entry("slack", { apiKeyName: "SLACK_KEY" }), info("slack"))).toEqual({
      error: "slack:work cannot connect: Slack has no key scheme, only Composio's sign-in, so apiKey and fields do not apply. Slack accepts: OAUTH2 (Composio's sign-in).",
    });
  });

  it("gives Supabase's two-field key from fields, naming both", () => {
    const choice = chooseAuth(entry("supabase", { fieldKeys: { full: "SB_URL", bearer_token: "SB_KEY" } }), info("supabase"));
    expect(choice).toEqual({ kind: "key", scheme: "API_KEY", fields: { full: "SB_URL", bearer_token: "SB_KEY" } });
  });

  it("refuses a single apiKey for Supabase, naming full and bearer_token and fields", () => {
    const choice = chooseAuth(entry("supabase", { apiKeyName: "SB_KEY" }), info("supabase")) as { error: string };
    expect(choice.error).toContain("API_KEY needs 2 fields (full, bearer_token), so apiKey cannot fill them; use fields");
    expect(choice.error).toContain("Supabase accepts: OAUTH2 (Composio's sign-in), API_KEY (fields: full, bearer_token).");
  });

  it("refuses fields that miss a required field or name one the scheme lacks", () => {
    expect((chooseAuth(entry("supabase", { fieldKeys: { full: "SB_URL" } }), info("supabase")) as { error: string }).error).toContain("API_KEY needs the field bearer_token");
    expect((chooseAuth(entry("supabase", { fieldKeys: { full: "A", bearer_token: "B", extra: "C" } }), info("supabase")) as { error: string }).error).toContain("API_KEY has no field extra");
  });

  it("refuses Supabase's managed sign-in, which needs a field a link cannot give", () => {
    expect((chooseAuth(entry("supabase"), info("supabase")) as { error: string }).error).toContain("needs full, which a sign-in link cannot give");
  });

  it("connects Reddit through the managed sign-in", () => {
    expect(chooseAuth(entry("reddit"), info("reddit"))).toEqual({ kind: "managed" });
  });

  it("fills a one-field key under the field's own name", () => {
    expect(chooseAuth(entry("linear", { apiKeyName: "LINEAR_KEY" }), info("linear"))).toEqual({ kind: "key", scheme: "API_KEY", fields: { generic_api_key: "LINEAR_KEY" } });
  });

  it("uses the user's own OAuth app where the toolkit has OAuth, and not where it has none", () => {
    const own = { clientId: "SLACK_ID", clientSecret: "SLACK_SECRET" };
    expect(chooseAuth(entry("slack", { oauthApp: own }), info("slack"))).toEqual({ kind: "oauthApp", ...own });
    const noOauth = { slug: "x", name: "X", managed: [], schemes: [{ scheme: "API_KEY", required: ["generic_api_key"], optional: [], creationRequired: [] }] };
    expect((chooseAuth(entry("x", { oauthApp: own }), noOauth) as { error: string }).error).toContain("X has no OAuth scheme");
  });

  it("refuses an OAuth app whose auth config needs more than the client ID and secret, naming it", () => {
    const odd = { slug: "odd", name: "Odd", managed: [], schemes: [{ scheme: "OAUTH2", required: [], optional: [], creationRequired: ["client_id", "client_secret", "tenant"] }] };
    expect((chooseAuth(entry("odd", { oauthApp: { clientId: "A", clientSecret: "B" } }), odd) as { error: string }).error).toContain("also needs tenant");
  });

  it("refuses an entry for a toolkit with no managed app and no key given, saying what to add", () => {
    const bare = { slug: "bare", name: "Bare", managed: [], schemes: [{ scheme: "OAUTH2", required: [], optional: [], creationRequired: ["client_id", "client_secret"] }] };
    const error = (chooseAuth(entry("bare"), bare) as { error: string }).error;
    expect(error).toContain("Bare has no sign-in Composio manages, so the entry needs apiKey, fields or oauthApp");
    expect(error).toContain("OAUTH2 (your own OAuth app: oauthApp)");
  });

  it("needs a scheme when a toolkit has several key schemes, and refuses one it lacks", () => {
    const many = { slug: "m", name: "M", managed: [], schemes: [{ scheme: "API_KEY", required: ["generic_api_key"], optional: [], creationRequired: [] }, { scheme: "BEARER_TOKEN", required: ["token"], optional: [], creationRequired: [] }] };
    expect((chooseAuth(entry("m", { apiKeyName: "K" }), many) as { error: string }).error).toContain("say which with scheme");
    expect(chooseAuth(entry("m", { apiKeyName: "K", scheme: "BEARER_TOKEN" }), many)).toEqual({ kind: "key", scheme: "BEARER_TOKEN", fields: { token: "K" } });
    expect((chooseAuth(entry("m", { apiKeyName: "K", scheme: "BASIC" }), many) as { error: string }).error).toContain("has no key scheme BASIC");
  });

  it("needs no connection for a toolkit that has none (hackernews), and refuses a key for it", () => {
    expect(chooseAuth(entry("hackernews"), info("hackernews"))).toEqual({ kind: "none" });
    expect((chooseAuth(entry("hackernews", { apiKeyName: "K" }), info("hackernews")) as { error: string }).error).toContain("needs no connection");
  });
});

describe("every built-in toolkit resolves to what it uses today", () => {
  const key = (toolkit: string) => chooseAuth(entry(toolkit, { apiKeyName: "K" }), info(toolkit));

  it.each(["linear", "notion", "stripe"])("%s: its API_KEY scheme, field generic_api_key", (toolkit) => {
    expect(key(toolkit)).toEqual({ kind: "key", scheme: "API_KEY", fields: { generic_api_key: "K" } });
  });

  it("the calendar: Composio's sign-in", () => {
    expect(chooseAuth(entry("googlecalendar"), info("googlecalendar"))).toEqual({ kind: "managed" });
  });

  it("keeps the hash of a lone generic_api_key as stage 2e made it, so upgrading replaces nothing", () => {
    const choice = key("linear") as never;
    expect(authHash(choice, { K: "lin_api_SECRET" })).toBe(keyHash("lin_api_SECRET"));
  });
});

describe("connect: connection fields given in the entry itself", () => {
  const posthog = (over: Partial<AuthEntry> = {}) => chooseAuth(entry("posthog", { apiKeyName: "K", connect: { subdomain: "eu" }, ...over }), info("posthog"));

  it("counts a name in connect as given, so apiKey fills the one field left (PostHog: generic_api_key, with the region in connect)", () => {
    expect(posthog()).toEqual({ kind: "key", scheme: "API_KEY", fields: { generic_api_key: "K" } });
  });

  it("without connect the key still cannot fill PostHog's two fields", () => {
    expect((chooseAuth(entry("posthog", { apiKeyName: "K" }), info("posthog")) as { error: string }).error).toContain("API_KEY needs 2 fields (subdomain, generic_api_key), so apiKey cannot fill them");
  });

  it("refuses a name the scheme does not have, and one that is also named in fields", () => {
    expect((posthog({ connect: { subdomian: "eu" } }) as { error: string }).error).toContain("API_KEY has no field subdomian");
    const both = chooseAuth(entry("posthog", { fieldKeys: { generic_api_key: "K", subdomain: "S" }, connect: { subdomain: "eu" } }), info("posthog")) as { error: string };
    expect(both.error).toContain("subdomain is named in both fields and connect");
  });

  it("works with fields too: connect names count as given there as well", () => {
    expect(chooseAuth(entry("supabase", { fieldKeys: { bearer_token: "SB_KEY" }, connect: { full: "https://x.supabase.co" } }), info("supabase"))).toEqual({ kind: "key", scheme: "API_KEY", fields: { bearer_token: "SB_KEY" } });
  });

  it("does not apply to a connection that is not a key", () => {
    expect((chooseAuth(entry("slack", { connect: { x: "y" } }), info("slack")) as { error: string }).error).toContain("connect gives fields of a key connection");
    expect((chooseAuth(entry("slack", { connect: { x: "y" }, oauthApp: { clientId: "A", clientSecret: "B" } }), info("slack")) as { error: string }).error).toContain("connect gives fields of a key connection");
  });

  it("is not in the connection's hash, so changing it replaces nothing, and a lone generic_api_key keeps its 2e hash", () => {
    const choice = posthog() as never;
    expect(authHash(choice, { K: "phx_SECRET" })).toBe(keyHash("phx_SECRET"));
  });

  it("is in the entry's auth key by its names, so a new name makes the choice be made again, and its values do not", () => {
    const base = entryAuthKey(entry("posthog", { apiKeyName: "K" }));
    expect(entryAuthKey(entry("posthog", { apiKeyName: "K", connect: { subdomain: "eu" } }))).not.toBe(base);
    expect(entryAuthKey(entry("posthog", { apiKeyName: "K", connect: { subdomain: "eu" } }))).toBe(entryAuthKey(entry("posthog", { apiKeyName: "K", connect: { subdomain: "us" } })));
  });
});

describe("authHash", () => {
  const supabase = { kind: "key", scheme: "API_KEY", fields: { full: "URL", bearer_token: "KEY" } } as const;

  it("changes when any one field's value does, and not with the order the fields were named in", () => {
    const base = authHash(supabase, { URL: "u", KEY: "k" });
    expect(authHash(supabase, { URL: "u2", KEY: "k" })).not.toBe(base);
    expect(authHash(supabase, { URL: "u", KEY: "k2" })).not.toBe(base);
    expect(authHash({ kind: "key", scheme: "API_KEY", fields: { bearer_token: "KEY", full: "URL" } }, { URL: "u", KEY: "k" })).toBe(base);
  });

  it("tells an OAuth app's values apart, and managed from the rest", () => {
    const app = { kind: "oauthApp", clientId: "ID", clientSecret: "SECRET" } as const;
    expect(authHash(app, { ID: "a", SECRET: "b" })).not.toBe(authHash(app, { ID: "a", SECRET: "c" }));
    expect(authHash(app, { ID: "a", SECRET: "b" })).toMatch(/^oauth:/);
    expect(authHash({ kind: "managed" }, {})).toBe("managed");
  });

  it("never holds a value in the entry's own key, which only names the fields", () => {
    expect(entryAuthKey(entry("supabase", { fieldKeys: { full: "URL" } }))).toBe(entryAuthKey(entry("supabase", { fieldKeys: { full: "URL" } })));
    expect(entryAuthKey(entry("supabase", { fieldKeys: { full: "URL" } }))).not.toBe(entryAuthKey(entry("supabase", { fieldKeys: { full: "OTHER" } })));
  });

  it("collects the values an entry names by their .env key", () => {
    expect(secretsOf({ fieldKeys: { full: "URL" }, fields: { full: "u" }, oauthApp: { clientId: "ID", clientSecret: "S" }, oauthValues: { clientId: "a", clientSecret: "b" } })).toEqual({ URL: "u", ID: "a", S: "b" });
  });
});

describe("toolkitInfoFrom", () => {
  it("reads the recorded Slack answer: one managed scheme, no required connection field", () => {
    expect(info("slack")).toMatchObject({ slug: "slack", name: "Slack", managed: ["OAUTH2"], schemes: [{ scheme: "OAUTH2", required: [], optional: ["generic_id"], creationRequired: ["client_id", "client_secret"] }] });
  });

  it("does not list NO_AUTH as a way of connecting", () => {
    expect(toolkitInfoFrom({ slug: "x", name: "X", authConfigDetails: [{ mode: "NO_AUTH", fields: {} }] })).toEqual({ slug: "x", name: "X", managed: [], schemes: [], noAuth: true });
  });
});
