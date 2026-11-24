import { beforeEach, describe, expect, it } from "vitest";
import { Asks, type AskKind } from "../src/asks.js";
import { askMerge, MERGE_FILED, mergeKind, withdrawMerges, type MergePayload, type PrepareMergeDeps } from "../src/asks/merge.js";
import { FakeConversation } from "./helpers/conversation.js";
import { Store } from "../src/store.js";

const USER = "user-1";
const SHA = "abcdef1234567890abcdef1234567890abcdef12";

let store: Store;
let conv: FakeConversation;
let asks: Asks;
let now = 1_000_000;
let kind: AskKind<MergePayload>;
let deps: PrepareMergeDeps;
let pr: Record<string, any>;
let calls: { method: string; url: string; body?: any }[];
let answers: Record<string, { status: number; body: unknown } | Error>;

/** GitHub, as the tests need it: answers by method and path. */
const fetchFn = (async (url: string, init: RequestInit) => {
  const path = url.replace("https://api.github.com", "");
  const method = init.method ?? "GET";
  calls.push({ method, url: path, ...(init.body ? { body: JSON.parse(String(init.body)) } : {}) });
  const answer = answers[`${method} ${path}`] ?? (method === "GET" && path === "/repos/octo/widgets/pulls/7" ? { status: 200, body: pr } : undefined);
  if (answer instanceof Error) throw answer;
  if (answer === undefined) return new Response("{}", { status: 404 });
  return new Response(JSON.stringify(answer.body), { status: answer.status });
}) as unknown as typeof fetch;

const allow = () => asks.answer(merges()[0]!.id, { action: "allow" });
const block = () => asks.answer(merges()[0]!.id, { action: "block" });

const ask = (a: { number: number; repo?: string } = { number: 7 }, clot = "graphite") => askMerge(asks, kind, deps, clot, a, false);
const merges = () => store.openAsks().filter((row) => row.kind === "merge");

beforeEach(async () => {
  store = new Store(":memory:");
  conv = new FakeConversation();
  calls = [];
  pr = { state: "open", draft: false, merged: false, title: "Fix login", html_url: "https://github.com/octo/widgets/pull/7", head: { ref: "clot/fix-login-1a2b", sha: SHA, repo: { full_name: "Octo/Widgets" } }, base: { ref: "main" }, changed_files: 3, additions: 40, deletions: 2 };
  answers = {
    "GET /repos/octo/widgets": { status: 200, body: { default_branch: "main" } },
    [`GET /repos/octo/widgets/commits/${SHA}/check-runs?per_page=100`]: { status: 200, body: { total_count: 3, check_runs: [{ status: "completed", conclusion: "success" }, { status: "completed", conclusion: "failure" }, { status: "in_progress" }] } },
    [`GET /repos/octo/widgets/commits/${SHA}/status`]: { status: 200, body: { statuses: [{ state: "success" }] } },
    "PUT /repos/octo/widgets/pulls/7/merge": { status: 200, body: { merged: true } },
  };
  for (const name of ["graphite", "home"]) {
    store.upsertClot(name);
    store.createSession({ id: `s-${name}`, clot: name, seed: null });
  }
  kind = mergeKind({ token: "tok", fetchFn });
  deps = { token: "tok", fetchFn, repoOf: (clot) => (clot === "graphite" ? "octo/widgets" : null), workerRepos: (clot) => (clot === "home" ? ["octo/widgets"] : []) };
  asks = new Asks({ store, conv, now: () => now, kick: () => undefined, after: () => () => undefined, emit: () => undefined, timeoutMs: () => 10 * 60_000, kinds: [kind] });
});

