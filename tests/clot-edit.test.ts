import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type net from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { newestWorkspace, newWorkspaceName } from "../src/agent/container.js";
import { ConfigStore } from "../src/config-store.js";
import { LiveEnv } from "../src/live-env.js";
import { ClotCreator } from "../src/onboarding/create.js";
import { Store } from "../src/store.js";
import { EventBus } from "../src/ui-api/events.js";
import { registerClotAdminRoutes } from "../src/ui-api/routes/clots-admin.js";
import { registerSettingsRoutes } from "../src/ui-api/routes/settings.js";
import { UiApi } from "../src/ui-api/server.js";

let dir: string;
let config: ConfigStore;
let access: Record<string, number>;
let steps: { clot: string; step: string; log?: string }[];
let moved: { name: string; repoUrl: string }[];
let moveFails: string | undefined;
let busy: string | undefined;
let release: (() => void) | undefined;
let creator: ClotCreator;
let api: UiApi;
let call: (p: string, init?: RequestInit) => Promise<Response>;
let removed: string[];

const waitFor = async (fn: () => boolean) => {
  for (let i = 0; i < 100 && !fn(); i++) await new Promise((r) => setTimeout(r, 10));
};

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "clots-edit-"));
  const file = path.join(dir, "clots.config.json");
  const envFile = path.join(dir, ".env");
  fs.writeFileSync(envFile, "CLAUDE_CODE_OAUTH_TOKEN=c\nCLOT_GITHUB_TOKEN=ghp_secret123\nGITHUB_WEBHOOK_SECRET=w\n");
  fs.writeFileSync(file, JSON.stringify({ timeZone: "UTC", image: "i", ui: { owner: "me" }, home: true, clots: [{ name: "graphite", repoUrl: "https://github.com/o/old.git", about: "the project in the repository o/old" }, { name: "shop", repoUrl: "https://github.com/o/shop.git" }] }));
  config = new ConfigStore({ file, envFile, env: new LiveEnv(envFile, {}) });
  steps = [];
  moved = [];
  moveFails = undefined;
  busy = undefined;
  release = undefined;
  removed = [];
  access = { "GET /repos/o/new": 200 };
  const fetchFn = (async (url: string, init: RequestInit = {}) => new Response("{}", { status: access[`${init.method ?? "GET"} ${url.replace("https://api.github.com", "")}`] ?? 404 })) as unknown as typeof fetch;
  creator = new ClotCreator({
    config,
    token: () => "ghp_secret123",
    fetchFn,
    start: async () => undefined,
    emit: (e) => void steps.push(e),
    onReady: async () => undefined,
    busy: () => busy,
    reclone: async (def, step, commit) => {
      step("cloning");
      if (release === undefined) await Promise.resolve();
      else await new Promise<void>((resolve) => (release = resolve));
      if (moveFails) throw new Error(moveFails);
      step("starting");
      await commit();
      moved.push(def);
    },
  });
  api = new UiApi({ secret: () => "s", bus: new EventBus("b") });
  registerClotAdminRoutes(api, { creator, icons: {} as never, config, webhookSecret: () => "x", onboarding: () => [] });
  registerSettingsRoutes(api, { config, removeClot: async (n) => void removed.push(n), reorder: () => undefined, announce: () => undefined, building: (n) => creator.isBuilding(n) });
  const server = await api.listen(0);
  const port = (server.address() as net.AddressInfo).port;
  call = (p, init = {}) => fetch(`http://127.0.0.1:${port}/api/v1${p}`, { ...init, headers: { "x-clots-ui-secret": "s", "content-type": "application/json" } });
});
afterEach(() => api.close());

