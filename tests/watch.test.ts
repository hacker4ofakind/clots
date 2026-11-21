import { beforeEach, describe, expect, it } from "vitest";
import { Composio } from "../src/composio/component.js";
import { composioHub } from "../src/composio/hub.js";
import type { ComposioAccount } from "../src/config.js";
import { Supervisor } from "../src/listeners.js";
import { FakeComposioApi, tool } from "./fake-composio.js";
import type { ClotEvent } from "../src/events/types.js";
import type { ToolInfo, ToolResult } from "../src/mcp/hub.js";
import { parseWatch, watchTarget, type WatchRecipe } from "../src/rulebook.js";
import { Store } from "../src/store.js";
import { fillPaths, pathGet } from "../src/paths.js";
import { compare, itemsOf, MAX_ITEMS, readResult, tryRecipe, watchEvent, Watcher } from "../src/watch.js";

const recipe: WatchRecipe = { name: "notion-feedback", server: "notion", tool: "search", arguments: { query: "Feedback" }, items: "results", id: "id", title: "{title}", url: "{url}", ignore: ["last_seen"], every: 5, report: "added" };
const result = (items: unknown[]): ToolResult => ({ text: JSON.stringify({ results: items }), isError: false });
const page = (id: string, title: string, extra: Record<string, unknown> = {}) => ({ id, title, url: `https://notion.so/${id}`, last_seen: "x", ...extra });

describe("reading a result", () => {
  it("follows a path of names and indexes", () => {
    expect(pathGet({ data: [{ rows: [1, 2] }] }, "data.0.rows")).toEqual([1, 2]);
    expect(pathGet([1, 2], "")).toEqual([1, 2]);
    expect(pathGet({ a: 1 }, "b.c")).toBeUndefined();
  });

  it("fills {paths} from an item, leaving nothing for a missing one", () => {
    expect(fillPaths("{title} ({meta.state})", { title: "Bug", meta: { state: "open" } })).toBe("Bug (open)");
    expect(fillPaths("{title}{missing}", { title: "Bug" })).toBe("Bug");
  });

  it("takes structured content first, then text that is JSON, and refuses anything else", () => {
    expect(readResult({ structured: { a: 1 }, text: "nope", isError: false })).toEqual({ a: 1 });
    expect(readResult({ text: '{"a":2}', isError: false })).toEqual({ a: 2 });
    expect(() => readResult({ text: "# Results\n- one", isError: false })).toThrow("not JSON");
    expect(() => readResult({ text: "boom", isError: true })).toThrow("the tool reported an error");
  });

  it("gives the items with their IDs and a hash that leaves out the ignored fields", () => {
    const one = itemsOf(recipe, result([page("p1", "A")]));
    const same = itemsOf(recipe, result([page("p1", "A", { last_seen: "y" })]));
    const other = itemsOf(recipe, result([page("p1", "B")]));
    expect(one[0]).toMatchObject({ id: "p1" });
    expect(same[0].hash).toBe(one[0].hash);
    expect(other[0].hash).not.toBe(one[0].hash);
    expect(() => itemsOf({ ...recipe, items: "nowhere" }, result([]))).toThrow("is not a list");
  });

  it("compares at most 500 items", () => {
    expect(itemsOf(recipe, result(Array.from({ length: MAX_ITEMS + 20 }, (_, i) => page(`p${i}`, "t"))))).toHaveLength(MAX_ITEMS);
  });
});

describe("compare", () => {
  it("reports nothing the first time, then new items, and changed ones only when asked", () => {
    expect(compare(undefined, [{ id: "a", hash: "1" }], "added")).toEqual({ added: [], changed: [], snapshot: { a: "1" } });
    expect(compare({ a: "1" }, [{ id: "a", hash: "2" }, { id: "b", hash: "1" }], "added")).toEqual({ added: ["b"], changed: [], snapshot: { a: "2", b: "1" } });
    expect(compare({ a: "1" }, [{ id: "a", hash: "2" }], "added_and_changed").changed).toEqual(["a"]);
  });

  it("reports an item whose ID is also the name of an object's own property", () => {
    expect(compare({ a: "1" }, [{ id: "constructor", hash: "1" }, { id: "toString", hash: "2" }], "added").added).toEqual(["constructor", "toString"]);
  });
});

