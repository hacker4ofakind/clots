import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { Composio } from "../src/composio/component.js";
import { LINEAR } from "../src/composio/toolkits/linear.js";
import type { LinearAccount } from "../src/config.js";
import { Supervisor } from "../src/listeners.js";
import { LINEAR_UNREAD, linearCommentSender, linearEnricher, linearMapper } from "../src/sources/linear.js";
import { Store } from "../src/store.js";
import { FakeComposioApi } from "./fake-composio.js";

const account: LinearAccount = { toolkit: "linear", account: "tady", shared: true, audience: "team", apiKey: "lin_api_test", apiKeyName: "K", triggers: [], selfIsUser: false };
const NOW = 1_760_000_000_000;

// The shapes of Composio's polled Linear triggers: the issue as recorded live (tests/fixtures/composio/linear), the comment per Composio's published payload schema.
const issueCreated = {
  id: "uuid-12",
  identifier: "ENC-12",
  title: "Export fails on Safari",
  description: "Steps: open export.",
  team: { id: "team-uuid", key: "ENC", name: "Encryptify" },
  creator: { id: "user-1", name: "Nicholas", email: "n@example.com" },
  url: "https://linear.app/tady/issue/ENC-12/export-fails-on-safari",
};
const commentCreated = {
  id: "c-1",
  body: "Looking into it.",
  issue: { id: "uuid-12", identifier: "ENC-12", title: "Export fails on Safari", team: { id: "team-uuid", key: "ENC", name: "Encryptify" }, url: "https://linear.app/tady/issue/ENC-12/export-fails-on-safari" },
  user: { id: "member-clots", name: "Clots", email: "clots@example.com" },
  url: "https://linear.app/tady/issue/ENC-12/export-fails-on-safari#comment-c-1",
};

describe("linearMapper", () => {
  it("turns a new issue into an event in its team, keyed on the issue's own ID", () => {
    expect(linearMapper(account, LINEAR.issueCreated, issueCreated, "msg_1", NOW)).toEqual({
      actorId: "user-1",
      objectIds: ["uuid-12"],
      event: {
        id: "linear:tady:Issue:uuid-12",
        source: "linear",
        account: "tady",
        kind: "issue_opened",
        place: "ENC",
        actor: "Nicholas",
        title: "Issue ENC-12 opened: Export fails on Safari",
        body: "Steps: open export.",
        url: "https://linear.app/tady/issue/ENC-12/export-fails-on-safari",
        ref: "ENC-12",
        subject: "issue:ENC-12",
        automated: false,
        outsider: false,
        receivedAt: NOW,
      },
    });
  });

  it("turns a new comment into an event about its issue", () => {
    const mapped = linearMapper(account, LINEAR.commentCreated, commentCreated, "msg_2", NOW)!;
    expect(mapped.actorId).toBe("member-clots");
    expect(mapped.objectIds).toEqual(["c-1"]);
    expect(mapped.event).toMatchObject({ id: "linear:tady:Comment:c-1", kind: "comment", place: "ENC", title: "Comment on ENC-12: Export fails on Safari", body: "Looking into it.", ref: "ENC-12", subject: "issue:ENC-12", automated: false, outsider: false });
  });

  it("marks a comment with no user, an integration's, as automated and from an outsider, with no actor ID", () => {
    const mapped = linearMapper(account, LINEAR.commentCreated, { ...commentCreated, user: null }, "msg_3", NOW)!;
    expect(mapped.event).toMatchObject({ automated: true, outsider: true, actor: "unknown" });
    expect(mapped.actorId).toBe("");
  });

  it("never leaves the place empty: the team's ID stands in when the key is not in the payload", () => {
    const mapped = linearMapper(account, LINEAR.issueCreated, { ...issueCreated, identifier: "", team: { id: "team-uuid" } }, "msg_4", NOW)!;
    expect(mapped.event.place).toBe("team-uuid");
    expect(mapped.event.ref).toBe("uuid-12");
  });

  it("ignores another trigger and a payload with nothing to name", () => {
    expect(linearMapper(account, "LINEAR_PRIVATE_TEAM_ISSUE_PROPERTIES_UPDATED", issueCreated, "m", NOW)).toBeUndefined();
    expect(linearMapper(account, LINEAR.issueCreated, "junk", "m", NOW)).toBeUndefined();
    expect(linearMapper(account, LINEAR.issueCreated, { title: "x" }, "m", NOW)).toBeUndefined();
  });
});

let api: FakeComposioApi;
let composio: Composio;
let store: Store;

