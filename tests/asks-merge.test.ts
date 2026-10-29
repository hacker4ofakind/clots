import { beforeEach, describe, expect, it } from "vitest";
import { Asks, type AskKind } from "../src/asks.js";
import { askMerge, MERGE_FILED, mergeKind, withdrawMerges, type MergePayload, type PrepareMergeDeps } from "../src/asks/merge.js";
import type { InboundMessage } from "../src/chat/adapter.js";
import { FakeChat } from "../src/chat/fake.js";
import { Store } from "../src/store.js";

const USER = "user-1";
const SHA = "abcdef1234567890abcdef1234567890abcdef12";

let store: Store;
let chat: FakeChat;
let said: string[];
let asks: Asks;
let kind: AskKind<MergePayload>;
let deps: PrepareMergeDeps;
let pr: Record<string, any>;
let calls: { method: string; url: string; body?: any }[];
let answers: Record<string, { status: number; body: unknown } | Error>;
let n: number;

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

function reply(channelId: string, text: string, authorId = USER): InboundMessage {
  n += 1;
  return { id: `r${n}`, channelId, authorId, text, at: new Date(0) };
}

const ask = (a: { number: number; repo?: string } = { number: 7 }, clot = "graphite") => askMerge(asks, kind, deps, clot, a, false);
const merges = () => store.openAsks().filter((row) => row.kind === "merge");

beforeEach(async () => {
  store = new Store(":memory:");
  chat = new FakeChat();
  said = [];
  calls = [];
  n = 0;
  pr = { state: "open", draft: false, merged: false, title: "Fix login", html_url: "https://github.com/octo/widgets/pull/7", head: { ref: "clot/fix-login-1a2b", sha: SHA, repo: { full_name: "Octo/Widgets" } }, base: { ref: "main" }, changed_files: 3, additions: 40, deletions: 2 };
  answers = {
    "GET /repos/octo/widgets": { status: 200, body: { default_branch: "main" } },
    [`GET /repos/octo/widgets/commits/${SHA}/check-runs?per_page=100`]: { status: 200, body: { total_count: 3, check_runs: [{ status: "completed", conclusion: "success" }, { status: "completed", conclusion: "failure" }, { status: "in_progress" }] } },
    [`GET /repos/octo/widgets/commits/${SHA}/status`]: { status: 200, body: { statuses: [{ state: "success" }] } },
    "PUT /repos/octo/widgets/pulls/7/merge": { status: 200, body: { merged: true } },
  };
  for (const name of ["graphite", "home"]) {
    const category = await chat.ensureCategory(name);
    store.upsertClot(name, category);
    store.createSession({ id: `s-${name}`, clot: name, channelId: await chat.createChannel(category, `${name}-1010`), seed: null });
  }
  kind = mergeKind({ token: "tok", fetchFn });
  deps = { token: "tok", fetchFn, repoOf: (clot) => (clot === "graphite" ? "octo/widgets" : null), workerRepos: (clot) => (clot === "home" ? ["octo/widgets"] : []) };
  asks = new Asks({ store, chat, userId: USER, now: () => 0, kick: () => undefined, say: async (_clot, text) => void said.push(text), after: () => () => undefined, kinds: [kind] });
});

