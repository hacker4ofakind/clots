import { describe, expect, it } from "vitest";
import type { ClotEvent } from "../src/events/types.js";
import type { StandingRule } from "../src/rulebook.js";
import { checkSend, defuse, fillTemplate, matchStanding, mentionsNotify, wordEdits } from "../src/standing.js";

const Z = "​";

function event(overrides: Partial<ClotEvent> = {}): ClotEvent {
  return {
    id: "d-1",
    source: "github",
    kind: "issue_opened",
    account: "github", place: "octo/widgets",
    actor: "alice",
    title: "Issue #7 opened: Login fails",
    body: "",
    url: "https://github.com/octo/widgets/issues/7",
    ref: "7",
    subject: "issue:7",
    automated: false,
    receivedAt: 0,
    ...overrides,
  };
}

const ack: StandingRule = { name: "ack-issue", trigger: { kind: "issue_opened" }, via: "github_comment", template: "Thanks for the report, @{actor}. I'm looking into it." };

describe("fillTemplate", () => {
  it("fills every field from the event", () => {
    expect(fillTemplate("{actor} / {title} / {ref} / {repo} / {url}", event())).toBe("alice / Issue #7 opened: Login fails / 7 / octo/widgets / https://github.com/octo/widgets/issues/7");
  });

  it("lets the template mention someone, and keeps a filled-in value from doing so", () => {
    expect(fillTemplate("Hello, @{actor}. Re: {title}", event({ title: "@bob broke it" }))).toBe(`Hello, @alice. Re: @${Z}bob broke it`);
  });

  it("fills {place}, and {repo} with the place", () => {
    expect(fillTemplate("{place} {repo}", event())).toBe("octo/widgets octo/widgets");
  });

  it("leaves an @ alone where mentions notify nobody", () => {
    expect(fillTemplate("Re: {title}", event({ title: "write to bob@example.com" }), false)).toBe("Re: write to bob@example.com");
    expect(checkSend("Thanks for writing.", "Thanks for writing, bob@example.com.", false)).toEqual({ ok: true, text: "Thanks for writing, bob@example.com." });
  });

  it("knows that only GitHub turns an @ into a notification", () => {
    expect(mentionsNotify("github_comment")).toBe(true);
    for (const via of ["email_reply", "linear_comment", "notion_comment", "sentry_comment"] as const) expect(mentionsNotify(via)).toBe(false);
  });
});

describe("defuse", () => {
  it("puts a zero-width space after every @, once", () => {
    expect(defuse("@bob and @carol")).toBe(`@${Z}bob and @${Z}carol`);
    expect(defuse(defuse("@bob"))).toBe(`@${Z}bob`);
  });
});

describe("matchStanding", () => {
  it("returns the rules whose trigger matches, with their text filled in", () => {
    const other: StandingRule = { ...ack, name: "ack-pr", trigger: { kind: "pr_opened" } };
    const matches = matchStanding([ack, other], event(), []);
    expect(matches.map((m) => m.rule.name)).toEqual(["ack-issue"]);
    expect(matches[0].filled).toBe("Thanks for the report, @alice. I'm looking into it.");
    expect(matches[0].from.id).toBe("d-1");
  });

  it("matches a batch through the reports it was made from, and fills from the earliest that matches", () => {
    const rule: StandingRule = { name: "rebase", trigger: { kind: "pr_opened", actor: "dependabot[bot]" }, via: "github_comment", template: "@{actor} rebase ({ref})" };
    const batch = event({ id: "batch:d-2", kind: "batch", actor: "vercel[bot], dependabot[bot]", ref: "14", subject: "pr:14" });
    const parts = [
      event({ id: "d-3", kind: "pr_opened", actor: "dependabot[bot]", ref: "14", receivedAt: 30 }),
      event({ id: "d-2", kind: "comment", actor: "vercel[bot]", ref: "14", receivedAt: 10 }),
      event({ id: "d-4", kind: "pr_opened", actor: "dependabot[bot]", ref: "14", receivedAt: 20 }),
    ];
    const matches = matchStanding([rule], batch, parts);
    expect(matches).toHaveLength(1);
    expect(matches[0].from.id).toBe("d-4");
    expect(matches[0].filled).toBe("@dependabot[bot] rebase (14)");
    expect(matchStanding([rule], batch, [])).toEqual([]);
  });

  it("reads a trigger that names no source as GitHub's", () => {
    const linearIssue = event({ id: "linear:tady:d-5", source: "linear", account: "tady", place: "ENC", ref: "ENC-12", subject: "issue:ENC-12" });
    expect(matchStanding([ack], linearIssue, [])).toEqual([]);
    const linearAck: StandingRule = { ...ack, name: "ack-linear", trigger: { source: "linear", kind: "issue_opened" }, via: "linear_comment" };
    expect(matchStanding([linearAck], linearIssue, []).map((m) => m.rule.name)).toEqual(["ack-linear"]);
  });
});

describe("wordEdits", () => {
  const count = (from: string, to: string) => wordEdits(from.split(" "), to.split(" ")).count;

  it("counts each word added, removed or replaced as one", () => {
    const pairs: [string, string, number][] = [
      ["Thanks for the report", "Thanks for the report", 0],
      ["Thanks for the report", "Thanks for this report", 1],
      ["Thanks for the report", "Thanks again for the report", 1],
      ["Thanks for the report", "Thanks for report", 1],
      ["Thanks for the report", "Thank you so much for your report", 5],
      ["Thanks for the report", "Thank you for your report", 3],
      ["a b c d e f", "g h i j k l", 6],
      ["Thanks.", "thanks", 1],
    ];
    for (const [from, to, expected] of pairs) expect(count(from, to), `${from} -> ${to}`).toBe(expected);
  });

  it("says which words were kept, and from where", () => {
    expect(wordEdits(["Thanks", "for", "the", "report"], ["Thanks", "again", "for", "report"]).kept).toEqual([0, undefined, 1, 3]);
  });

  it("does not count a zero-width space as a difference", () => {
    expect(wordEdits([`@${Z}bob`], ["@bob"])).toEqual({ count: 0, kept: [0] });
  });
});

describe("checkSend", () => {
  const filled = fillTemplate("Hello, @{actor}. Re: {title}", event({ title: "@bob broke it" }));

  it("sends the filled-in template when the Clot gives no text", () => {
    expect(checkSend(filled, undefined)).toEqual({ ok: true, text: filled });
    expect(checkSend(filled, "  ")).toEqual({ ok: true, text: filled });
  });

  it("accepts up to five changed words and refuses a sixth, with the count", () => {
    const base = "one two three four five six seven";
    expect(checkSend(base, "ONE TWO THREE FOUR FIVE six seven")).toEqual({ ok: true, text: "ONE TWO THREE FOUR FIVE six seven" });
    expect(checkSend(base, "ONE TWO THREE FOUR FIVE SIX seven")).toEqual({ ok: false, count: 6 });
  });

  it("keeps the template's own mention, and lets no other word mention anyone", () => {
    const sent = checkSend(filled, "Hello, @alice. Re: @bob broke it again @carol");
    expect(sent).toEqual({ ok: true, text: `Hello, @alice. Re: @${Z}bob broke it again @${Z}carol` });
  });

  it("keeps the Clot's own line breaks", () => {
    expect(checkSend("Thanks.\n\nI am on it.", "Thanks.\n\nI am on it now.")).toEqual({ ok: true, text: "Thanks.\n\nI am on it now." });
  });
});