describe("Edit: a Clot's icon and repository", () => {
  it("re-clones for a changed repository, sends the build steps, and changes the entry only once the move worked", async () => {
    release = () => undefined;
    const res = await call("/clots/graphite", { method: "PUT", body: JSON.stringify({ repo: "o/new", icon: { phosphor: "Sliders", color: "teal" } }) });
    expect(res.status).toBe(202);
    // The entry is as it was while the move runs.
    expect(config.current.clots[0]!.repoUrl).toBe("https://github.com/o/old.git");
    release();
    await waitFor(() => steps.some((s) => s.step === "done"));
    expect(steps.map((s) => s.step)).toEqual(["cloning", "cloning", "starting", "done"]);
    expect(moved).toEqual([{ name: "graphite", repoUrl: "https://github.com/o/new.git" }]);
    expect(config.current.clots[0]).toMatchObject({ name: "graphite", repoUrl: "https://github.com/o/new.git", about: "the project in the repository o/new", icon: { phosphor: "Sliders", color: "teal" } });
    expect(creator.building.has("graphite")).toBe(false);
  });

  it("leaves the Clot on its old workspace and its entry as it was when the clone fails, reports the log without the token, and retries", async () => {
    moveFails = "fatal: could not read https://x-access-token:ghp_secret123@github.com/o/new.git";
    await call("/clots/graphite", { method: "PUT", body: JSON.stringify({ repo: "o/new" }) });
    await waitFor(() => steps.some((s) => s.step === "failed"));
    const failed = steps.at(-1)!;
    expect(failed.log).not.toContain("ghp_secret123");
    expect(config.current.clots[0]!.repoUrl).toBe("https://github.com/o/old.git");
    expect(moved).toEqual([]);
    moveFails = undefined;
    steps = [];
    expect((await call("/clots/graphite/retry", { method: "POST" })).status).toBe(202);
    await waitFor(() => steps.some((s) => s.step === "done"));
    expect(config.current.clots[0]!.repoUrl).toBe("https://github.com/o/new.git");
  });

  it("undoes the move, and leaves the entry as it was, when the new entry cannot be saved", async () => {
    vi.spyOn(config, "save").mockResolvedValue({ ok: false, errors: { clots: "refused" } });
    await call("/clots/graphite", { method: "PUT", body: JSON.stringify({ repo: "o/new" }) });
    await waitFor(() => steps.some((s) => s.step === "failed"));
    expect(steps.at(-1)!.log).toContain("its entry could not be saved: refused");
    expect(moved).toEqual([]);
    expect(config.current.clots[0]!.repoUrl).toBe("https://github.com/o/old.git");
  });

  it("refuses a name change (there is none), a bad or unreachable repository, a Clot that is busy and one that is already moving", async () => {
    expect((await call("/clots/nobody", { method: "PUT", body: JSON.stringify({ repo: "o/new" }) })).status).toBe(404);
    expect((await call("/clots/graphite", { method: "PUT", body: JSON.stringify({ repo: "nope" }) })).status).toBe(400);
    expect((await call("/clots/graphite", { method: "PUT", body: JSON.stringify({ repo: "o/private" }) })).status).toBe(400);
    expect((await call("/clots/graphite", { method: "PUT", body: JSON.stringify({}) })).status).toBe(400);
    busy = "graphite is working right now.";
    const res = await call("/clots/graphite", { method: "PUT", body: JSON.stringify({ repo: "o/new" }) });
    expect(res.status).toBe(409);
    expect(JSON.stringify(await res.json())).toContain("working right now");
    busy = undefined;
    release = () => undefined;
    expect((await call("/clots/graphite", { method: "PUT", body: JSON.stringify({ repo: "o/new" }) })).status).toBe(202);
    expect((await call("/clots/graphite", { method: "PUT", body: JSON.stringify({ repo: "o/new" }) })).status).toBe(409);
    release();
  });

  it("does not delete a Clot while it is being moved", async () => {
    release = () => undefined;
    await call("/clots/graphite", { method: "PUT", body: JSON.stringify({ repo: "o/new" }) });
    expect((await call("/clots/graphite?confirm=graphite", { method: "DELETE" })).status).toBe(409);
    expect(removed).toEqual([]);
    release();
  });

  it("saves an icon alone at once, and changes nothing about the repository", async () => {
    const res = await call("/clots/shop", { method: "PUT", body: JSON.stringify({ icon: { phosphor: "Gear", color: "red" } }) });
    expect(res.status).toBe(200);
    expect(config.current.clots[1]).toMatchObject({ icon: { phosphor: "Gear", color: "red" }, repoUrl: "https://github.com/o/shop.git" });
    expect(moved).toEqual([]);
    // The same repository again is no move.
    expect((await call("/clots/shop", { method: "PUT", body: JSON.stringify({ repo: "O/Shop" }) })).status).toBe(200);
    expect(moved).toEqual([]);
  });
});

