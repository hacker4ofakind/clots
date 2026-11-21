import { beforeEach, describe, expect, it } from "vitest";
import { ComposioActions, type ActionContext } from "../src/composio/actions.js";
import { Composio } from "../src/composio/component.js";
import { LINEAR } from "../src/composio/toolkits/linear.js";
import { NOTION } from "../src/composio/toolkits/notion.js";
import { ComposioUndo, findId, INVERSES } from "../src/composio/undo.js";
import type { ComposioAccount } from "../src/config.js";
import { Supervisor } from "../src/listeners.js";
import { Store } from "../src/store.js";
import { FakeComposioApi, tool } from "./fake-composio.js";

const NOW = Date.UTC(2026, 10, 19, 12, 0, 0);
const base = { shared: false, triggers: [], selfIsUser: false };
const linear: ComposioAccount = { ...base, toolkit: "linear", account: "proton", clot: "graphite", audience: "private", apiKey: "k", apiKeyName: "K" };
const notion: ComposioAccount = { ...base, toolkit: "notion", account: "main", clot: "graphite", audience: "private", apiKey: "k", apiKeyName: "N" };
const ctx: ActionContext = { clot: "graphite", kind: "chat", outsider: false };

let api: FakeComposioApi;
let store: Store;
let composio: Composio;
let actions: ComposioActions;
let undo: ComposioUndo;
let said: string[];
let issue: Record<string, any>;
let n: number;

beforeEach(() => {
  api = new FakeComposioApi();
  store = new Store(":memory:");
  said = [];
  n = 0;
  issue = { id: "issue-uuid", title: "Old title", description: "Old", priority: 3, state: { id: "s1" }, assignee: { id: "u1" } };
  composio = new Composio({ api, store, accounts: [linear, notion], publicUrl: "https://x.example", tell: async () => {}, tellHome: async () => {}, now: () => NOW, schedule: () => () => {}, supervisor: new Supervisor({ schedule: () => () => {} }), log: () => {} });
  actions = new ComposioActions({ composio, store, reviewer: { review: async () => ({ verdict: "ask", reason: "x" }) }, ask: async () => "ASKED", say: async (_c, text) => void said.push(text), now: () => NOW + (n += 1), log: () => {} });
  undo = new ComposioUndo({ composio, store });
  for (const [slug, tags] of [
    [LINEAR.createIssue, ["createHint"]],
    [LINEAR.updateIssue, ["updateHint"]],
    [LINEAR.archiveIssue, ["updateHint"]],
    [LINEAR.createComment, ["createHint"]],
    [LINEAR.getIssue, ["readOnlyHint"]],
    [NOTION.createPage, ["createHint"]],
    [NOTION.createComment, ["createHint"]],
  ] as [string, string[]][]) api.tools.set(slug, tool(slug, tags));
  api.answers.set(LINEAR.getIssue, () => ({ ok: true, data: { issue: { ...issue } } }));
  api.answers.set(LINEAR.createIssue, { ok: true, data: { data: { id: "new-issue", identifier: "CLO-40" } } });
  api.answers.set(LINEAR.createComment, { ok: true, data: { comment: { id: "new-comment" } } });
  api.answers.set(NOTION.createPage, { ok: true, data: { id: "new-page", url: "https://notion.so/new-page" } });
  api.answers.set(LINEAR.updateIssue, (args) => {
    Object.assign(issue, { title: args.title ?? issue.title, description: args.description ?? issue.description, priority: args.priority ?? issue.priority });
    return { ok: true, data: {} };
  });
  api.answers.set(LINEAR.archiveIssue, { ok: true, data: {} });
  api.answers.set(LINEAR.graphql, { ok: true, data: { data: { commentDelete: { success: true } } } });
});

const run = (account: string, slug: string, args: Record<string, unknown>) => actions.run(ctx, { account, tool: slug, args });
const executions = () => api.of("execute").map((c) => c.replace(/^execute:\S+ /, ""));