describe("watchEvent", () => {
  it("makes an automated event named by the recipe, about the recipe", () => {
    const [entry] = itemsOf(recipe, result([page("p1", "Export is slow")]));
    expect(watchEvent(recipe, entry, "item_added", 1000, 3)).toMatchObject({
      id: `notion-feedback:p1:${entry.hash}:3`,
      source: "notion-feedback",
      account: "notion-feedback",
      kind: "item_added",
      place: "notion",
      actor: "notion-feedback",
      title: "Export is slow",
      url: "https://notion.so/p1",
      ref: "p1",
      subject: "notion-feedback",
      automated: true,
      // What a watched tool returns can be anyone's text.
      outsider: true,
    });
    expect(watchEvent({ ...recipe, title: undefined }, entry, "item_changed", 1000, 3).title).toBe("Changed in notion-feedback: p1");
  });
});

describe("Watcher", () => {
  let store: Store;
  let delivered: ClotEvent[];
  let items: unknown[];
  let tools: ToolInfo[];
  const hub = {
    listTools: async () => tools,
    callTool: async () => result(items),
  };
  const watcher = (r: WatchRecipe = recipe) => new Watcher({ recipe: r, hubFor: () => hub, store, deliver: (event) => void delivered.push(event), now: () => 1000 });

  beforeEach(() => {
    store = new Store(":memory:");
    delivered = [];
    items = [page("p1", "A")];
    tools = [{ name: "search", description: "", readOnly: true }];
  });

  it("sets a baseline, then reports each new item once, across restarts", async () => {
    await watcher().run();
    expect(delivered).toEqual([]);
    items = [page("p1", "A"), page("p2", "B")];
    await watcher().run();
    await watcher().run();
    expect(delivered.map((e) => e.title)).toEqual(["B"]);
  });

  it("reports a change back to an earlier state, and an item that comes back, each time", async () => {
    const changes = { ...recipe, report: "added_and_changed" as const };
    await watcher(changes).run();
    for (const title of ["B", "A", "B"]) {
      items = [page("p1", title)];
      await watcher(changes).run();
    }
    items = [];
    await watcher(changes).run();
    items = [page("p1", "B")];
    await watcher(changes).run();
    expect(delivered.map((e) => `${e.kind} ${e.title}`)).toEqual(["item_changed B", "item_changed A", "item_changed B", "item_added B"]);
  });

  it("makes the same event again when a run is repeated before it was recorded, so the repeat is dropped", async () => {
    await watcher().run();
    const saved = store.getState("watch:notion-feedback")!;
    items = [page("p1", "A"), page("p2", "B")];
    await watcher().run();
    // As if the daemon stopped after storing the event and before recording the run.
    store.setState("watch:notion-feedback", saved);
    await watcher().run();
    expect(delivered.map((e) => e.title)).toEqual(["B"]);
  });

  it("starts a new baseline when the recipe asks for something else", async () => {
    await watcher().run();
    items = [page("p9", "Z")];
    await watcher({ ...recipe, arguments: { query: "Other" } }).run();
    expect(delivered).toEqual([]);
  });

  it("refuses a tool that does not declare itself read-only, unless the recipe says so", async () => {
    tools = [{ name: "search", description: "", readOnly: false }];
    await expect(watcher().run()).rejects.toThrow("does not declare itself read-only");
    await expect(watcher({ ...recipe, notReadOnly: true }).run()).resolves.toBeUndefined();
    tools = [];
    await expect(watcher().run()).rejects.toThrow("has no tool named search");
  });

  it("says once when a call gives the most items it compares", async () => {
    const told: string[] = [];
    items = Array.from({ length: MAX_ITEMS + 5 }, (_, i) => page(`p${i}`, "t"));
    const capped = () => new Watcher({ recipe, hubFor: () => hub, store, deliver: () => undefined, now: () => 1000, tell: async (text) => void told.push(text) });
    await capped().run();
    await capped().run();
    expect(told).toEqual([`The watch recipe notion-feedback found ${MAX_ITEMS} items or more; only the first ${MAX_ITEMS} are compared.`]);
  });

  it("can be tried without recording anything", async () => {
    const text = await tryRecipe(() => hub, recipe);
    expect(text).toContain("1 item");
    expect(text).toContain('"title":"A"');
    expect(store.statesWithPrefix("watch:")).toEqual([]);
    tools = [{ name: "search", description: "", readOnly: false }];
    expect(await tryRecipe(() => hub, recipe)).toContain("Refused");
    // notReadOnly is the user's yes to a saved recipe; a draft that says it is still refused.
    expect(await tryRecipe(() => hub, { ...recipe, notReadOnly: true })).toContain("Refused");
  });
});

