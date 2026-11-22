import { beforeEach, describe, expect, it } from "vitest";
import { Asks, type AskKind } from "../src/asks.js";
import { configKind, restartKind, type ConfigPayload, type RestartPayload } from "../src/asks/config.js";
import type { InboundMessage } from "../src/chat/adapter.js";
import { FakeChat } from "../src/chat/fake.js";
import { Store } from "../src/store.js";

const USER = "user-1";
let store: Store;
let chat: FakeChat;
let said: string[];
let applied: [string, unknown][];
let result: { ok: boolean; text: string };
let restarts: number;
let restartResult: boolean;
let order: string[];
let asks: Asks;
let config: AskKind<ConfigPayload>;
let restart: AskKind<RestartPayload>;
let n = 0;

const reply = (channelId: string, text: string): InboundMessage => ({ id: `r${(n += 1)}`, channelId, authorId: USER, text, at: new Date(0) });
const open = (kind: string) => store.openAsks("home").filter((a) => a.kind === kind);

beforeEach(async () => {
  store = new Store(":memory:");
  chat = new FakeChat();
  said = [];
  applied = [];
  restarts = 0;
  restartResult = true;
  order = [];
  result = { ok: true, text: "Saved sources.composio. It takes effect when the daemon restarts. The user still has to add `X_KEY` to the `.env` file." };
  config = configKind({ apply: (key, value) => (applied.push([key, value]), result) });
  restart = restartKind({
    restartWhenIdle: async (beforeExit) => {
      restarts += 1;
      if (restartResult) await beforeExit();
      return restartResult;
    },
  });
  asks = new Asks({ store, chat, userId: USER, now: () => 1, kick: () => undefined, say: async (_c, t) => void said.push(t), after: () => () => undefined, kinds: [config, restart] });
  const category = await chat.ensureCategory("home");
  store.upsertClot("home", category);
  store.createSession({ id: "s1", clot: "home", channelId: await chat.createChannel(category, "home-1"), seed: null });
});

describe("the config ask", () => {
  const file = () => asks.open(config, "home", { key: "sources.composio", value: [{ toolkit: "elevenlabs" }], current: [] }, { summary: "change sources.composio", dedupe: "sources.composio", max: 3 });

  it("shows the key, what it holds now and the new value in <clot>-config", async () => {
    await file();
    const [row] = open("config");
    expect(row.channelName).toBe("home-config");
    const post = chat.postsIn(row.channelId)[0];
    expect(post).toContain("asks to change `sources.composio`");
    expect(post).toContain('"toolkit": "elevenlabs"');
    expect(post).toContain("Now:");
  });

  it("saves exactly the stored value on yes, says so, and hands the Clot a message that carries on", async () => {
    await file();
    const channel = open("config")[0]!.channelId;
    await asks.onReply(reply(channel, "yes"));
    expect(applied).toEqual([["sources.composio", [{ toolkit: "elevenlabs" }]]]);
    expect(said.at(-1)).toBe("Saved sources.composio.");
    const row = store.nextPending("home")!;
    expect(row.text).toContain("X_KEY");
    expect(row.text).toContain("daemon_restart");
    expect(open("config")).toEqual([]);
  });

  it("changes nothing on no, and passes any other reply to the Clot", async () => {
    await file();
    await asks.onReply(reply(open("config")[0]!.channelId, "no"));
    expect(applied).toEqual([]);
    expect(store.notes("home")[0]!.text).toContain("declined");
    await file();
    await asks.onReply(reply(open("config")[0]!.channelId, "use the eu region instead"));
    expect(applied).toEqual([]);
    expect(store.nextPending("home")!.text).toContain("use the eu region instead");
  });

  it("reports a save that failed on a yes", async () => {
    result = { ok: false, text: "Not changed: x" };
    await file();
    await asks.onReply(reply(open("config")[0]!.channelId, "yes"));
    expect(said.at(-1)).toBe("Not changed: x");
    expect(store.notes("home")[0]!.text).toContain("was not saved");
  });
});

describe("the restart ask", () => {
  const file = () => asks.open(restart, "home", { reason: "ElevenLabs was added" }, { summary: "restart the daemon", dedupe: "restart", max: 1 });

  it("restarts only on a yes, after saying so, and not on no", async () => {
    await file();
    await asks.onReply(reply(open("restart")[0]!.channelId, "no"));
    expect(restarts).toBe(0);
    await file();
    expect(chat.postsIn(open("restart")[0]!.channelId)[0]).toContain("waits until every Clot's turn has finished");
    await asks.onReply(reply(open("restart")[0]!.channelId, "yes"));
    expect(restarts).toBe(1);
    expect(said.at(-1)).toBe("Restarting the daemon now.");
  });

  it("repeats the question on an unclear reply and restarts nothing", async () => {
    await file();
    const channel = open("restart")[0]!.channelId;
    await asks.onReply(reply(channel, "hmm"));
    expect(restarts).toBe(0);
    expect(open("restart")).toHaveLength(1);
  });

  it("tells the Clot when turns kept running too long to restart", async () => {
    restartResult = false;
    await file();
    await asks.onReply(reply(open("restart")[0]!.channelId, "yes"));
    expect(said.at(-1)).toContain("Restart not made");
    expect(store.notes("home")[0]!.text).toContain("not made");
  });
});
