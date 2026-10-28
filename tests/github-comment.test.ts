import { describe, expect, it } from "vitest";
import { githubCommentSender, threadNumber } from "../src/events/github-comment.js";
import type { ClotEvent } from "../src/events/types.js";

const event: ClotEvent = { id: "d-1", source: "github", kind: "issue_opened", account: "github", place: "octo/widgets", actor: "alice", title: "Issue #7 opened: Login fails", body: "", url: "https://github.com/octo/widgets/issues/7", ref: "7", subject: "issue:7", automated: false, outsider: false, receivedAt: 0 };

/** A fetch that records what it was asked and answers as told. */
function fakeFetch(answer: { status: number; body?: unknown } | Error) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (answer instanceof Error) throw answer;
    return new Response(JSON.stringify(answer.body ?? {}), { status: answer.status });
  }) as unknown as typeof fetch;
  return { calls, fetchFn };
}

describe("threadNumber", () => {
  it("reads the issue or pull request an event is about, and nothing for a branch", () => {
    expect(threadNumber("issue:7")).toBe("7");
    expect(threadNumber("pr:14")).toBe("14");
    expect(threadNumber("branch:main")).toBeUndefined();
    expect(threadNumber("")).toBeUndefined();
  });
});

describe("githubCommentSender", () => {
  it("posts the text on the event's own issue with the Clots' token, and returns the comment's link", async () => {
    const { calls, fetchFn } = fakeFetch({ status: 201, body: { html_url: "https://github.com/octo/widgets/issues/7#issuecomment-1" } });
    const sent = await githubCommentSender("tok", fetchFn).send(event, "Thanks, @alice.");
    expect(sent).toEqual({ ok: true, url: "https://github.com/octo/widgets/issues/7#issuecomment-1" });
    expect(calls[0].url).toBe("https://api.github.com/repos/octo/widgets/issues/7/comments");
    expect(calls[0].init.method).toBe("POST");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ body: "Thanks, @alice." });
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe("Bearer tok");
  });

  it("posts on a pull request through the same address", async () => {
    const { calls, fetchFn } = fakeFetch({ status: 201, body: {} });
    const sent = await githubCommentSender("tok", fetchFn).send({ ...event, subject: "pr:14", ref: "14" }, "x");
    expect(calls[0].url).toBe("https://api.github.com/repos/octo/widgets/issues/14/comments");
    expect(sent).toEqual({ ok: true, url: event.url });
  });

  it("never asks GitHub about an event that has no thread", async () => {
    const { calls, fetchFn } = fakeFetch({ status: 201 });
    expect(await githubCommentSender("tok", fetchFn).send({ ...event, subject: "branch:main" }, "x")).toMatchObject({ ok: false, refused: true });
    expect(calls).toEqual([]);
  });

  it("tells a definite refusal from an uncertain failure", async () => {
    const refused = fakeFetch({ status: 403 });
    expect(await githubCommentSender("tok", refused.fetchFn).send(event, "x")).toEqual({ ok: false, refused: true, reason: "GitHub answered 403" });
    const broken = fakeFetch({ status: 502 });
    expect(await githubCommentSender("tok", broken.fetchFn).send(event, "x")).toEqual({ ok: false, refused: false, reason: "GitHub answered 502" });
    const down = fakeFetch(new Error("socket hang up"));
    expect(await githubCommentSender("tok", down.fetchFn).send(event, "x")).toEqual({ ok: false, refused: false, reason: "GitHub could not be reached (socket hang up)" });
  });
});

it("knows it cannot answer an event about a branch", () => {
  const sender = githubCommentSender("t", async () => new Response("{}"));
  expect(sender.reach(event)).toBeUndefined();
  expect(sender.reach({ ...event, subject: "branch:main" })).toContain("branch");
});