describe("merge_pull_request", () => {
  it("asks with the pull request, its base, its size and its checks, as a card", async () => {
    expect(await ask()).toBe(MERGE_FILED);
    const [row] = merges();
    expect(asks.snapshot(row)!.view).toEqual({
      heading: "Allow graphite to merge a pull request?",
      shortHeading: "Allow merging a pull request?",
      rows: [
        { label: "Pull request", value: 'octo/widgets#7, "Fix login"', href: "https://github.com/octo/widgets/pull/7" },
        { label: "Into", value: "main" },
        { label: "Changes", value: "3 files, +40 −2" },
        { label: "Commit", value: "abcdef1" },
        { label: "Checks", value: "2 passed, 1 failed, 1 pending." },
      ],
      labels: { allow: "Merge", block: "Don't merge" },
    });
    expect(conv.asksPosted).toEqual([{ clot: "graphite", askId: row.id }]);
  });

  it("shows Checks: unknown when the checks cannot be read, and opens one ask per pull request", async () => {
    answers[`GET /repos/octo/widgets/commits/${SHA}/status`] = { status: 500, body: {} };
    await ask();
    expect(asks.snapshot(merges()[0]!)!.view.rows.find((r) => r.label === "Checks")!.value).toBe("unknown.");
    expect(await ask()).toContain("already with the user");
  });

  it("refuses a draft, a branch that is not a clot/ one, a fork, a closed pull request and another base", async () => {
    const cases: [Record<string, any>, string][] = [
      [{ draft: true }, "is a draft"],
      [{ head: { ...pr.head, ref: "feature/x" } }, "not on a clot/ branch"],
      [{ head: { ...pr.head, repo: { full_name: "someone/widgets" } } }, "comes from another repository"],
      [{ state: "closed" }, "is closed"],
      [{ state: "closed", merged: true }, "already merged"],
      [{ base: { ref: "release" } }, "not the default branch main"],
    ];
    const original = pr;
    for (const [change, reason] of cases) {
      pr = { ...original, ...change };
      expect(await ask()).toContain(reason);
    }
    expect(merges()).toEqual([]);
  });

  it("keeps a project Clot to its own repository, and the home Clot to its workers' ones", async () => {
    expect(await ask({ number: 7, repo: "someone/else" })).toContain("only in your own repository, octo/widgets");
    expect(await ask({ number: 7 }, "home")).toContain("give the repository");
    expect(await ask({ number: 7, repo: "someone/else" }, "home")).toContain("none of your workers");
    expect(await ask({ number: 7, repo: "Octo/Widgets" }, "home")).toBe(MERGE_FILED);
    expect(calls.every((c) => !c.url.includes("someone"))).toBe(true);
  });

  it("refuses a repository name GitHub would not allow before building any address", async () => {
    deps.workerRepos = () => ["../../x"];
    expect(await ask({ number: 7, repo: "../../x" }, "home")).toContain("owner/name");
    expect(calls).toEqual([]);
  });

  it("merges on Allow, pinned to the commit shown, and posts Merged", async () => {
    await ask();
    await allow();
    expect(calls.find((c) => c.method === "PUT")).toEqual({ method: "PUT", url: "/repos/octo/widgets/pulls/7/merge", body: { merge_method: "squash", sha: SHA } });
    expect(conv.texts()).toEqual(["Merged octo/widgets#7."]);
    expect(merges()).toEqual([]);
  });

  it("posts GitHub's refusal as it came, and closes the ask", async () => {
    answers["PUT /repos/octo/widgets/pulls/7/merge"] = { status: 409, body: { message: "Head branch was modified. Review and try the merge again." } };
    await ask();
    await allow();
    expect(conv.texts()).toEqual(["GitHub refused to merge octo/widgets#7: Head branch was modified. Review and try the merge again."]);
    expect(store.notes("graphite")[0].text).toBe("GitHub refused the merge: Head branch was modified. Review and try the merge again.");
    expect(merges()).toEqual([]);
  });

  it("asks GitHub once after an unclear answer, and reports what it says", async () => {
    answers["PUT /repos/octo/widgets/pulls/7/merge"] = new Error("socket hang up");
    await ask();
    pr = { ...pr, state: "closed", merged: true };
    await allow();
    expect(conv.texts()).toEqual(["Merged octo/widgets#7."]);

    pr = { ...pr, state: "open", merged: false };
    answers["PUT /repos/octo/widgets/pulls/7/merge"] = { status: 502, body: {} };
    await ask();
    await allow();
    expect(store.notes("graphite").at(-1)!.text).toBe("GitHub did not answer clearly; the pull request is not merged. Ask again if it should be.");
  });

  it("leaves it open on Block, and hands other text typed in the chat to the main session", async () => {
    await ask();
    await block();
    expect(conv.texts()).toEqual(["Not merged: octo/widgets#7 stays open."]);
    expect(calls.some((c) => c.method === "PUT")).toBe(false);

    await ask();
    expect(await asks.onUserMessage("graphite", "wait until the review is in")).toBe(true);
    expect(store.nextPending("graphite")!.text).toContain("wait until the review is in");
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
  });

  it("is blocked at its deadline: not merged, the Clot told, the card says why", async () => {
    await ask();
    const row = merges()[0]!;
    await asks.sweep(false);
    expect(merges()).toHaveLength(1);
    now = row.deadline! + 1;
    await asks.sweep(false);
    expect(merges()).toEqual([]);
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
    expect(conv.texts()).toEqual(["Blocked: no answer within 10 minutes."]);
    expect(store.notes("graphite")[0]!.text).toContain("so it was not merged");
  });

  it("warns on the card when the ask came from an outsider's turn", async () => {
    await askMerge(asks, kind, deps, "graphite", { number: 7 }, true);
    expect(asks.snapshot(merges()[0]!)!.view.warning).toBe("From an outsider's report.");
  });

  it("is withdrawn by new commits on the pull request, but not by a replay of the commit shown or by a fork", async () => {
    await ask();
    const push = (headSha: string, headRepo = "Octo/Widgets") => withdrawMerges(asks, { repo: "Octo/Widgets", headRepo, number: 7, action: "synchronize", headSha });
    await push(SHA);
    expect(merges()).toHaveLength(1);
    await push("f".repeat(40), "someone/widgets");
    expect(merges()).toHaveLength(1);
    await push("f".repeat(40));
    expect(merges()).toEqual([]);
    expect(conv.texts()).toEqual(['Withdrawn: Merge octo/widgets#7, "Fix login" (new commits were pushed)']);
  });

  it("is withdrawn when the pull request closes", async () => {
    await ask();
    await withdrawMerges(asks, { repo: "octo/widgets", headRepo: "octo/widgets", number: 7, action: "closed", headSha: SHA });
    expect(merges()).toEqual([]);
    expect(conv.texts()[0]).toContain("(the pull request was closed)");
  });

  it("says the outcome is not known when the merge answer is unclear and the pull request cannot be read", async () => {
    answers["PUT /repos/octo/widgets/pulls/7/merge"] = { status: 502, body: {} };
    await ask();
    answers["GET /repos/octo/widgets/pulls/7"] = { status: 500, body: {} };
    await allow();
    expect(conv.texts()).toEqual(["Whether octo/widgets#7 was merged is not known; check it on GitHub."]);
  });

  it("tells, after a stop in the middle, whether it was merged", async () => {
    await ask();
    store.moveAsk(merges()[0].id, "open", "busy");
    pr = { ...pr, state: "closed", merged: true };
    await asks.sweep(true);
    expect(conv.texts()).toEqual(["Merged octo/widgets#7."]);
  });
});
