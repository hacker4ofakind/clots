import { beforeEach, describe, expect, it } from "vitest";
import { Asks, OUTSIDER_MAX, type AskKind } from "../src/asks.js";
import { composioKind, COMPOSIO_FILED, type ComposioPayload } from "../src/asks/composio.js";
import { FakeConversation } from "./helpers/conversation.js";
import { ComposioActions, type ActionContext } from "../src/composio/actions.js";
import { Composio } from "../src/composio/component.js";
import { LINEAR } from "../src/composio/toolkits/linear.js";
import type { ComposioAccount } from "../src/config.js";
import { Supervisor } from "../src/listeners.js";
import { Store } from "../src/store.js";
import { FakeComposioApi, tool } from "./fake-composio.js";

const NOW = Date.UTC(2026, 10, 19, 12, 0, 0);
const base = { shared: false, triggers: [], selfIsUser: false };
const pub: ComposioAccount = { ...base, toolkit: "linear", account: "proton", clot: "graphite", audience: "public", apiKey: "lin_api_SECRET", apiKeyName: "K" };
const ctx: ActionContext = { clot: "graphite", kind: "chat", outsider: false, userText: "make it so" };

let store: Store;
let conv: FakeConversation;
let api: FakeComposioApi;
let composio: Composio;
let actions: ComposioActions;
let kind: AskKind<ComposioPayload>;
let asks: Asks;
let kicked: string[];
let now = NOW;

function build(accounts: ComposioAccount[]) {
  composio = new Composio({ api, store, accounts, publicUrl: "https://x.example", tell: async () => {}, tellHome: async () => {}, now: () => NOW, schedule: () => () => {}, supervisor: new Supervisor({ schedule: () => () => {} }), log: () => {} });
  const holder: { actions?: ComposioActions } = {};
  kind = composioKind({ composio, actions: new Proxy({} as ComposioActions, { get: (_t, key) => (holder.actions as any)[key].bind(holder.actions) }) });
  asks = new Asks({ store, conv, now: () => now, kick: (clot) => void kicked.push(clot), after: () => () => undefined, emit: () => undefined, timeoutMs: () => 10 * 60_000, kinds: [kind] });
  actions = new ComposioActions({
    composio,
    store,
    reviewer: { review: async () => ({ verdict: "ask", reason: "x" }) },
    ask: (clot, payload, o) => asks.open(kind, clot, payload, { summary: o.summary, dedupe: o.dedupe, max: 5, outsider: o.outsider }),
    say: async (c, text) => void (await conv.post(c, text, { kind: "note" })),
    now: () => NOW,
    log: () => {},
  });
  holder.actions = actions;
}

const answer = (a: { action: "allow" | "block" }) => asks.answer(open()[0]!.id, a);
const open = () => store.openAsks("graphite").filter((a) => a.kind === "composio");
const pending = () => {
  const row = store.nextPending("graphite");
  if (row) store.setInboxStatus(row.id, "done");
  return row;
};
const writes = () => api.of("execute").filter((c) => c.includes(LINEAR.createIssue));
const args = { team_id: "t", title: "Fix the thing", description: "with `backticks` and ``` fences" };

beforeEach(() => {
  store = new Store(":memory:");
  conv = new FakeConversation();
  api = new FakeComposioApi();
  kicked = [];
  now = NOW;
  store.upsertClot("graphite");
  store.createSession({ id: "s1", clot: "graphite", seed: null });
  build([pub]);
  api.tools.set(LINEAR.createIssue, tool(LINEAR.createIssue, ["createHint"], { name: "Create Linear issue", description: "Creates an issue." }));
  api.answers.set(LINEAR.createIssue, { ok: true, data: { id: "issue-1", url: "https://linear.app/x/issue/CLO-1" } });
  api.answers.set(LINEAR.archiveIssue, { ok: true, data: {} });
});

const ask = (a: Record<string, unknown> = args) => actions.run(ctx, { account: "linear:proton", tool: LINEAR.createIssue, args: a });

