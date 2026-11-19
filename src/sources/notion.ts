import { createHmac, timingSafeEqual } from "node:crypto";
import type { Composio } from "../composio/component.js";
import { NOTION } from "../composio/toolkits/notion.js";
import type { NotionAccount } from "../config.js";
import type { Enricher } from "../enrich.js";
import { appendBody } from "../events/body.js";
import type { Sender } from "../events/github-comment.js";
import type { ClotEvent } from "../events/types.js";
import { jsonBody, storeEvent, type Handler } from "../intake.js";
import type { Store } from "../store.js";

/** Where an account's verification token is kept, when it did not come from .env. */
export const verificationKey = (account: string) => `notion-verification:${account}`;

/** Checks `X-Notion-Signature`: "sha256=" and the HMAC-SHA256 of the raw body in hex, keyed with the verification token. */
export function verifyNotion(token: string, rawBody: Buffer, header: string | undefined): boolean {
  if (!header) return false;
  const expected = Buffer.from(`sha256=${createHmac("sha256", token).update(rawBody).digest("hex")}`);
  const given = Buffer.from(header);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** A page's web address. */
export const pageUrl = (pageId: string) => `https://www.notion.so/${pageId.replace(/-/g, "")}`;

const text = (value: unknown): string => (typeof value === "string" ? value : "");

/**
 * Turns a Notion delivery into the common event: a page created, or a comment added. Notion's
 * events only say that something happened; the enricher reads what. Returns the authors' IDs
 * beside it, so the integration's own comments can be told apart.
 */
export function normalizeNotion(account: NotionAccount, payload: unknown, receivedAt: number): { event: ClotEvent; authorIds: string[] } | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const p = payload as Record<string, any>;
  if (typeof p.id !== "string" || (p.type !== "page.created" && p.type !== "comment.created")) return undefined;
  const page = p.type === "page.created" ? text(p.entity?.id) : text(p.data?.page_id);
  if (page === "") return undefined;
  const authors: { id: string; type: string }[] = Array.isArray(p.authors) ? p.authors.map((a: any) => ({ id: text(a?.id), type: text(a?.type) })) : [];
  const parent = p.data?.parent ?? {};
  const lines = [
    `Notion event: ${p.type}`,
    `Page: ${page}`,
    ...(text(parent.id) ? [`In: ${text(parent.type) || "parent"} ${text(parent.id)}`] : []),
    // The enricher finds the comment by this line: the event's own ID names the delivery, not the comment.
    ...(p.type === "comment.created" ? [`Comment ID: ${text(p.entity?.id)}`] : []),
  ];
  return {
    authorIds: authors.map((a) => a.id).filter(Boolean),
    event: {
      id: `notion:${account.account}:${p.id}`,
      source: "notion",
      account: account.account,
      kind: p.type === "page.created" ? "page_created" : "comment",
      place: text(parent.id),
      actor: authors[0]?.id || "unknown",
      title: p.type === "page.created" ? "A page was created in Notion" : "A comment was added in Notion",
      body: lines.join("\n"),
      url: pageUrl(page),
      ref: page,
      subject: `page:${page}`,
      automated: authors.length > 0 && authors.every((a) => a.type === "bot"),
      outsider: false,
      receivedAt,
    },
  };
}

/**
 * One Notion workspace's intake path. Its first request is the verification handshake: the token
 * is kept, printed in the daemon's log for the user to copy into Notion, and never replaced by a
 * later request. A token in .env comes first.
 */
export function notionHandler(account: NotionAccount, deps: { store: Store; now: () => number; botId: () => string; log: (text: string) => void }): Handler {
  return (req) => {
    const payload = jsonBody(req.rawBody) as Record<string, any> | undefined;
    if (payload === undefined) return { status: 400, text: "body is not JSON" };
    const known = account.verificationToken ?? deps.store.getState(verificationKey(account.account));
    // The handshake carries the token and no event. Notion may sign it too, but the signature cannot be
    // checked yet: the token is its key. So only the first is kept, and it never replaces a known token.
    if (typeof payload.verification_token === "string" && payload.type === undefined) {
      if (known !== undefined) {
        deps.log(`[notion] ${account.account}: a verification request arrived, but this account already has a token; it was ignored.`);
        return { status: 200, text: "ok" };
      }
      deps.store.setState(verificationKey(account.account), payload.verification_token);
      deps.log(`[notion] ${account.account}: verification token, to paste into the integration's Webhooks tab in Notion:\n${payload.verification_token}`);
      return { status: 200, text: "ok" };
    }
    if (known === undefined) return { status: 401, text: "this subscription is not verified yet" };
    if (!verifyNotion(known, req.rawBody, req.headers["x-notion-signature"])) return { status: 401, text: "bad signature" };
    const found = normalizeNotion(account, payload, deps.now());
    if (!found) return { status: 200, text: "ignored" };
    const bot = deps.botId();
    return storeEvent(found.event, (event) => deps.store.insertEvent(event), bot !== "" && found.authorIds.includes(bot) ? "caused by the Clot itself" : undefined);
  };
}

const plain = (richText: unknown): string => (Array.isArray(richText) ? richText.map((part: any) => text(part?.plain_text)).join("") : "");