beforeEach(async () => {
  api = new FakeComposioApi();
  store = new Store(":memory:");
  composio = new Composio({ api, store, accounts: [account], publicUrl: "https://x.example", tell: async () => {}, tellHome: async () => {}, now: () => NOW, schedule: () => () => {}, supervisor: new Supervisor({ schedule: () => () => {} }), log: () => {} });
  api.answers.set(LINEAR.listTeams, { ok: true, data: { teams: [] } });
  api.answers.set(LINEAR.whoAmI, { ok: true, data: { data: { id: "member-1" } } });
  await composio.reconcile();
});

/** Answers Composio's GraphQL tool by what the query asks for. */
function graphql(answers: Record<string, unknown>) {
  const calls: { query: string; variables: any }[] = [];
  api.answers.set(LINEAR.graphql, (args) => {
    const query = String(args.query_or_mutation);
    calls.push({ query, variables: args.variables });
    const key = Object.keys(answers).find((k) => query.includes(k));
    return key === undefined ? { ok: false, error: "unexpected query", reason: "refused" } : { ok: true, data: { data: answers[key], errors: null } };
  });
  return calls;
}

describe("Linear's enricher", () => {
  const issueAnswer = {
    issue: {
      identifier: "ENC-12",
      description: "Steps: open export.",
      team: { key: "ENC" },
      state: { name: "Todo" },
      priorityLabel: "High",
      assignee: { name: "Lukas" },
      labels: { nodes: [{ name: "Bug" }] },
      comments: { nodes: [{ body: "Same here.", createdAt: "2026-10-14T09:00:00.000Z", user: { name: "Ann" } }] },
    },
  };

  it("adds the issue's state, people and latest comments, read as the Clots' member through Composio", async () => {
    const calls = graphql({ "issue(id": issueAnswer });
    const event = linearMapper(account, LINEAR.commentCreated, commentCreated, "m", NOW)!.event;
    const read = await linearEnricher(composio)(event);
    expect(calls[0].variables).toEqual({ id: "ENC-12" });
    expect(api.of("execute").at(-1)).toContain("linear:tady LINEAR_RUN_QUERY_OR_MUTATION");
    expect(read.body).toContain("State: Todo; priority High; assigned to Lukas; labels Bug");
    expect(read.body).toContain("Description:\nSteps: open export.");
    expect(read.body).toContain("- Ann (2026-10-14): Same here.");
  });

  it("replaces a placeholder place with the team's key", async () => {
    graphql({ "issue(id": issueAnswer });
    const event = { ...linearMapper(account, LINEAR.issueCreated, { ...issueCreated, team: { id: "team-uuid" }, identifier: "ENC-12" }, "m", NOW)!.event, place: "team-uuid" };
    expect((await linearEnricher(composio)(event)).place).toBe("ENC");
  });

  it("says the issue could not be read when Linear or Composio refuses, or the issue is gone, and goes on", async () => {
    const event = linearMapper(account, LINEAR.issueCreated, issueCreated, "m", NOW)!.event;
    api.answers.set(LINEAR.graphql, { ok: false, error: "down", reason: "unreachable" });
    expect((await linearEnricher(composio)(event)).body).toContain(LINEAR_UNREAD);
    graphql({ "issue(id": { issue: null } });
    expect((await linearEnricher(composio)(event)).body).toContain(LINEAR_UNREAD);
    api.answers.set(LINEAR.graphql, { ok: true, data: { data: null, errors: [{ message: "nope" }] } });
    expect((await linearEnricher(composio)(event)).body).toContain(LINEAR_UNREAD);
  });

  it("says the issue could not be read when Linear's answer is not the shape the enricher reads, instead of guessing", async () => {
    const event = linearMapper(account, LINEAR.issueCreated, issueCreated, "m", NOW)!.event;
    // A state that is a string, not an object; comments that are not a list; and an answer with no operation data at all.
    graphql({ "issue(id": { issue: { identifier: "ENC-12", state: "Todo" } } });
    expect((await linearEnricher(composio)(event)).body).toContain(LINEAR_UNREAD);
    graphql({ "issue(id": { issue: { identifier: "ENC-12", comments: { nodes: "none" } } } });
    expect((await linearEnricher(composio)(event)).body).toContain(LINEAR_UNREAD);
    api.answers.set(LINEAR.graphql, { ok: true, data: "<html>" });
    expect((await linearEnricher(composio)(event)).body).toContain(LINEAR_UNREAD);
  });

  it("leaves an event of an account it does not know as it is", async () => {
    const event = { ...linearMapper(account, LINEAR.issueCreated, issueCreated, "m", NOW)!.event, account: "other" };
    expect(await linearEnricher(composio)(event)).toEqual(event);
  });
});

