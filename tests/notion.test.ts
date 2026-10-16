import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import type { NotionAccount } from "../src/config.js";
import { normalizeNotion, notionCommentSender, notionEnricher, notionHandler, pageUrl, verificationKey, verifyNotion } from "../src/sources/notion.js";
import { Store } from "../src/store.js";

const account: NotionAccount = { account: "tady", shared: true, token: "ntn_test" };
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

describe("Notion's API", () => {
  function api(routes: Record<string, unknown>) {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      const key = Object.keys(routes).find((k) => url.includes(k));
      return key === undefined ? new Response("{}", { status: 404 }) : Response.json(routes[key]);
    }) as unknown as typeof fetch;
    return { calls, fetchFn };
  }

  const page = { id: PAGE, url: "https://www.notion.so/Feedback-1a2b", properties: { Name: { type: "title", title: [{ plain_text: "Export is slow" }] }, Status: { type: "status", status: { name: "New" } }, Tags: { type: "multi_select", multi_select: [{ name: "perf" }, { name: "export" }] } } };

  it("names a new page and adds its properties, its text and its author", async () => {
    const { fetchFn } = api({
      [`/pages/${PAGE}`]: page,
      [`/blocks/${PAGE}/children`]: { results: [{ type: "paragraph", paragraph: { rich_text: [{ plain_text: "Exporting 2 GB takes ten minutes." }] } }, { type: "to_do", to_do: { rich_text: [{ plain_text: "check worker" }] } }] },
      "/users/person-1": { name: "Ann" },
    });
    const { event } = normalizeNotion(account, pageCreated, NOW)!;
    const read = await notionEnricher([account], fetchFn)(event);
    expect(read.title).toBe('Page created in Notion: "Export is slow"');
    expect(read.url).toBe(event.url);
    expect(read.body).toContain("By: Ann");
    expect(read.actor).toBe("Ann");
    expect(read.body).toContain("Status: New");
    expect(read.body).toContain("Tags: perf, export");
    expect(read.body).toContain("Exporting 2 GB takes ten minutes.\ncheck worker");
  });

  it("names a comment by its page and adds the comment and its discussion", async () => {
    const { fetchFn } = api({
      [`/pages/${PAGE}`]: page,
      "/comments": { results: [{ id: "comment-0", discussion_id: "d-1", created_by: { id: "person-1" }, rich_text: [{ plain_text: "Is this still slow?" }] }, { id: "comment-1", discussion_id: "d-1", created_by: { id: "person-2" }, rich_text: [{ plain_text: "Yes, since Monday." }] }] },
      "/users/": { name: "Ann" },
    });
    const read = await notionEnricher([account], fetchFn)({ ...normalizeNotion(account, commentCreated, NOW)!.event, automated: false });
    expect(read.title).toBe('Comment on "Export is slow" in Notion');
    expect(read.actor).toBe("Ann");
    expect(read.body).toContain("Comment: Yes, since Monday.");
    expect(read.body).toContain("Earlier in the discussion:\n- Is this still slow?");
  });

  it("comments on the page an event is about, as the integration", async () => {
    const { calls, fetchFn } = api({ "/comments": { id: "comment-9" } });
    const sender = notionCommentSender([account], fetchFn);
    const { event } = normalizeNotion(account, pageCreated, NOW)!;
    expect(sender.reach(event)).toBeUndefined();
    expect(sender.reach({ ...event, source: "email" })).toContain("Notion");
    expect(await sender.send(event, "Thanks, noted.")).toEqual({ ok: true, url: event.url });
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ parent: { page_id: PAGE }, rich_text: [{ type: "text", text: { content: "Thanks, noted." } }] });
    expect((calls[0].init.headers as Record<string, string>)["notion-version"]).toBe("2022-06-28");
  });
});
