import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { Composio } from "../src/composio/component.js";
import { NOTION } from "../src/composio/toolkits/notion.js";
import type { NotionAccount } from "../src/config.js";
import { Supervisor } from "../src/listeners.js";
import { NOTION_UNREAD, normalizeNotion, notionCommentSender, notionEnricher, notionHandler, pageUrl, verificationKey, verifyNotion } from "../src/sources/notion.js";
import { Store } from "../src/store.js";
import { FakeComposioApi } from "./fake-composio.js";

const account: NotionAccount = { toolkit: "notion", account: "tady", shared: true, audience: "private", apiKey: "ntn_test", apiKeyName: "K", triggers: [], selfIsUser: false };
const NOW = 1_760_000_000_000;
const PAGE = "1a2b3c4d-0000-4000-8000-000000000001";

const pageCreated = {
  id: "evt-1",
  timestamp: "2026-10-14T09:00:00.000Z",
  type: "page.created",
  authors: [{ id: "person-1", type: "person" }],
  entity: { id: PAGE, type: "page" },
  data: { parent: { id: "db-1", type: "database" } },
};
const commentCreated = {
  id: "evt-2",
  timestamp: "2026-10-14T09:05:00.000Z",
  type: "comment.created",
  authors: [{ id: "bot-clots", type: "bot" }],
  entity: { id: "comment-1", type: "comment" },
  data: { page_id: PAGE, parent: { id: PAGE, type: "page" } },
};

const sign = (body: string, token: string) => `sha256=${createHmac("sha256", token).update(body).digest("hex")}`;

describe("verifyNotion", () => {
  it("accepts sha256= and the HMAC of the raw body with the verification token", () => {
    const body = JSON.stringify(pageCreated);
    expect(verifyNotion("tok", Buffer.from(body), sign(body, "tok"))).toBe(true);
    expect(verifyNotion("tok", Buffer.from(body), sign(body, "other"))).toBe(false);
    expect(verifyNotion("tok", Buffer.from(body), undefined)).toBe(false);
  });
});

describe("normalizeNotion", () => {
  it("turns a new page into an event about that page, placed in its parent", () => {
    expect(normalizeNotion(account, pageCreated, NOW)).toEqual({
      authorIds: ["person-1"],
      event: {
        id: "notion:tady:evt-1",
        source: "notion",
        account: "tady",
        kind: "page_created",
        place: "db-1",
        actor: "person-1",
        title: "A page was created in Notion",
        body: "Notion event: page.created\nPage: 1a2b3c4d-0000-4000-8000-000000000001\nIn: database db-1",
        url: pageUrl(PAGE),
        ref: PAGE,
        subject: `page:${PAGE}`,
        automated: false,
        outsider: false,
        receivedAt: NOW,
      },
    });
    expect(pageUrl(PAGE)).toBe("https://www.notion.so/1a2b3c4d000040008000000000000001");
  });

  it("turns a new comment into an event about its page, and a bot's into an automated one", () => {
    expect(normalizeNotion(account, commentCreated, NOW)!.event).toMatchObject({ kind: "comment", ref: PAGE, subject: `page:${PAGE}`, title: "A comment was added in Notion", automated: true });
  });

  it("ignores other event types", () => {
    expect(normalizeNotion(account, { ...pageCreated, type: "page.content_updated" }, NOW)).toBeUndefined();
    expect(normalizeNotion(account, "junk", NOW)).toBeUndefined();
  });
});