describe("Edit: a Clot's description and test command", () => {
  const put = (name: string, body: unknown) => call(`/clots/${name}`, { method: "PUT", body: JSON.stringify(body) });

  it("reads them as the file has them, saves them at once, and an empty text removes the key", async () => {
    expect(await (await call("/clots/graphite/settings")).json()).toEqual({ about: "the project in the repository o/old", testCommand: "" });
    expect((await call("/clots/ghost/settings")).status).toBe(404);
    expect((await put("graphite", { about: "  The payments service  ", testCommand: "npm test" })).status).toBe(200);
    expect(config.current.clots[0]).toMatchObject({ about: "The payments service", testCommand: "npm test", repoUrl: "https://github.com/o/old.git" });
    expect(config.current.clots[1]).not.toHaveProperty("about");
    expect((await put("graphite", { testCommand: "" })).status).toBe(200);
    expect(config.current.clots[0]).not.toHaveProperty("testCommand");
    expect(config.current.clots[0]!.about).toBe("The payments service");
    expect((await put("graphite", { about: "" })).status).toBe(200);
    expect(config.current.clots[0]).not.toHaveProperty("about");
  });

  it("refuses a description over 300 characters and an edit that gives nothing, and changes nothing", async () => {
    expect((await put("shop", { about: "x".repeat(301) })).status).toBe(400);
    expect((await put("shop", {})).status).toBe(400);
    expect((await put("ghost", { about: "x" })).status).toBe(404);
    expect(config.current.clots[1]).not.toHaveProperty("about");
  });

  it("saves them together with an icon, and with a repository change that is still being cloned", async () => {
    expect((await put("shop", { icon: { phosphor: "Gear", color: "red" }, testCommand: "make test" })).status).toBe(200);
    expect(config.current.clots[1]).toMatchObject({ icon: { phosphor: "Gear", color: "red" }, testCommand: "make test" });
    release = () => undefined;
    const moving = await put("graphite", { repo: "o/new", about: "Moved on" });
    expect(moving.status).toBe(202);
    expect(config.current.clots[0]).toMatchObject({ about: "Moved on", repoUrl: "https://github.com/o/old.git" });
    release?.();
    await waitFor(() => moved.length === 1);
    expect(config.current.clots[0]).toMatchObject({ about: "Moved on", repoUrl: "https://github.com/o/new.git" });
  });
});

describe("a failed create gives its name back", () => {
  it("lets the same name be tried again with another repository, before any retry", async () => {
    const failing = new ClotCreator({ config, token: () => "t", fetchFn: (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch, start: async () => Promise.reject(new Error("no")), emit: (e) => void steps.push(e), onReady: async () => undefined });
    await failing.create({ name: "fresh", repo: "o/new" });
    await waitFor(() => steps.some((s) => s.step === "failed"));
    expect(config.current.clots.some((c) => c.name === "fresh")).toBe(false);
    expect((await failing.validate({ name: "fresh", repo: "o/new" })).errors.name).toBeUndefined();
  });
});

describe("a deleted Clot's waiting messages", () => {
  it("are dropped, and another Clot's are kept", () => {
    const store = new Store(":memory:");
    store.enqueue({ id: "a", clot: "shop", text: "x", receivedAt: 1 });
    store.enqueue({ id: "b", clot: "graphite", text: "y", receivedAt: 2 });
    store.clearInbox("shop");
    expect(store.pendingRows("shop")).toEqual([]);
    expect(store.pendingRows("graphite").map((r) => r.id)).toEqual(["b"]);
  });
});

describe("the workspace volume", () => {
  it("is the newest one the Clot has, so a recreated container keeps the repository it was moved to", () => {
    const newest = newWorkspaceName("Graphite", Date.UTC(2026, 10, 24));
    expect(newest.startsWith("clot-graphite-work-")).toBe(true);
    const older = newWorkspaceName("Graphite", Date.UTC(2026, 9, 1));
    expect(newestWorkspace("clot-graphite", ["clot-graphite-home", "clot-graphite-work", older, newest, "clot-graphite-work-extra-thing", "clot-other-work-zzzzzzzz"])).toBe(newest);
    expect(newestWorkspace("clot-graphite", ["clot-graphite-work"])).toBe("clot-graphite-work");
    expect(newestWorkspace("clot-graphite", [])).toBe("clot-graphite-work");
  });
});