describe("the composio ask", () => {
  it("puts a public account's write to the user as a card, with every argument, the audience and the reason, and tells the Clot not to wait", async () => {
    expect(await ask()).toBe(COMPOSIO_FILED);
    expect(writes()).toEqual([]);
    const [row] = open();
    const view = asks.snapshot(row)!.view;
    expect(view.heading).toBe("Allow graphite to run Create Linear issue?");
    expect(view.rows).toEqual([
      { label: "Account", value: "linear:proton (public)" },
      { label: "Tool", value: "LINEAR_CREATE_LINEAR_ISSUE" },
      { label: "What it does", value: "Creates an issue." },
      { label: "Why it asks", value: "this account is public" },
    ]);
    expect(view.body).toContain('"title": "Fix the thing"');
    expect(view.body).toContain("with `backticks` and ``` fences");
    expect(view.labels).toEqual({ allow: "Run", block: "Decline" });
  });

  it("runs exactly the stored arguments once on yes, posts the write with its undo, and tells the Clot", async () => {
    await ask();
    await answer({ action: "allow" });
    expect(writes()).toEqual([`execute:linear:proton ${LINEAR.createIssue} ${JSON.stringify(args)}`]);
    expect(conv.texts().at(-1)).toContain("Composio (linear proton): Create Linear issue, https://linear.app/x/issue/CLO-1");
    expect(conv.texts().at(-1)).toContain("`/composio undo` reverses it.");
    expect(pending()).toBeUndefined();
    expect(store.notes("graphite")[0].text).toContain("The user approved Create Linear issue in linear:proton, and it ran.");
    expect(open()).toEqual([]);
    // It was logged like any write, so it has its undo.
    expect(store.composio.latestUndoable("graphite")).toMatchObject({ slug: LINEAR.createIssue, args });
    // A second answer finds the ask closed and runs nothing again.
    expect(await asks.answer(1, { action: "allow" })).toMatchObject({ status: "closed" });
    expect(writes()).toHaveLength(1);
    expect(store.conversation.askOutcome(1)?.result).toBe("approved");
  });

  it("declines on Block, runs nothing, and tells the Clot not to ask again", async () => {
    await ask();
    await answer({ action: "block" });
    expect(writes()).toEqual([]);
    expect(open()).toEqual([]);
    expect(conv.texts().at(-1)).toBe("Declined: Create Linear issue in linear:proton.");
    expect(store.notes("graphite")[0].text).toContain("The user declined Create Linear issue in linear:proton; nothing was changed.");
    expect(store.conversation.askOutcome(1)?.result).toBe("declined");
  });

  it("passes any other reply to the main session as the user's feedback and closes the ask", async () => {
    await ask();
    expect(await asks.onUserMessage("graphite", "make the title shorter first")).toBe(true);
    expect(writes()).toEqual([]);
    expect(open()).toEqual([]);
    expect(pending()!.text).toBe("[The user's reply to your ask to run Create Linear issue in linear:proton. It was not run, and the ask is closed:]\nmake the title shorter first");
    expect(kicked).toEqual(["graphite"]);
    expect(store.conversation.askOutcome(1)?.result).toBe("feedback");
  });

  it("refuses the same write while it is already with the user, and any more than five at once", async () => {
    await ask();
    expect(await ask()).toContain("already with the user");
    for (let i = 0; i < 4; i++) await ask({ ...args, title: `t${i}` });
    expect(open()).toHaveLength(5);
    expect(await ask({ ...args, title: "sixth" })).toContain("5 writes are already with the user");
  });

  it("allows an outsider's turn only as many as the other kinds do, and carries its taint into the feedback", async () => {
    const outsider: ActionContext = { ...ctx, kind: "event", outsider: true };
    for (let i = 0; i < OUTSIDER_MAX; i++) await actions.run(outsider, { account: "linear:proton", tool: LINEAR.createIssue, args: { ...args, title: `o${i}` } });
    expect(open()).toHaveLength(OUTSIDER_MAX);
    expect(await actions.run(outsider, { account: "linear:proton", tool: LINEAR.createIssue, args: { ...args, title: "o-more" } })).toContain("already with the user");
    expect(asks.snapshot(open()[0]!)!.view.warning).toBe("From an outsider's report.");
    await asks.onUserMessage("graphite", "why?");
    expect(pending()).toMatchObject({ outsider: true });
  });

  it("withdraws a yes when the account was removed or its audience changed since it was shown, and runs nothing", async () => {
    await ask();
    build([{ ...pub, audience: "team" }]);
    asks = new Asks({ store, conv, now: () => now, kick: () => undefined, after: () => () => undefined, emit: () => undefined, timeoutMs: () => 10 * 60_000, kinds: [kind] });
    await answer({ action: "allow" });
    expect(writes()).toEqual([]);
    expect(conv.texts().at(-1)).toContain("changed since");
  });

  it("says what it could not do when the approved write fails", async () => {
    await ask();
    api.answers.set(LINEAR.createIssue, { ok: false, error: "Entity not found", reason: "refused" });
    await answer({ action: "allow" });
    expect(conv.texts().at(-1)).toContain("Entity not found");
    expect(open()).toEqual([]);
    expect(store.conversation.askOutcome(1)?.result).toBe("failed");
  });

  it("is blocked at its deadline: nothing runs, and the Clot is told", async () => {
    await ask();
    now += 10 * 60_000;
    await asks.sweep(false);
    expect(open()).toEqual([]);
    expect(writes()).toEqual([]);
    expect(conv.texts().at(-1)).toBe("Blocked: no answer within 10 minutes.");
    expect(store.notes("graphite")[0]!.text).toContain("so it was not run");
    expect(store.conversation.askOutcome(1)?.result).toBe("timed_out");
  });

  it("closes one the daemon stopped in the middle of, saying that whether it ran is not known", async () => {
    await ask();
    const [row] = open();
    expect(row.state).toBe("open");
    await kind.interrupted!({ ...row, payload: row.payload as ComposioPayload } as any, { close: async (_result: string, note: string | null) => void (await conv.post("graphite", String(note), { kind: "note" }), true) } as any);
    expect(conv.texts().at(-1)).toContain("whether it ran is not known");
  });
});