describe("a watch on a Composio account", () => {
  const reddit = { name: "new-posts", account: "reddit:me", tool: "REDDIT_GET_NEW_POSTS", arguments: { subreddit: "typescript" }, items: "posts", id: "id", title: "{title}", url: "{url}", ignore: [], every: 15, report: "added" as const };
  const post = (id: string, title: string) => ({ id, title, url: `https://reddit.com/${id}` });
  const accounts: ComposioAccount[] = [{ toolkit: "reddit", account: "me", shared: true, audience: "private", triggers: [], selfIsUser: false }];
  let store: Store;
  let api: FakeComposioApi;
  let composio: Composio;
  let delivered: ClotEvent[];
  let posts: unknown[];

  beforeEach(() => {
    store = new Store(":memory:");
    api = new FakeComposioApi();
    composio = new Composio({ api, store, accounts, publicUrl: "https://x.example", tell: async () => {}, tellHome: async () => {}, now: () => 1000, schedule: () => () => {}, supervisor: new Supervisor({ schedule: () => () => {} }), log: () => {} });
    delivered = [];
    posts = [post("t3_a", "First")];
    api.tools.set("REDDIT_GET_NEW_POSTS", tool("REDDIT_GET_NEW_POSTS", ["readOnlyHint"]));
    api.answers.set("REDDIT_GET_NEW_POSTS", () => ({ ok: true, data: { posts } }));
  });

  const watcher = (r = reddit, extra: { active?: () => boolean } = {}) => new Watcher({ recipe: r, hubFor: () => composioHub(composio), store, deliver: (e) => void delivered.push(e), now: () => 1000, ...extra });

  it("reports new items as item_added, from an outsider, with the account as the place", async () => {
    await watcher().run();
    expect(delivered).toEqual([]);
    posts = [post("t3_b", "Second"), post("t3_a", "First")];
    await watcher().run();
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({ kind: "item_added", source: "new-posts", place: "reddit:me", title: "Second", url: "https://reddit.com/t3_b", outsider: true, automated: true });
    expect(api.of("execute")[0]).toContain('{"subreddit":"typescript"}');
  });

  it("refuses a write tool at run, as a non-read MCP tool is, and calls nothing", async () => {
    api.tools.set("REDDIT_CREATE_POST", tool("REDDIT_CREATE_POST", ["createHint"]));
    await expect(watcher({ ...reddit, tool: "REDDIT_CREATE_POST" }).run()).rejects.toThrow("does not declare itself read-only");
    expect(api.of("execute")).toEqual([]);
  });

  it("refuses a tool of another toolkit or one Composio does not know", async () => {
    await expect(watcher({ ...reddit, tool: "REDDIT_NO_SUCH_TOOL" }).run()).rejects.toThrow("reddit:me has no tool named REDDIT_NO_SUCH_TOOL");
    api.tools.set("SLACK_LIST_ALL_USERS", tool("SLACK_LIST_ALL_USERS", ["readOnlyHint"]));
    await expect(watcher({ ...reddit, tool: "SLACK_LIST_ALL_USERS" }).run()).rejects.toThrow("has no tool named");
  });

  it("skips the run while the account is not signed in, and fails the run when the call fails", async () => {
    await watcher(reddit, { active: () => false }).run();
    expect(api.of("execute")).toEqual([]);
    api.answers.set("REDDIT_GET_NEW_POSTS", { ok: false, error: "rate limited", reason: "cap" });
    await expect(watcher().run()).rejects.toThrow("the tool reported an error: rate limited");
  });

  it("can be tried: shows the items, refuses a write tool", async () => {
    expect(await tryRecipe(() => composioHub(composio), reddit)).toContain("1 item");
    api.tools.set("REDDIT_CREATE_POST", tool("REDDIT_CREATE_POST", ["createHint"]));
    expect(await tryRecipe(() => composioHub(composio), { ...reddit, tool: "REDDIT_CREATE_POST" })).toContain("Refused");
  });

  it("is checked by the schema: an interval under 15 minutes, notReadOnly, a tool of another toolkit, and server with account", () => {
    expect(parseWatch(reddit).every).toBe(15);
    expect(() => parseWatch({ ...reddit, every: 5 })).toThrow("every 15 minutes or less often");
    expect(() => parseWatch({ ...reddit, notReadOnly: true })).toThrow("notReadOnly does not apply");
    expect(() => parseWatch({ ...reddit, tool: "SLACK_LIST_ALL_USERS" })).toThrow("begins REDDIT_");
    expect(() => parseWatch({ ...reddit, server: "notion" })).toThrow("either server");
    expect(() => parseWatch({ ...reddit, account: undefined })).toThrow("either server");
    expect(() => parseWatch({ ...reddit, account: "reddit" })).toThrow("<toolkit>:<account>");
  });

  it("names its target as the account, for an event's place and the baseline", () => {
    expect(watchTarget(reddit)).toBe("reddit:me");
    expect(watchTarget(recipe)).toBe("notion");
  });
});