describe("merge_pull_request", () => {
  it("asks with the exact prompt, the counts, the base and the size, in a -ask channel", async () => {
    expect(await ask()).toBe(MERGE_FILED);
    const [row] = merges();
    expect(row.channelName).toBe("graphite-ask");
    expect(chat.postsIn(row.channelId)[0]).toBe(
      [
        '<@user-1> graphite asks to merge octo/widgets#7, "Fix login" (https://github.com/octo/widgets/pull/7), at commit abcdef1.',
        "Into main: 3 files changed, +40 −2.",
        "Checks: 2 passed, 1 failed, 1 pending.",
        "",
        "yes merges it (squash); no leaves it open.",
      ].join("\n"),
    );
  });

  it("shows Checks: unknown when the checks cannot be read, and opens one ask per pull request", async () => {
    answers[`GET /repos/octo/widgets/commits/${SHA}/status`] = { status: 500, body: {} };
    await ask();
    expect(chat.postsIn(merges()[0].channelId)[0]).toContain("\nChecks: unknown.\n");
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
    expect(chat.channels.map((c) => c.name)).toEqual(["home-1010", "graphite-1010"]);
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

  it("merges on a yes, pinned to the commit shown, and posts Merged", async () => {
    await ask();
    const channel = merges()[0].channelId;
    await asks.onReply(reply(channel, "yes"));
    expect(calls.find((c) => c.method === "PUT")).toEqual({ method: "PUT", url: "/repos/octo/widgets/pulls/7/merge", body: { merge_method: "squash", sha: SHA } });
    expect(said).toEqual(["Merged octo/widgets#7."]);
    expect(merges()).toEqual([]);
    expect(chat.deleted).toContain(channel);
  });

  it("posts GitHub's refusal as it came, and closes the ask", async () => {
    answers["PUT /repos/octo/widgets/pulls/7/merge"] = { status: 409, body: { message: "Head branch was modified. Review and try the merge again." } };
    await ask();
    await asks.onReply(reply(merges()[0].channelId, "yes"));
    expect(said).toEqual(["GitHub refused to merge octo/widgets#7: Head branch was modified. Review and try the merge again."]);
    expect(store.notes("graphite")[0].text).toBe("GitHub refused the merge: Head branch was modified. Review and try the merge again.");
    expect(merges()).toEqual([]);
  });

  it("asks GitHub once after an unclear answer, and reports what it says", async () => {
    answers["PUT /repos/octo/widgets/pulls/7/merge"] = new Error("socket hang up");
    await ask();
    pr = { ...pr, state: "closed", merged: true };
    await asks.onReply(reply(merges()[0].channelId, "yes"));
    expect(said).toEqual(["Merged octo/widgets#7."]);

    pr = { ...pr, state: "open", merged: false };
    answers["PUT /repos/octo/widgets/pulls/7/merge"] = { status: 502, body: {} };
    await ask();
    await asks.onReply(reply(merges()[0].channelId, "yes"));
    expect(store.notes("graphite").at(-1)!.text).toBe("GitHub did not answer clearly; the pull request is not merged. Ask again if it should be.");
  });

  it("leaves it open on a no, hands other text to the main session, and ignores anyone but the user", async () => {
    await ask();
    expect(await asks.onReply(reply(merges()[0].channelId, "yes", "someone-else"))).toBe(true);
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
    await asks.onReply(reply(merges()[0].channelId, "no"));
    expect(said).toEqual(["Not merged: octo/widgets#7 stays open."]);

    await ask();
    await asks.onReply(reply(merges()[0].channelId, "wait until the review is in"));
    expect(store.nextPending("graphite")!.text).toContain("wait until the review is in");
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
  });

  it("starts with the outsider line when the ask came from an outsider's turn", async () => {
    await askMerge(asks, kind, deps, "graphite", { number: 7 }, true);
    expect(chat.postsIn(merges()[0].channelId)[0]).toMatch(/^From an outsider's report\.\n<@user-1> graphite asks to merge/);
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
    expect(said).toEqual(['Withdrawn: Merge octo/widgets#7, "Fix login" (new commits were pushed)']);
  });

  it("is withdrawn when the pull request closes", async () => {
    await ask();
    await withdrawMerges(asks, { repo: "octo/widgets", headRepo: "octo/widgets", number: 7, action: "closed", headSha: SHA });
    expect(merges()).toEqual([]);
    expect(said[0]).toContain("(the pull request was closed)");
  });

  it("tells, after a stop in the middle, whether it was merged", async () => {
    await ask();
    store.moveAsk(merges()[0].id, "open", "busy");
    pr = { ...pr, state: "closed", merged: true };
    await asks.sweep(true);
    expect(said).toEqual(["Merged octo/widgets#7."]);
  });
});
