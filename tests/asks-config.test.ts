import { beforeEach, describe, expect, it } from "vitest";
import { Asks, type AskKind } from "../src/asks.js";
import { configKind, restartKind, type ConfigPayload, type RestartPayload } from "../src/asks/config.js";
import { FakeConversation } from "./helpers/conversation.js";
import { Store } from "../src/store.js";

let store: Store;
let conv: FakeConversation;
let applied: [string, unknown][];
let result: { ok: boolean; text: string };
let restarts: number;
let restartResult: boolean;
let order: string[];
let asks: Asks;
let config: AskKind<ConfigPayload>;
let restart: AskKind<RestartPayload>;
let now: number;

const open = (kind: string) => store.openAsks("home").filter((a) => a.kind === kind);

beforeEach(() => {
  store = new Store(":memory:");
  conv = new FakeConversation();
  applied = [];
  restarts = 0;
  restartResult = true;
  now = 1_000_000;
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
  asks = new Asks({ store, conv, now: () => now, kick: () => undefined, after: () => () => undefined, emit: () => undefined, timeoutMs: () => 10 * 60_000, kinds: [config, restart] });
  store.upsertClot("home");
  store.createSession({ id: "s1", clot: "home", seed: null });
});

describe("the config ask", () => {
  const file = () => asks.open(config, "home", { key: "sources.composio", value: [{ toolkit: "elevenlabs" }], current: [] }, { summary: "change sources.composio", dedupe: "sources.composio", max: 3 });

  it("shows the key, what it holds now and the new value as a card", async () => {
    await file();
    const [row] = open("config");
    const view = asks.snapshot(row)!.view;
    expect(view).toMatchObject({ heading: "Allow Home to change a setting?", rows: [{ label: "Setting", value: "sources.composio" }, { label: "File", value: "clots.config.json" }], previous: "[]", labels: { allow: "Save", block: "Decline" } });
    expect(view.body).toContain('"toolkit": "elevenlabs"');
  });

  it("saves exactly the stored value on Allow, says so, and hands the Clot a message that carries on", async () => {
    await file();
    await asks.answer(open("config")[0]!.id, { action: "allow" });
    expect(applied).toEqual([["sources.composio", [{ toolkit: "elevenlabs" }]]]);
    expect(conv.texts().at(-1)).toBe("Saved sources.composio.");
    const row = store.nextPending("home")!;
    expect(row.text).toContain("X_KEY");
    expect(open("config")).toEqual([]);
  });

  it("changes nothing on Block, and passes text typed in the chat to the Clot", async () => {
    await file();
    await asks.answer(open("config")[0]!.id, { action: "block" });
    expect(applied).toEqual([]);
    expect(store.notes("home")[0]!.text).toContain("declined");
    await file();
    expect(await asks.onUserMessage("home", "use the eu region instead")).toBe(true);
    expect(applied).toEqual([]);
    expect(store.nextPending("home")!.text).toContain("use the eu region instead");
  });

  it("is blocked at its deadline and changes nothing", async () => {
    await file();
    now += 10 * 60_000;
    await asks.sweep(false);
    expect(open("config")).toEqual([]);
    expect(applied).toEqual([]);
    expect(conv.texts().at(-1)).toBe("Blocked: no answer within 10 minutes.");
  });

  it("reports a save that failed on Allow", async () => {
    result = { ok: false, text: "Not changed: x" };
    await file();
    await asks.answer(open("config")[0]!.id, { action: "allow" });
    expect(conv.texts().at(-1)).toBe("Not changed: x");
    expect(store.notes("home")[0]!.text).toContain("was not saved");
  });
});

describe("the restart ask", () => {
  const file = () => asks.open(restart, "home", { reason: "ElevenLabs was added" }, { summary: "restart the daemon", dedupe: "restart", max: 1 });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("restarts only on Allow, after saying so, and not on Block", async () => {
    await file();
    await asks.answer(open("restart")[0]!.id, { action: "block" });
    expect(restarts).toBe(0);
    await file();
    expect(asks.snapshot(open("restart")[0]!)!.view.warning).toContain("waits until every turn has finished");
    await asks.answer(open("restart")[0]!.id, { action: "allow" });
    await settle();
    expect(restarts).toBe(1);
    expect(conv.texts().at(-1)).toBe("Restarting the daemon now.");
  });

  it("does not hold the answer while it waits for turns to end", async () => {
    let release: () => void = () => undefined;
    restart = restartKind({ restartWhenIdle: () => new Promise<boolean>((resolve) => (release = () => resolve(true))) });
    asks = new Asks({ store, conv, now: () => now, kick: () => undefined, after: () => () => undefined, emit: () => undefined, timeoutMs: () => 10 * 60_000, kinds: [config, restart] });
    await file();
    const result = await asks.answer(open("restart")[0]!.id, { action: "allow" });
    expect(result).toEqual({ status: "answered", outcome: null });
    expect(open("restart")[0]!.state).toBe("busy");
    release();
  });

  it("leaves a message typed in the chat to the Clot, and restarts nothing", async () => {
    await file();
    expect(await asks.onUserMessage("home", "hmm")).toBe(false);
    expect(restarts).toBe(0);
    expect(open("restart")).toHaveLength(1);
  });

  it("tells the Clot when turns kept running too long to restart", async () => {
    restartResult = false;
    await file();
    await asks.answer(open("restart")[0]!.id, { action: "allow" });
    await settle();
    expect(conv.texts().at(-1)).toContain("Restart not made");
    expect(store.notes("home")[0]!.text).toContain("not made");
  });
});
