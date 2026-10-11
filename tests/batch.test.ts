import { describe, expect, it } from "vitest";
import { combine, describeSubject } from "../src/events/batch.js";
import { MAX_BODY } from "../src/events/github.js";
import { formatInlineComments, INLINE_PARTIAL, INLINE_UNREAD, inlineCommentReader, reviewIdOf } from "../src/events/review-comments.js";
import type { ClotEvent } from "../src/events/types.js";

function event(id: string, overrides: Partial<ClotEvent> = {}): ClotEvent {
  return {
    id,
    source: "github",
    kind: "comment",
    repo: "octo/widgets",
    actor: "vercel[bot]",
    title: "Comment on pull request #14: Add cache",
    body: "Deployment failed.",
    url: `https://github.com/octo/widgets/pull/14#issuecomment-${id}`,
    ref: "14",
    subject: "pr:14",
    automated: true,
    receivedAt: 1000,
    ...overrides,
  };
}
const ci = (id: string, overrides: Partial<ClotEvent> = {}) =>
  event(id, { kind: "ci_failed", actor: "widgets-clot", title: "CI failed: CI on clot/add-cache", body: `Workflow run ID: ${id}`, url: `https://github.com/octo/widgets/actions/runs/${id}`, ref: "clot/add-cache", ...overrides });

describe("describeSubject", () => {
  it("names a pull request, an issue and a branch", () => {
    expect(describeSubject("pr:14")).toBe("pull request #14");
    expect(describeSubject("issue:7")).toBe("issue #7");
    expect(describeSubject("branch:clot/add-cache")).toBe("branch clot/add-cache");
  });
});

describe("combine", () => {
  it("returns a single event as it is", () => {
    const only = event("d-1");
    expect(combine([only])).toEqual({ event: only, absorbed: [] });
  });

  it("counts the same CI failure once, keeping the latest", () => {
    const first = ci("1");
    const second = ci("2");
    expect(combine([first, second])).toEqual({ event: second, absorbed: [first] });
  });

  it("does not take different workflows, or comments that read alike, for repeats", () => {
    expect(combine([ci("1"), ci("2", { title: "CI failed: Lint on clot/add-cache" })]).event.kind).toBe("batch");
    expect(combine([event("d-1"), event("d-2")]).event.kind).toBe("batch");
  });

  it("makes several events into one batch event that lists them", () => {
    const events = [event("d-1"), event("d-2", { actor: "netlify[bot]", body: "" }), ci("1"), ci("2")];
    const { event: batch, absorbed } = combine(events);

    expect(absorbed).toEqual(events);
    expect(batch).toMatchObject({
      id: "batch:d-1",
      source: "github",
      kind: "batch",
      repo: "octo/widgets",
      actor: "vercel[bot], netlify[bot], widgets-clot",
      title: "3 automated reports on pull request #14",
      url: "https://github.com/octo/widgets/pull/14",
      ref: "14",
      subject: "pr:14",
      automated: true,
      receivedAt: 1000,
    });
    expect(batch.body).toBe(
      [
        "- Comment on pull request #14: Add cache\n  by vercel[bot]: https://github.com/octo/widgets/pull/14#issuecomment-d-1\nDeployment failed.",
        "- Comment on pull request #14: Add cache\n  by netlify[bot]: https://github.com/octo/widgets/pull/14#issuecomment-d-2",
        "- CI failed: CI on clot/add-cache\n  by widgets-clot: https://github.com/octo/widgets/actions/runs/2\nWorkflow run ID: 2",
      ].join("\n\n"),
    );
  });

  it("links a batch about a branch to its first event, and keeps long bodies short", () => {
    const { event: batch } = combine([ci("1", { subject: "branch:main", ref: "main", body: "x".repeat(5000) }), ci("2", { subject: "branch:main", ref: "main", title: "CI failed: Lint on main", body: "y".repeat(5000) })]);
    expect(batch.title).toBe("2 automated reports on branch main");
    expect(batch.url).toBe("https://github.com/octo/widgets/actions/runs/1");
    expect(batch.body.length).toBeLessThan(MAX_BODY + 20);
    expect(batch.body).toContain("[truncated]");
    expect(batch.body).toContain("- CI failed: Lint on main");
  });
});

const review = event("d-1", { kind: "review", actor: "someone", title: "Review (changes_requested) on pull request #9: Add cache", body: "", url: "https://github.com/octo/widgets/pull/9#pullrequestreview-555", ref: "9", subject: "pr:9", automated: false });

