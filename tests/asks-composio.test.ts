import { beforeEach, describe, expect, it } from "vitest";
import { Asks, OUTSIDER_MAX, type AskKind } from "../src/asks.js";
import { composioKind, COMPOSIO_FILED, type ComposioPayload } from "../src/asks/composio.js";
import type { InboundMessage } from "../src/chat/adapter.js";
import { FakeChat } from "../src/chat/fake.js";
import { ComposioActions, type ActionContext } from "../src/composio/actions.js";
import { Composio } from "../src/composio/component.js";
import { LINEAR } from "../src/composio/toolkits/linear.js";
import type { ComposioAccount } from "../src/config.js";
import { Supervisor } from "../src/listeners.js";
import { Store } from "../src/store.js";
import { FakeComposioApi, tool } from "./fake-composio.js";

const USER = "user-1";
const NOW = Date.UTC(2026, 10, 19, 12, 0, 0);
const base = { shared: false, triggers: [] };
const pub: ComposioAccount = { ...base, toolkit: "linear", account: "proton", clot: "graphite", audience: "public", apiKey: "lin_api_SECRET", apiKeyName: "K" };
const ctx: ActionContext = { clot: "graphite", kind: "chat", outsider: false, userText: "make it so" };

let store: Store;
let chat: FakeChat;
let api: FakeComposioApi;
let composio: Composio;
let actions: ComposioActions;
let kind: AskKind<ComposioPayload>;
let asks: Asks;
let said: string[];
let kicked: string[];
let n: number;

function build(accounts: ComposioAccount[]) {
  composio = new Composio({ api, store, accounts, publicUrl: "https://x.example", tell: async () => {}, tellHome: async () => {}, now: () => NOW, schedule: () => () => {}, supervisor: new Supervisor({ schedule: () => () => {} }), log: () => {} });
  const holder: { actions?: ComposioActions } = {};
  kind = composioKind({ composio, actions: new Proxy({} as ComposioActions, { get: (_t, key) => (holder.actions as any)[key].bind(holder.actions) }) });
  asks = new Asks({ store, chat, userId: USER, now: () => NOW, kick: (clot) => void kicked.push(clot), say: async (_c, text) => void said.push(text), after: () => () => undefined, kinds: [kind] });
  actions = new ComposioActions({
    composio,
    store,
    reviewer: { review: async () => ({ verdict: "ask", reason: "x" }) },
    ask: (clot, payload, o) => asks.open(kind, clot, payload, { summary: o.summary, dedupe: o.dedupe, max: 5, outsider: o.outsider }),
    say: async (_c, text) => void said.push(text),
    now: () => NOW,
    log: () => {},
  });
  holder.actions = actions;
}

const reply = (channelId: string, text: string): InboundMessage => ({ id: `r${(n += 1)}`, channelId, authorId: USER, text, at: new Date(0) });
const open = () => store.openAsks("graphite").filter((a) => a.kind === "composio");
const pending = () => {
  const row = store.nextPending("graphite");
  if (row) store.setInboxStatus(row.id, "done");
  return row;
};
const writes = () => api.of("execute").filter((c) => c.includes(LINEAR.createIssue));
const args = { team_id: "t", title: "Fix the thing", description: "with `backticks` and ``` fences" };

beforeEach(async () => {
  store = new Store(":memory:");
  chat = new FakeChat();
  api = new FakeComposioApi();
  said = [];
  kicked = [];
  n = 0;
  const category = await chat.ensureCategory("graphite");
  store.upsertClot("graphite", category);
  store.createSession({ id: "s1", clot: "graphite", channelId: await chat.createChannel(category, "graphite-1"), seed: null });
  build([pub]);
  api.tools.set(LINEAR.createIssue, tool(LINEAR.createIssue, ["createHint"], { name: "Create Linear issue", description: "Creates an issue." }));
  api.answers.set(LINEAR.createIssue, { ok: true, data: { id: "issue-1", url: "https://linear.app/x/issue/CLO-1" } });
  api.answers.set(LINEAR.archiveIssue, { ok: true, data: {} });
});

const ask = (a: Record<string, unknown> = args) => actions.run(ctx, { account: "linear:proton", tool: LINEAR.createIssue, args: a });

