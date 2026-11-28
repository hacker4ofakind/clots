import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { acceptGithub } from "../src/intake.js";
import { checklist, markPush, markWebhook, resetWebhook } from "../src/onboarding/checklist.js";
import { Store } from "../src/store.js";

const secret = "s3cret";
const body = (value: unknown) => Buffer.from(JSON.stringify(value));
const sign = (raw: Buffer) => `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;
const delivery = (value: unknown, eventName: string) => {
  const rawBody = body(value);
  return { signature: sign(rawBody), eventName, deliveryId: `d-${eventName}`, rawBody };
};
const item = (items: ReturnType<typeof checklist>, id: string) => items.find((i) => i.id === id)!;

describe("a new Clot's checklist", () => {
  it("starts with nothing done, apart from a step with nothing to check", () => {
    const store = new Store(":memory:");
    const items = checklist({ marks: store, repo: "octo/widgets", tools: [], hasPullRequest: false });
    expect(items.map((i) => [i.id, i.done])).toEqual([["webhook", false], ["tools", true], ["push-branch", false]]);
    expect(item(items, "webhook").detail).toContain("octo/widgets");
  });

  it("ticks the webhook when GitHub's ping for that repository arrives, and keeps it ticked after a restart", () => {
    const store = new Store(":memory:");
    const pinged: string[] = [];
    const deps = { secret, insertEvent: () => true, now: () => 1, onPing: (repo: string) => (pinged.push(repo), markWebhook(store, repo)) };
    expect(acceptGithub(delivery({ zen: "x", repository: { full_name: "Octo/Other" } }, "ping"), deps)).toEqual({ status: 200, text: "ignored" });
    expect(item(checklist({ marks: store, repo: "octo/widgets", tools: [], hasPullRequest: false }), "webhook").done).toBe(false);
    acceptGithub(delivery({ zen: "x", repository: { full_name: "Octo/Widgets" } }, "ping"), deps);
    expect(pinged).toEqual(["octo/other", "octo/widgets"]);
    // The marks are in the store, not in memory: a new checklist over the same store still has them.
    expect(item(checklist({ marks: store, repo: "octo/widgets", tools: [], hasPullRequest: false }), "webhook").done).toBe(true);
  });

  it("opens the webhook step again when it is reset, for that repository only", () => {
    const store = new Store(":memory:");
    markWebhook(store, "octo/widgets");
    markWebhook(store, "octo/other");
    resetWebhook(store, "Octo/Widgets");
    expect(item(checklist({ marks: store, repo: "octo/widgets", tools: [], hasPullRequest: false }), "webhook").done).toBe(false);
    expect(item(checklist({ marks: store, repo: "octo/other", tools: [], hasPullRequest: false }), "webhook").done).toBe(true);
  });

  it("ticks the branch step on the first push by the Clots' own account, not by anyone else", () => {
    const store = new Store(":memory:");
    const seen: [string, string][] = [];
    const deps = { secret, insertEvent: () => true, now: () => 1, onPush: (repo: string, sender: string) => void (seen.push([repo, sender]), markPush(store, repo, sender, "widgets-clot")) };
    acceptGithub(delivery({ ref: "refs/heads/main", repository: { full_name: "octo/widgets" }, sender: { login: "someone" } }, "push"), deps);
    expect(item(checklist({ marks: store, repo: "octo/widgets", tools: [], hasPullRequest: false }), "push-branch").done).toBe(false);
    acceptGithub(delivery({ ref: "refs/heads/clot/fix-1a2b", repository: { full_name: "Octo/Widgets" }, sender: { login: "Widgets-Clot" } }, "push"), deps);
    expect(seen).toEqual([["octo/widgets", "someone"], ["octo/widgets", "Widgets-Clot"]]);
    expect(item(checklist({ marks: store, repo: "octo/widgets", tools: [], hasPullRequest: false }), "push-branch").done).toBe(true);
    expect(markPush(store, "octo/x", "anyone", "")).toBe(false);
  });

  it("counts a pull request one of its workers opened as a pushed branch", () => {
    expect(item(checklist({ marks: new Store(":memory:"), repo: "octo/widgets", tools: [], hasPullRequest: true }), "push-branch").done).toBe(true);
  });

  it("is done for tools only when every tool is connected, and says which is still waiting", () => {
    const store = new Store(":memory:");
    const some = checklist({ marks: store, repo: null, tools: [{ id: "linear:team", active: true }, { id: "slack:shop", active: false }], hasPullRequest: false });
    expect(item(some, "tools")).toMatchObject({ done: false, detail: "Waiting for slack:shop to connect." });
    const all = checklist({ marks: store, repo: null, tools: [{ id: "linear:team", active: true }], hasPullRequest: false });
    expect(item(all, "tools")).toMatchObject({ done: true, detail: "1 connected." });
  });
});