describe("inline review comments", () => {
  it("reads the review's ID from its link", () => {
    expect(reviewIdOf(review)).toBe("555");
    expect(reviewIdOf(event("d-2"))).toBeUndefined();
  });

  it("writes each of the review's comments as path, line and text, with the line of code it is on", () => {
    const comments = [
      { pull_request_review_id: 555, path: "src/cache.ts", line: 12, side: "RIGHT", diff_hunk: "@@ -10,3 +10,3 @@\n const a = 1;\n+const tmp = load();", body: "Rename this.\n" },
      { pull_request_review_id: 555, path: "src/old.ts", line: 4, side: "LEFT", diff_hunk: "@@ -4,1 +4,0 @@\n-check();", body: "Why was this removed?" },
      { pull_request_review_id: 555, path: "src/long.ts", start_line: 12, line: 14, side: "RIGHT", diff_hunk: "@@ -10,3 +10,5 @@\n const a = 1;\n-old();\n+if (a) {\n+  one();\n+}", body: "Split this up." },
      { pull_request_review_id: 555, path: "src/gone.ts", line: null, original_line: 7, body: "Outdated now." },
      { pull_request_review_id: 555, path: "README.md", line: null, body: "A comment on the whole file." },
      { pull_request_review_id: 777, path: "src/other.ts", line: 1, body: "From another review." },
      { pull_request_review_id: 555, body: "no path" },
    ];
    expect(formatInlineComments(comments, "555")).toBe(
      [
        "Inline comments:",
        "- src/cache.ts:12: Rename this.\n  on: const tmp = load();",
        "- src/old.ts:4 (old version of the file): Why was this removed?\n  on: check();",
        "- src/long.ts:12-14: Split this up.\n  on:\n    if (a) {\n      one();\n    }",
        "- src/gone.ts:7: Outdated now.",
        "- README.md: A comment on the whole file.",
      ].join("\n"),
    );
    expect(formatInlineComments([])).toBe("");
    expect(formatInlineComments({ message: "Not Found" })).toBe("");
  });

  it("fetches the review's comments with the token and adds them to the body", async () => {
    const calls: { url: string; auth: string }[] = [];
    const read = inlineCommentReader("t0ken", (async (url: string, init: { headers: Record<string, string> }) => {
      calls.push({ url, auth: init.headers.authorization });
      // GitHub is asked for the newest first.
      return new Response(
        JSON.stringify([
          { pull_request_review_id: 555, path: "src/b.ts", line: 3, body: "And this." },
          { pull_request_review_id: 777, path: "src/other.ts", line: 1, body: "From another review." },
          { pull_request_review_id: 555, path: "src/cache.ts", line: 12, body: "Rename this." },
        ]),
      );
    }) as unknown as typeof fetch);

    const inline = "Inline comments:\n- src/cache.ts:12: Rename this.\n- src/b.ts:3: And this.";
    expect((await read(review)).body).toBe(inline);
    expect((await read({ ...review, body: "Two things." })).body).toBe(`Two things.\n\n${inline}`);
    expect(calls[0]).toEqual({ url: "https://api.github.com/repos/octo/widgets/pulls/9/comments?sort=created&direction=desc&per_page=100&page=1", auth: "Bearer t0ken" });
  });

  it("reads further pages while they are full, and finds a review whose comments are not on the first", async () => {
    const newer = Array.from({ length: 100 }, (_, i) => ({ pull_request_review_id: 777, path: `src/new-${i}.ts`, line: 1, body: "Newer." }));
    const pages = [newer, [{ pull_request_review_id: 555, path: "src/cache.ts", line: 12, body: "Rename this." }]];
    const urls: string[] = [];
    const read = inlineCommentReader("t0ken", (async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify(pages[urls.length - 1] ?? []));
    }) as unknown as typeof fetch);

    expect((await read(review)).body).toBe("Inline comments:\n- src/cache.ts:12: Rename this.");
    expect(urls.map((url) => url.slice(url.indexOf("&page=")))).toEqual(["&page=1", "&page=2"]);
  });

  it("says so when the pull request has more pages of comments than it reads", async () => {
    const full = Array.from({ length: 100 }, () => ({ pull_request_review_id: 777, path: "src/other.ts", line: 1, body: "Another review." }));
    let asked = 0;
    const read = inlineCommentReader("t0ken", (async () => {
      asked += 1;
      return new Response(JSON.stringify(full));
    }) as unknown as typeof fetch);

    expect((await read(review)).body).toBe(INLINE_PARTIAL);
    expect(asked).toBe(10);
  });

  it("keeps what it has read when a later page fails, and says some may be missing", async () => {
    const first = [{ pull_request_review_id: 555, path: "src/cache.ts", line: 12, body: "Rename this." }, ...Array.from({ length: 99 }, () => ({ pull_request_review_id: 777, path: "src/other.ts", line: 1, body: "Another review." }))];
    const kept = `Inline comments:\n- src/cache.ts:12: Rename this.\n${INLINE_PARTIAL}`;
    const failures: (() => Promise<Response>)[] = [
      async () => new Response("{}", { status: 503 }),
      async () => new Response("not json"),
      async () => {
        throw new Error("offline");
      },
    ];
    for (const fail of failures) {
      let asked = 0;
      const read = inlineCommentReader("t0ken", (async () => ((asked += 1) === 1 ? new Response(JSON.stringify(first)) : fail())) as unknown as typeof fetch);
      expect((await read(review)).body).toBe(kept);
      expect(asked).toBe(2);
    }
  });

  it("leaves a review without inline comments, and anything that is not a review, as it came", async () => {
    let asked = 0;
    const read = inlineCommentReader("t0ken", (async () => {
      asked += 1;
      return new Response("[]");
    }) as unknown as typeof fetch);
    expect(await read(review)).toEqual(review);
    const comment = event("d-2");
    expect(await read(comment)).toBe(comment);
    expect(asked).toBe(1);
  });

  it("says so in the body when the comments cannot be read", async () => {
    const refused = inlineCommentReader("t0ken", (async () => new Response("{}", { status: 403 })) as unknown as typeof fetch);
    const down = inlineCommentReader("t0ken", (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch);
    expect((await refused(review)).body).toBe(INLINE_UNREAD);
    expect((await down({ ...review, body: "Two things." })).body).toBe(`Two things.\n\n${INLINE_UNREAD}`);
  });

  it("keeps a long list inside the length limit", async () => {
    const many = Array.from({ length: 90 }, (_, i) => ({ pull_request_review_id: 555, path: `src/file-${i}.ts`, line: i, body: "Please rename this variable." }));
    const read = inlineCommentReader("t0ken", (async () => new Response(JSON.stringify(many))) as unknown as typeof fetch);
    const body = (await read(review)).body;
    expect(body.length).toBeLessThan(MAX_BODY + 20);
    expect(body.endsWith("[truncated]")).toBe(true);
  });
});