describe("notionHandler", () => {
  let store: Store;
  let logged: string[];
  const handler = (a: NotionAccount = account) => notionHandler(a, { store, now: () => NOW, botId: () => "bot-clots", log: (t) => void logged.push(t) });
  const req = (body: string, headers: Record<string, string> = {}) => ({ method: "POST", headers, query: new URLSearchParams(), rawBody: Buffer.from(body) });

  beforeEach(() => {
    store = new Store(":memory:");
    logged = [];
  });

  it("keeps the first verification token, prints it in the log, and ignores any later one", async () => {
    expect((await handler()(req(JSON.stringify({ verification_token: "secret_abc" })))).status).toBe(200);
    expect(store.getState(verificationKey("tady"))).toBe("secret_abc");
    expect(logged.join("\n")).toContain("secret_abc");
    await handler()(req(JSON.stringify({ verification_token: "secret_evil" })));
    expect(store.getState(verificationKey("tady"))).toBe("secret_abc");
    expect(logged.at(-1)).toContain("ignored");
  });

  it("takes the handshake when Notion signs it too, since the signature cannot be checked before the token is known", async () => {
    const body = JSON.stringify({ verification_token: "secret_abc" });
    expect((await handler()(req(body, { "x-notion-signature": sign(body, "secret_abc") }))).status).toBe(200);
    expect(store.getState(verificationKey("tady"))).toBe("secret_abc");
  });

  it("refuses events until it has a token, then checks each one against it", async () => {
    const body = JSON.stringify(pageCreated);
    expect((await handler()(req(body, { "x-notion-signature": sign(body, "secret_abc") }))).status).toBe(401);
    store.setState(verificationKey("tady"), "secret_abc");
    expect((await handler()(req(body, { "x-notion-signature": sign(body, "wrong") }))).status).toBe(401);
    expect(await handler()(req(body, { "x-notion-signature": sign(body, "secret_abc") }))).toMatchObject({ status: 202, event: { id: "notion:tady:evt-1" } });
  });

  it("uses the token in .env before the stored one, and drops what the integration did itself", async () => {
    store.setState(verificationKey("tady"), "stored");
    const body = JSON.stringify(commentCreated);
    const answer = await handler({ ...account, verificationToken: "from-env" })(req(body, { "x-notion-signature": sign(body, "from-env") }));
    expect(answer).toMatchObject({ status: 202, dropped: "caused by the Clot itself" });
  });
});

