import { beforeEach, describe, expect, it, vi } from "vitest";
import { Composio as ComposioComponent } from "../src/composio/component.js";
import type { ComposioAccount } from "../src/config.js";
import { Supervisor } from "../src/listeners.js";
import { Store } from "../src/store.js";

/** What the SDK was asked, for the adapter's connection pinning. */
const seen: { sessions: Record<string, unknown>[]; connections: { id: string; status: string }[]; execute: () => Promise<unknown> } = { sessions: [], connections: [], execute: async () => ({ resultType: "completed", data: {}, error: null }) };

vi.mock("@composio/core", () => ({
  Composio: class {
    connectedAccounts = {
      list: async () => ({ items: seen.connections }),
      link: async () => ({ id: "ca_new", redirectUrl: "https://connect.example/link" }),
      delete: async (id: string) => void (seen.connections = seen.connections.filter((c) => c.id !== id)),
    };
    create = async (_user: string, config: Record<string, unknown>) => {
      seen.sessions.push(config);
      return { execute: () => seen.execute() };
    };
  },
}));

const { sdkComposioApi } = await import("../src/composio/api.js");

const pinned = () => (seen.sessions.at(-1)?.connectedAccounts as Record<string, string> | undefined)?.slack;

beforeEach(() => {
  seen.sessions = [];
  seen.connections = [{ id: "ca_old", status: "ACTIVE" }];
  seen.execute = async () => ({ resultType: "completed", data: {}, error: null });
});

describe("the SDK adapter's connection pin", () => {
  it("keeps tool calls on the established connection while a replacement sign-in is pending, and moves once it is deleted", async () => {
    const api = sdkComposioApi("key");
    expect((await api.findConnection("slack:work", "slack"))?.id).toBe("ca_old");
    await api.execute("slack:work", "slack", "SLACK_TEST_AUTH", {});
    expect(pinned()).toBe("ca_old");

    // A replacement sign-in is started: its connection is initiating and must not take the pin.
    await api.linkManaged("slack:work", "ac_1");
    seen.connections.push({ id: "ca_new", status: "INITIATING" });
    await api.execute("slack:work", "slack", "SLACK_TEST_AUTH", {});
    expect(pinned()).toBe("ca_old");

    // The swap completes: the old connection is deleted, the new one is active, and the next call finds it.
    seen.connections = [{ id: "ca_new", status: "ACTIVE" }];
    await api.deleteConnection("ca_old");
    await api.execute("slack:work", "slack", "SLACK_TEST_AUTH", {});
    expect(pinned()).toBe("ca_new");
  });

  it("keeps calls on the active connection after a daemon restart, when nothing was pinned before the sign-in link", async () => {
    const api = sdkComposioApi("key");
    await api.linkManaged("slack:work", "ac_1");
    seen.connections.push({ id: "ca_new", status: "INITIATING" });
    await api.execute("slack:work", "slack", "SLACK_TEST_AUTH", {});
    expect(pinned()).toBe("ca_old");
  });

  it("finds the sign-in's connection when there is no other, so a first sign-in works once it is active", async () => {
    seen.connections = [];
    const api = sdkComposioApi("key");
    await api.linkManaged("slack:work", "ac_1");
    seen.connections = [{ id: "ca_new", status: "ACTIVE" }];
    await api.execute("slack:work", "slack", "SLACK_TEST_AUTH", {});
    expect(pinned()).toBe("ca_new");
  });
});

describe("what a failed call is taken for", () => {
  const reddit: ComposioAccount = { toolkit: "reddit", account: "me", shared: true, audience: "private", triggers: [], selfIsUser: false };
  let told: { to: string; text: string }[];
  let composio: ComposioComponent;
  let store: Store;

  beforeEach(() => {
    told = [];
    store = new Store(":memory:");
    const schedule = () => () => {};
    composio = new ComposioComponent({
      api: sdkComposioApi("key"),
      store,
      accounts: [reddit],
      publicUrl: "https://x.example",
      tell: async (a, text) => void told.push({ to: `${a.toolkit}:${a.account}`, text }),
      tellHome: async (text) => void told.push({ to: "home", text }),
      now: () => Date.UTC(2026, 10, 21),
      schedule,
      supervisor: new Supervisor({ schedule }),
      log: () => {},
    });
  });

  const failed = (status: number, error: string) => async () => ({ resultType: "failed", error, data: { status_code: status } });

  it("never posts Composio's monthly-limit notice for a service's own 429, such as Reddit's, and the call fails as a refusal", async () => {
    seen.execute = failed(429, "Reddit API error for subreddit 'Esperanto': HTTP 429");
    const result = await composio.run(reddit, "REDDIT_GET_NEW_POSTS", {});
    expect(result).toMatchObject({ ok: false, reason: "refused" });
    expect(told).toEqual([]);
    expect(store.getState("composio.capMonth")).toBeUndefined();
  });

  it("posts the monthly-limit notice once when Composio itself says the quota is used up", async () => {
    seen.execute = async () => {
      throw Object.assign(new Error("429 Monthly usage limit exceeded for this project"), { status: 429 });
    };
    expect(await composio.run(reddit, "REDDIT_GET_NEW_POSTS", {})).toMatchObject({ ok: false, reason: "cap" });
    await composio.run(reddit, "REDDIT_GET_NEW_POSTS", {});
    expect(told.filter((t) => t.text.includes("free monthly limit is reached"))).toHaveLength(1);
    expect(told[0].to).toBe("home");
  });

  it("does not take Composio's own per-minute rate limit for the monthly cap", async () => {
    seen.execute = async () => {
      throw Object.assign(new Error("429 Too Many Requests"), { status: 429 });
    };
    expect(await composio.run(reddit, "REDDIT_GET_NEW_POSTS", {})).toMatchObject({ ok: false, reason: "unreachable" });
    expect(told).toEqual([]);
  });

  it("does not say the connection expired for a service's 403, but does for a 401 that rejects its credentials", async () => {
    seen.execute = failed(403, "Forbidden: this subreddit is private");
    expect(await composio.run(reddit, "REDDIT_GET_NEW_POSTS", {})).toMatchObject({ ok: false, reason: "refused" });
    expect(told).toEqual([]);
    seen.execute = failed(401, "Invalid token");
    expect(await composio.run(reddit, "REDDIT_GET_NEW_POSTS", {})).toMatchObject({ ok: false, reason: "auth" });
    expect(told.filter((t) => t.text.includes("no longer accepting the connection"))).toHaveLength(1);
  });
});
