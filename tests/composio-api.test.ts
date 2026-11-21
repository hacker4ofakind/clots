import { beforeEach, describe, expect, it, vi } from "vitest";

/** What the SDK was asked, for the adapter's connection pinning. */
const seen: { sessions: Record<string, unknown>[]; connections: { id: string; status: string }[] } = { sessions: [], connections: [] };

vi.mock("@composio/core", () => ({
  Composio: class {
    connectedAccounts = {
      list: async () => ({ items: seen.connections }),
      link: async () => ({ id: "ca_new", redirectUrl: "https://connect.example/link" }),
      delete: async (id: string) => void (seen.connections = seen.connections.filter((c) => c.id !== id)),
    };
    create = async (_user: string, config: Record<string, unknown>) => {
      seen.sessions.push(config);
      return { execute: async () => ({ resultType: "completed", data: {}, error: null }) };
    };
  },
}));

const { sdkComposioApi } = await import("../src/composio/api.js");

const pinned = () => (seen.sessions.at(-1)?.connectedAccounts as Record<string, string> | undefined)?.slack;

beforeEach(() => {
  seen.sessions = [];
  seen.connections = [{ id: "ca_old", status: "ACTIVE" }];
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

  it("pins the sign-in's connection when there is no other, so a first sign-in works once it is active", async () => {
    seen.connections = [];
    const api = sdkComposioApi("key");
    await api.linkManaged("slack:work", "ac_1");
    seen.connections = [{ id: "ca_new", status: "ACTIVE" }];
    await api.execute("slack:work", "slack", "SLACK_TEST_AUTH", {});
    expect(pinned()).toBe("ca_new");
  });
});