describe("Notion through Composio", () => {
  let api: FakeComposioApi;
  let composio: Composio;

  beforeEach(async () => {
    api = new FakeComposioApi();
    composio = new Composio({ api, store: new Store(":memory:"), accounts: [account], publicUrl: "https://x.example", tell: async () => {}, tellHome: async () => {}, now: () => NOW, schedule: () => () => {}, supervisor: new Supervisor({ schedule: () => () => {} }), log: () => {} });
    api.answers.set(NOTION.whoAmI, { ok: true, data: { data: { id: "bot-1" } } });
    await composio.reconcile();
  });

  /** Answers Notion's read tools with Notion's own objects, as Composio does. */
  function reads(answers: Record<string, unknown>) {
    for (const [slug, data] of Object.entries(answers)) api.answers.set(slug, (args) => ({ ok: true, data: typeof data === "function" ? (data as (a: any) => unknown)(args) : data }));
  }

  const page = { id: PAGE, url: "https://www.notion.so/Feedback-1a2b", properties: { Name: { type: "title", title: [{ plain_text: "Export is slow" }] }, Status: { type: "status", status: { name: "New" } }, Tags: { type: "multi_select", multi_select: [{ name: "perf" }, { name: "export" }] } } };

  it("learns the integration's bot user from Composio, for telling its own comments apart", () => {
    expect(composio.identity(account)).toBe("bot-1");
  });

  it("names a new page and adds its properties, its text and its author, read through Composio", async () => {
    reads({
      [NOTION.retrievePage]: page,
      [NOTION.fetchBlocks]: { results: [{ type: "paragraph", paragraph: { rich_text: [{ plain_text: "Exporting 2 GB takes ten minutes." }] } }, { type: "to_do", to_do: { rich_text: [{ plain_text: "check worker" }] } }] },
      [NOTION.getUser]: { name: "Ann" },
    });
    const { event } = normalizeNotion(account, pageCreated, NOW)!;
    const read = await notionEnricher(composio)(event);
    expect(read.title).toBe('Page created in Notion: "Export is slow"');
    expect(read.url).toBe(event.url);
    expect(read.body).toContain("By: Ann");
    expect(read.actor).toBe("Ann");
    expect(read.body).toContain("Status: New");
    expect(read.body).toContain("Tags: perf, export");
    expect(read.body).toContain("Exporting 2 GB takes ten minutes.\ncheck worker");
    expect(api.of("execute").some((c) => c.includes(`notion:tady ${NOTION.retrievePage} {"page_id":"${PAGE}"}`))).toBe(true);
  });

  it("names a comment by its page and adds the comment and its discussion", async () => {
    reads({
      [NOTION.retrievePage]: page,
      [NOTION.fetchComments]: { results: [{ id: "comment-0", discussion_id: "d-1", created_by: { id: "person-1" }, rich_text: [{ plain_text: "Is this still slow?" }] }, { id: "comment-1", discussion_id: "d-1", created_by: { id: "person-2" }, rich_text: [{ plain_text: "Yes, since Monday." }] }] },
      [NOTION.getUser]: { name: "Ann" },
    });
    const read = await notionEnricher(composio)({ ...normalizeNotion(account, commentCreated, NOW)!.event, automated: false });
    expect(read.title).toBe('Comment on "Export is slow" in Notion');
    expect(read.actor).toBe("Ann");
    expect(read.body).toContain("Comment: Yes, since Monday.");
    expect(read.body).toContain("Earlier in the discussion:\n- Is this still slow?");
  });

  it("says it could not read the page when Composio or Notion refuses, and goes on", async () => {
    api.answers.set(NOTION.retrievePage, { ok: false, error: "Page not found (404)", reason: "refused" });
    const { event } = normalizeNotion(account, pageCreated, NOW)!;
    expect((await notionEnricher(composio)(event)).body).toContain(NOTION_UNREAD);
  });

  it("says it could not read the page when an answer is not Notion's object, instead of reading it wrongly", async () => {
    const { event } = normalizeNotion(account, pageCreated, NOW)!;
    // A page with no properties (the answer is wrapped one level deeper), and a comment list that is not a list.
    reads({ [NOTION.retrievePage]: { data: page }, [NOTION.getUser]: { name: "Ann" } });
    expect((await notionEnricher(composio)(event)).body).toContain(NOTION_UNREAD);
    reads({ [NOTION.retrievePage]: page, [NOTION.fetchComments]: { results: "none" }, [NOTION.getUser]: { name: "Ann" } });
    const comment = { ...normalizeNotion(account, commentCreated, NOW)!.event, automated: false };
    expect((await notionEnricher(composio)(comment)).body).toContain(NOTION_UNREAD);
  });

  it("leaves an event of an account it does not know as it is", async () => {
    const { event } = normalizeNotion(account, pageCreated, NOW)!;
    expect(await notionEnricher(composio)({ ...event, account: "other" })).toEqual({ ...event, account: "other" });
  });

  it("comments on the page an event is about, as the integration", async () => {
    reads({ [NOTION.createComment]: { id: "comment-9" } });
    const sender = notionCommentSender(composio);
    const { event } = normalizeNotion(account, pageCreated, NOW)!;
    expect(sender.reach(event)).toBeUndefined();
    expect(sender.reach({ ...event, source: "email" })).toContain("Notion");
    expect(sender.reach({ ...event, subject: "issue:1" })).toContain("not about a Notion page");
    expect(sender.reach({ ...event, account: "other" })).toContain("not configured");
    expect(await sender.send(event, "Thanks, noted.")).toEqual({ ok: true, url: event.url });
    expect(api.of("execute").at(-1)).toBe(`execute:notion:tady ${NOTION.createComment} {"parent_page_id":"${PAGE}","comment":{"content":"Thanks, noted."}}`);
  });

  it("sends nothing until the integration's bot is known", async () => {
    const fresh = new Composio({ api: new FakeComposioApi(), store: new Store(":memory:"), accounts: [account], publicUrl: "https://x.example", tell: async () => {}, tellHome: async () => {}, now: () => NOW, schedule: () => () => {}, supervisor: new Supervisor({ schedule: () => () => {} }), log: () => {} });
    expect(notionCommentSender(fresh).reach(normalizeNotion(account, pageCreated, NOW)!.event)).toContain("not known yet");
  });

  it("says a refusal is definite, and a network failure is not", async () => {
    const sender = notionCommentSender(composio);
    const { event } = normalizeNotion(account, pageCreated, NOW)!;
    api.answers.set(NOTION.createComment, { ok: false, error: "Could not find page", reason: "refused" });
    expect(await sender.send(event, "x")).toEqual({ ok: false, refused: true, reason: "Could not find page" });
    api.answers.set(NOTION.createComment, { ok: false, error: "fetch failed", reason: "unreachable" });
    expect(await sender.send(event, "x")).toMatchObject({ ok: false, refused: false });
  });
});
