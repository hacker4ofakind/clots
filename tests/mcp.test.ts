import { beforeEach, describe, expect, it } from "vitest";
import { LoginNeeded, McpHub, oauthCallbackHandler, type McpSession, type Opener } from "../src/mcp/hub.js";
import { consumeLoginState, LOGIN_TTL_MS, StoredOAuth } from "../src/mcp/oauth.js";
import { Store } from "../src/store.js";

let store: Store;
let now: number;
let links: string[];
const oauth = () => new StoredOAuth({ server: "notion", store, redirectUrl: "https://box.example.ts.net/oauth/callback", now: () => now, onLink: (url) => void links.push(url) });

beforeEach(() => {
  store = new Store(":memory:");
  now = 1_000_000;
  links = [];
});

describe("StoredOAuth", () => {
  it("registers with the daemon's callback, and keeps the client, the tokens and the verifier across restarts", () => {
    const first = oauth();
    expect(first.redirectUrl).toBe("https://box.example.ts.net/oauth/callback");
    expect(first.clientMetadata).toMatchObject({ client_name: "Clots", redirect_uris: ["https://box.example.ts.net/oauth/callback"], token_endpoint_auth_method: "none" });
    first.saveClientInformation({ client_id: "c1", redirect_uris: ["https://box.example.ts.net/oauth/callback"] } as never);
    first.saveTokens({ access_token: "a", token_type: "Bearer", refresh_token: "r" });
    first.saveCodeVerifier("v");
    const again = oauth();
    expect(again.clientInformation()).toMatchObject({ client_id: "c1" });
    expect(again.tokens()).toMatchObject({ access_token: "a", refresh_token: "r" });
    expect(again.codeVerifier()).toBe("v");
    expect(again.loggedIn()).toBe(true);
    again.invalidateCredentials("tokens");
    expect(again.tokens()).toBeUndefined();
    expect(again.clientInformation()).toBeDefined();
  });

  it("hands the login link on, and makes a state that can be used once, within ten minutes", () => {
    const provider = oauth();
    provider.redirectToAuthorization(new URL("https://mcp.notion.com/authorize?x=1"));
    expect(links).toEqual(["https://mcp.notion.com/authorize?x=1"]);
    const state = provider.state();
    expect(state.length).toBeGreaterThanOrEqual(32);
    expect(consumeLoginState(store, state, now + 1000)).toBe("notion");
    expect(consumeLoginState(store, state, now + 1000)).toBeUndefined();
    const late = provider.state();
    expect(consumeLoginState(store, late, now + LOGIN_TTL_MS + 1)).toBeUndefined();
    expect(consumeLoginState(store, "made-up", now)).toBeUndefined();
  });
});

class FakeOpener implements Opener {
  opened: string[] = [];
  fail: Record<string, Error | undefined> = {};
  finished: { name: string; code: string }[] = [];
  closed = 0;
  async open(name: string): Promise<McpSession> {
    this.opened.push(name);
    const failure = this.fail[name];
    if (failure) throw failure;
    return {
      listTools: async () => [
        { name: "search", description: "Searches the workspace.", readOnly: true },
        { name: "create-page", description: "Creates a page.", readOnly: false },
      ],
      callTool: async (tool) => {
        if (tool === "broken") throw new Error("session lost");
        return { text: "[]", isError: false };
      },
      close: async () => void (this.closed += 1),
    };
  }
  async finishLogin(name: string, code: string) {
    this.finished.push({ name, code });
  }
}

describe("McpHub", () => {
  let opener: FakeOpener;
  let told: { server: string; text: string }[];
  const hub = () => new McpHub({ names: ["notion", "tracker"], opener, tell: async (server, text) => void told.push({ server, text }) });

  beforeEach(() => {
    opener = new FakeOpener();
    told = [];
  });

  it("connects every server at startup and keeps each one's status", async () => {
    opener.fail.tracker = new LoginNeeded("tracker needs the user to log in");
    const h = hub();
    await h.start();
    expect(h.status("notion")).toEqual({ status: "connected" });
    expect(h.status("tracker")).toEqual({ status: "needs login" });
  });

  it("keeps a session, and opens a new one after a call fails", async () => {
    const h = hub();
    await h.callTool("notion", "search", {});
    await h.callTool("notion", "search", {});
    expect(opener.opened).toEqual(["notion"]);
    await expect(h.callTool("notion", "broken", {})).rejects.toThrow("session lost");
    await h.callTool("notion", "search", {});
    expect(opener.opened).toEqual(["notion", "notion"]);
    expect(opener.closed).toBe(1);
  });

  it("shares one connection attempt between calls made at once, and tries again after it fails", async () => {
    const h = hub();
    await Promise.all([h.start(), h.callTool("notion", "search", {}), h.listTools("notion")]);
    expect(opener.opened.filter((name) => name === "notion")).toEqual(["notion"]);
    opener.opened = [];
    opener.fail.tracker = new Error("ECONNREFUSED");
    const fresh = hub();
    await Promise.all([fresh.listTools("tracker").catch(() => undefined), fresh.listTools("tracker").catch(() => undefined)]);
    expect(opener.opened).toEqual(["tracker"]);
    opener.fail.tracker = undefined;
    await fresh.listTools("tracker");
    expect(opener.opened).toEqual(["tracker", "tracker"]);
  });

  it("finishes a login, connects, and says so", async () => {
    opener.fail.notion = new LoginNeeded("x");
    const h = hub();
    await h.start();
    opener.fail.notion = undefined;
    await h.finishLogin("notion", "code-1");
    expect(opener.finished).toEqual([{ name: "notion", code: "code-1" }]);
    expect(h.status("notion")).toEqual({ status: "connected" });
    expect(told).toEqual([{ server: "notion", text: "The MCP server notion is connected." }]);
  });

  it("describes each server and its tools, marking which only read", async () => {
    opener.fail.tracker = new Error("ECONNREFUSED");
    const text = await hub().describe();
    expect(text).toContain("notion: connected");
    expect(text).toContain("- search (read-only): Searches the workspace.");
    expect(text).toContain("- create-page (may change things): Creates a page.");
    expect(text).toContain("tracker: failing (ECONNREFUSED)");
  });
});

describe("oauthCallbackHandler", () => {
  it("finishes the login a fresh state names, and refuses an unknown or used one", async () => {
    const finished: string[] = [];
    const handler = oauthCallbackHandler({ store, now: () => now, finish: async (server, code) => void finished.push(`${server}:${code}`) });
    const state = oauth().state();
    const req = (query: string) => ({ method: "GET", headers: {}, query: new URLSearchParams(query), rawBody: Buffer.alloc(0) });
    const ok = await handler(req(`code=c1&state=${state}`));
    expect(ok).toMatchObject({ status: 200, contentType: "text/html; charset=utf-8" });
    expect(ok.text).toContain("Logged in");
    expect(finished).toEqual(["notion:c1"]);
    expect((await handler(req(`code=c1&state=${state}`))).status).toBe(400);
    expect((await handler(req("code=c1"))).status).toBe(400);
  });
});