describe("Linear's comment sender", () => {
  it("comments on the issue an event is about, as the Clots' member, and returns the comment's link", async () => {
    const calls = graphql({ "issue(id": { issue: { id: "uuid-12" } }, commentCreate: { commentCreate: { success: true, comment: { id: "c-9", url: "https://linear.app/tady/issue/ENC-12#comment-9" } } } });
    const sender = linearCommentSender(composio);
    const event = linearMapper(account, LINEAR.issueCreated, issueCreated, "m", NOW)!.event;
    expect(sender.reach(event)).toBeUndefined();
    expect(sender.reach({ ...event, source: "github" })).toContain("Linear");
    expect(sender.reach({ ...event, subject: "pr:3" })).toContain("not about a Linear issue");
    expect(sender.reach({ ...event, account: "other" })).toContain("not configured");
    expect(await sender.send(event, "Thanks, looking into it.")).toEqual({ ok: true, url: "https://linear.app/tady/issue/ENC-12#comment-9" });
    expect(calls[1].variables).toEqual({ input: { issueId: "uuid-12", body: "Thanks, looking into it." } });
  });

  it("sends nothing until the Clots' member is known, so its own comment could be told apart", async () => {
    store.composio.setAccount("linear:tady", { identity: undefined });
    const fresh = new Composio({ api, store: new Store(":memory:"), accounts: [account], publicUrl: "https://x.example", tell: async () => {}, tellHome: async () => {}, now: () => NOW, schedule: () => () => {}, supervisor: new Supervisor({ schedule: () => () => {} }), log: () => {} });
    const event = linearMapper(account, LINEAR.issueCreated, issueCreated, "m", NOW)!.event;
    expect(linearCommentSender(fresh).reach(event)).toContain("not known yet");
  });

  it("says a refusal is definite, and a network failure is not", async () => {
    const sender = linearCommentSender(composio);
    const event = linearMapper(account, LINEAR.issueCreated, issueCreated, "m", NOW)!.event;
    graphql({ "issue(id": { issue: null } });
    expect(await sender.send(event, "x")).toEqual({ ok: false, refused: true, reason: "Linear has no issue ENC-12" });
    api.answers.set(LINEAR.graphql, { ok: false, error: "fetch failed", reason: "unreachable" });
    expect(await sender.send(event, "x")).toMatchObject({ ok: false, refused: false });
    api.answers.set(LINEAR.graphql, { ok: false, error: "Entity not found", reason: "refused" });
    expect(await sender.send(event, "x")).toMatchObject({ ok: false, refused: true });
    graphql({ "issue(id": { issue: { id: "uuid-12" } }, commentCreate: { commentCreate: { success: false } } });
    expect(await sender.send(event, "x")).toEqual({ ok: false, refused: true, reason: "Linear did not create the comment" });
  });

  it("does not take an answer of another shape for a comment that was made", async () => {
    const sender = linearCommentSender(composio);
    const event = linearMapper(account, LINEAR.issueCreated, issueCreated, "m", NOW)!.event;
    graphql({ "issue(id": { issue: { id: "uuid-12" } }, commentCreate: { commentCreated: true } });
    expect(await sender.send(event, "x")).toMatchObject({ ok: false, refused: true, reason: expect.stringContaining("unexpected shape") });
    graphql({ "issue(id": { issue: { identifier: "no id" } } });
    expect(await sender.send(event, "x")).toMatchObject({ ok: false, refused: true, reason: expect.stringContaining("unexpected shape") });
  });
});

describe("recorded Linear deliveries", () => {
  const dir = "tests/fixtures/composio/linear";
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".json")) : [];

  it.skipIf(files.length === 0)("turn into an issue or a comment event", () => {
    for (const file of files) {
      const recording = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
      const slug = recording.body.metadata.trigger_slug;
      const mapped = linearMapper(account, slug, recording.body.data, recording.body.id, NOW);
      expect(mapped, file).toBeDefined();
      expect(mapped!.event, file).toMatchObject({ source: "linear", kind: slug === LINEAR.issueCreated ? "issue_opened" : "comment" });
      expect(mapped!.event.subject, file).toMatch(/^issue:/);
      expect(mapped!.event.place, file).not.toBe("");
      expect(mapped!.actorId, file).not.toBe("");
    }
  });
});