describe("&composio undo", () => {
  it("archives a Linear issue the Clot created, using the ID from the result", async () => {
    await run("linear:proton", LINEAR.createIssue, { team_id: "t", title: "x" });
    expect(await undo.undo("graphite")).toBe("Undone (linear:proton): archived the Linear issue it created.");
    expect(executions().at(-1)).toBe(`${LINEAR.archiveIssue} {"issue_id":"new-issue"}`);
  });

  it("restores the fields an update changed, from what was read before it", async () => {
    await run("linear:proton", LINEAR.updateIssue, { issueId: "CLO-9", title: "New title", priority: 1 });
    expect(issue).toMatchObject({ title: "New title", priority: 1 });
    expect(await undo.undo("graphite")).toContain("put back title, priority");
    expect(issue).toMatchObject({ title: "Old title", priority: 3 });
  });

  it("refuses to put an update back when a field it set has changed since", async () => {
    await run("linear:proton", LINEAR.updateIssue, { issueId: "CLO-9", title: "New title" });
    issue.title = "Someone else's title";
    const text = await undo.undo("graphite");
    expect(text).toContain("changed since");
    expect(text).toContain("title");
    expect(issue.title).toBe("Someone else's title");
    // It is skipped: the next undo steps further back.
    expect(await undo.undo("graphite")).toBe("Nothing to undo.");
  });

  it("deletes a comment it made, with a fixed mutation that holds only the ID", async () => {
    await run("linear:proton", LINEAR.createComment, { issueId: "CLO-9", body: "hi" });
    expect(await undo.undo("graphite")).toContain("deleted the Linear comment it made");
    const call = executions().at(-1)!;
    expect(call).toContain(LINEAR.graphql);
    expect(JSON.parse(call.slice(LINEAR.graphql.length + 1))).toEqual({ query_or_mutation: "mutation DeleteComment($id: String!) { commentDelete(id: $id) { success } }", variables: { id: "new-comment" } });
  });

  it("archives a Notion page it created, and has no undo for a Notion comment or for anything not in the table", async () => {
    await run("notion:main", NOTION.createPage, { parent_id: "p", title: "t" });
    expect(await undo.undo("graphite")).toBe("Undone (notion:main): archived the Notion page it created.");
    api.answers.set(NOTION.createComment, { ok: true, data: { id: "c" } });
    await run("notion:main", NOTION.createComment, { parent_page_id: "p", comment: { content: "hi" } });
    expect(said.at(-1)).toContain("(no undo)");
    expect(await undo.undo("graphite")).toBe("Nothing to undo.");
  });

  it("says Nothing to undo. when the Clot has written nothing, or only what cannot be undone", async () => {
    expect(await undo.undo("graphite")).toBe("Nothing to undo.");
    api.tools.set("LINEAR_SET_FROB", tool("LINEAR_SET_FROB", ["updateHint"]));
    await run("linear:proton", "LINEAR_SET_FROB", { x: 1 });
    expect(await undo.undo("graphite")).toBe("Nothing to undo.");
  });

  it("reverses one write for each of two quick undos, newest first", async () => {
    await run("linear:proton", LINEAR.createIssue, { team_id: "t", title: "one" });
    api.answers.set(LINEAR.createIssue, { ok: true, data: { data: { id: "second-issue" } } });
    await run("linear:proton", LINEAR.createIssue, { team_id: "t", title: "two" });
    const [a, b, c] = await Promise.all([undo.undo("graphite"), undo.undo("graphite"), undo.undo("graphite")]);
    expect([a, b].every((t) => t.startsWith("Undone"))).toBe(true);
    expect(c).toBe("Nothing to undo.");
    expect(executions().filter((e) => e.startsWith(LINEAR.archiveIssue))).toEqual([`${LINEAR.archiveIssue} {"issue_id":"second-issue"}`, `${LINEAR.archiveIssue} {"issue_id":"new-issue"}`]);
  });

  it("keeps an undo it could not try for the next time, and skips one the service refused", async () => {
    await run("linear:proton", LINEAR.createIssue, { team_id: "t", title: "x" });
    api.answers.set(LINEAR.archiveIssue, { ok: false, error: "fetch failed", reason: "unreachable" });
    expect(await undo.undo("graphite")).toContain("Not undone just now");
    api.answers.set(LINEAR.archiveIssue, { ok: false, error: "Entity not found", reason: "refused" });
    expect(await undo.undo("graphite")).toContain("Could not undo");
    expect(await undo.undo("graphite")).toBe("Nothing to undo.");
  });

  it("does not undo another Clot's write", async () => {
    await run("linear:proton", LINEAR.createIssue, { team_id: "t", title: "x" });
    expect(await undo.undo("other")).toBe("Nothing to undo.");
  });

  it("builds an inverse only from the table, and only when the write's own words and result allow it", () => {
    expect(INVERSES[LINEAR.updateIssue].build({ args: { issueId: "X", labelIds: ["a"] }, result: {}, before: { issue: {} } })).toBeUndefined();
    expect(INVERSES[LINEAR.updateIssue].build({ args: { issueId: "X", assigneeId: "u2" }, result: {}, before: { issue: { assignee: null } } })).toBeUndefined();
    expect(INVERSES[LINEAR.createIssue].build({ args: {}, result: {} })).toBeUndefined();
    expect(findId({ data: { issue: { id: "deep" } } })).toBe("deep");
    expect(findId({ id: "top", data: { id: "lower" } })).toBe("top");
    expect(findId("nothing")).toBeUndefined();
  });
});