/** A page property as text. */
function propertyText(property: any): string {
  switch (property?.type) {
    case "title":
    case "rich_text":
      return plain(property[property.type]);
    case "select":
    case "status":
      return text(property[property.type]?.name);
    case "multi_select":
      return (property.multi_select ?? []).map((option: any) => text(option.name)).join(", ");
    case "people":
      return (property.people ?? []).map((person: any) => text(person.name) || text(person.id)).join(", ");
    case "date":
      return [text(property.date?.start), text(property.date?.end)].filter(Boolean).join(" to ");
    case "checkbox":
      return property.checkbox ? "yes" : "no";
    case "number":
      return property.number === null || property.number === undefined ? "" : String(property.number);
    case "url":
    case "email":
    case "phone_number":
      return text(property[property.type]);
    default:
      return "";
  }
}

const TEXT_BLOCKS = new Set(["paragraph", "heading_1", "heading_2", "heading_3", "bulleted_list_item", "numbered_list_item", "to_do", "quote", "callout", "toggle", "code"]);

export const NOTION_UNREAD = "[More about this could not be read from Notion.]";

/** What a Notion read through Composio answers: Notion's own object, as `data`. Throws when Composio or Notion refused. */
async function read(c: Composio, account: NotionAccount, slug: string, args: Record<string, unknown>): Promise<any> {
  const result = await c.run(account, slug, args);
  if (!result.ok) throw Object.assign(new Error(result.error), { refused: result.reason === "refused" || result.reason === "auth" });
  return result.data;
}

/** Reads what a Notion event is about: the page's title, properties and first text, a comment and its discussion, and who wrote it. */
export function notionEnricher(c: Composio): Enricher {
  return async (event) => {
    const account = c.account(event.account, "notion") as NotionAccount | undefined;
    if (!account) return event;
    try {
      const page = await read(c, account, NOTION.retrievePage, { page_id: event.ref });
      const properties = Object.entries(page.properties ?? {}) as [string, any][];
      const title = properties.map(([, property]) => (property?.type === "title" ? plain(property.title) : "")).find((value) => value !== "") || "(untitled)";
      const author = await read(c, account, NOTION.getUser, { user_id: event.actor }).then((user) => text(user.name), () => "");
      // The delivery names its author by ID only; the name, when it can be read, becomes the actor.
      const actor = author || event.actor;
      const facts = properties.filter(([, property]) => property?.type !== "title").map(([name, property]) => [name, propertyText(property)]).filter(([, value]) => value !== "").map(([name, value]) => `${name}: ${value}`);
      const parts = [`From Notion:\nPage: "${title}"${author ? `\nBy: ${author}` : ""}`, ...(facts.length > 0 ? [facts.join("\n")] : [])];
      if (event.kind === "comment") {
        const comments: any[] = (await read(c, account, NOTION.fetchComments, { block_id: event.ref, page_size: 100 })).results ?? [];
        const commentId = /^Comment ID: (.+)$/m.exec(event.body)?.[1];
        const own = comments.find((comment) => comment.id === commentId);
        const discussion = comments.filter((comment) => own !== undefined && comment.discussion_id === own.discussion_id && comment !== own);
        parts.push(`Comment: ${plain(own?.rich_text) || "(it could not be found; it may be on a block of the page, or resolved)"}`);
        if (discussion.length > 0) parts.push(`Earlier in the discussion:\n${discussion.map((comment) => `- ${plain(comment.rich_text)}`).join("\n")}`);
        return { ...appendBody(event, parts.join("\n\n")), title: `Comment on "${title}" in Notion`, actor };
      }
      const blocks: any[] = (await read(c, account, NOTION.fetchBlocks, { block_id: event.ref, page_size: 100 })).results ?? [];
      const content = blocks
        .filter((block) => TEXT_BLOCKS.has(block.type))
        .map((block) => plain(block[block.type]?.rich_text))
        .filter((line) => line !== "")
        .join("\n");
      if (content !== "") parts.push(`Content:\n${content.slice(0, 2000)}`);
      return { ...appendBody(event, parts.join("\n\n")), title: `Page created in Notion: "${title}"`, actor };
    } catch {
      return appendBody(event, NOTION_UNREAD);
    }
  };
}

/**
 * Sends a standing rule's message as a comment on the Notion page the event is about, as the
 * integration, through Composio. Not rated again: the rule is what the user approved. Until the
 * integration's bot is known its own comment could not be told apart, so nothing is sent.
 */
export function notionCommentSender(c: Composio): Sender {
  const accountOf = (name: string) => c.account(name, "notion") as NotionAccount | undefined;
  return {
    reach(event) {
      if (event.source !== "notion") return "this way of sending answers Notion pages, and this event is not one";
      if (!event.subject.startsWith("page:")) return "this event is not about a Notion page";
      const account = accountOf(event.account);
      if (!account) return `the Notion account ${event.account} is not configured`;
      // Its own comment comes back as an event, and must be told apart from anyone else's, or a rule would answer itself.
      if (c.identity(account) === "") return "the Notion integration's bot is not known yet, so its own comment could not be told apart; nothing is sent until the daemon has read it";
      return undefined;
    },

    async send(event, body) {
      const result = await c.run(accountOf(event.account)!, NOTION.createComment, { parent_page_id: event.ref, comment: { content: body } });
      if (result.ok) return { ok: true, url: event.url };
      return { ok: false, refused: result.reason === "refused" || result.reason === "auth", reason: result.error };
    },
  };
}