describe("the composio ask", () => {
  it("puts a public account's write to the user in <clot>-ask, with every argument, the audience and the reason, and tells the Clot not to wait", async () => {
    expect(await ask()).toBe(COMPOSIO_FILED);
    expect(writes()).toEqual([]);
    const [row] = open();
    expect(row.channelName).toBe("graphite-ask");
    const post = chat.postsIn(row.channelId)[0];
    expect(post).toContain("<@user-1> graphite asks to run Create Linear issue (LINEAR_CREATE_LINEAR_ISSUE) in linear:proton, a public account.");
    expect(post).toContain("Why it asks: this account is public.");
    expect(post).toContain('"title": "Fix the thing"');
    expect(post).toContain("with `backticks` and '''' fences".replace("''''", "'''"));
    expect(post).toContain("yes runs it exactly as shown; no declines it.");
    // The fence in the arguments cannot close the block it is shown in.
    expect(post.match(/```/g)).toHaveLength(2);
  });

  it("runs exactly the stored arguments once on yes, posts the write with its undo, and tells the Clot", async () => {
    await ask();
    const channel = open()[0].channelId;
    await asks.onReply(reply(channel, "yes"));
    expect(writes()).toEqual([`execute:linear:proton ${LINEAR.createIssue} ${JSON.stringify(args)}`]);
    expect(said.at(-1)).toContain("Composio (linear proton): Create Linear issue, https://linear.app/x/issue/CLO-1");
    expect(said.at(-1)).toContain("`&composio undo` reverses it.");
    expect(pending()).toBeUndefined();
    expect(store.notes("graphite")[0].text).toContain("The user approved Create Linear issue in linear:proton, and it ran.");
    expect(chat.deleted).toContain(channel);
    expect(open()).toEqual([]);
    // It was logged like any write, so it has its undo.
    expect(store.composio.latestUndoable("graphite")).toMatchObject({ slug: LINEAR.createIssue, args });
    // A second yes finds the ask closed and runs nothing again.
    await asks.onReply(reply(channel, "yes"));
    expect(writes()).toHaveLength(1);
  });

  it("declines on no, runs nothing, and tells the Clot not to ask again", async () => {
    await ask();
    await asks.onReply(reply(open()[0].channelId, "No"));
    expect(writes()).toEqual([]);
    expect(open()).toEqual([]);
    expect(said.at(-1)).toBe("Declined: Create Linear issue in linear:proton.");
    expect(store.notes("graphite")[0].text).toContain("The user declined Create Linear issue in linear:proton; nothing was changed.");
  });

  it("passes any other reply to the main session as the user's feedback and closes the ask", async () => {
    await ask();
    await asks.onReply(reply(open()[0].channelId, "make the title shorter first"));
    expect(writes()).toEqual([]);
    expect(open()).toEqual([]);
    expect(pending()!.text).toBe("[The user's reply to your ask to run Create Linear issue in linear:proton. It was not run, and the ask is closed:]\nmake the title shorter first");
    expect(kicked).toEqual(["graphite"]);
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
    expect(chat.postsIn(open()[0].channelId)[0]).toContain("From an outsider's report.");
    await asks.onReply(reply(open()[0].channelId, "why?"));
    expect(pending()).toMatchObject({ outsider: true });
  });

  it("withdraws a yes when the account was removed or its audience changed since it was shown, and runs nothing", async () => {
    await ask();
    build([{ ...pub, audience: "team" }]);
    asks = new Asks({ store, chat, userId: USER, now: () => NOW, kick: () => undefined, say: async (_c, text) => void said.push(text), after: () => () => undefined, kinds: [kind] });
    await asks.onReply(reply(open()[0].channelId, "yes"));
    expect(writes()).toEqual([]);
    expect(said.at(-1)).toContain("changed since");
  });

  it("says what it could not do when the approved write fails", async () => {
    await ask();
    api.answers.set(LINEAR.createIssue, { ok: false, error: "Entity not found", reason: "refused" });
    await asks.onReply(reply(open()[0].channelId, "yes"));
    expect(said.at(-1)).toContain("Entity not found");
    expect(open()).toEqual([]);
  });

  it("closes one the daemon stopped in the middle of, saying that whether it ran is not known", async () => {
    await ask();
    const [row] = open();
    expect(row.state).toBe("open");
    await kind.interrupted!({ ...row, payload: row.payload as ComposioPayload } as any, { close: async (note: string | null) => void (said.push(String(note)), true) } as any);
    expect(said.at(-1)).toContain("whether it ran is not known");
  });
});
