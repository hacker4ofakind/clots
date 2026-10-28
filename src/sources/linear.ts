import { createHmac, timingSafeEqual } from "node:crypto";
import type { LinearAccount } from "../config.js";
import type { Enricher } from "../enrich.js";
import { appendBody, clip } from "../events/body.js";
import type { Sender } from "../events/github-comment.js";
import type { ClotEvent } from "../events/types.js";
import { jsonBody, storeEvent, type Handler } from "../intake.js";

/** A delivery older than this, by its own timestamp, is refused as a possible replay. */
const MAX_AGE_MS = 60_000;

/** Checks `Linear-Signature`: the HMAC-SHA256 of the raw body, in hex, with no prefix. */
export function verifyLinear(secret: string, rawBody: Buffer, header: string | undefined): boolean {
  if (!header) return false;
  const expected = Buffer.from(createHmac("sha256", secret).update(rawBody).digest("hex"));
  const given = Buffer.from(header);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

const text = (value: unknown): string => (typeof value === "string" ? value : "");

/**
 * Turns a Linear delivery into the common event: a new issue or a new comment. Updates and
 * removals, and every other type, are ignored. Returns the actor's ID beside it, so the Clots'
 * own comments can be told apart.
 */
export function normalizeLinear(account: LinearAccount, payload: unknown, deliveryId: string, receivedAt: number): { event: ClotEvent; actorId: string } | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const p = payload as Record<string, any>;
  if (p.action !== "create" || (p.type !== "Issue" && p.type !== "Comment")) return undefined;
  const d: Record<string, any> = p.data ?? {};
  const issue: Record<string, any> = p.type === "Issue" ? d : (d.issue ?? {});
  const identifier = text(issue.identifier);
  const ref = identifier || text(issue.id) || text(d.issueId);
  if (ref === "") return undefined;
  const team = text(issue.team?.key) || (identifier.includes("-") ? identifier.slice(0, identifier.lastIndexOf("-")) : "");
  const actorType = text(p.actor?.type);
  const base = {
    id: `linear:${account.account}:${deliveryId}`,
    source: "linear",
    account: account.account,
    place: team,
    actor: text(p.actor?.name) || text(d.user?.name) || "unknown",
    url: text(p.url) || text(d.url),
    ref,
    subject: `issue:${ref}`,
    automated: actorType !== "" && actorType !== "user",
    outsider: false,
    receivedAt,
  };
  const actorId = text(p.actor?.id) || text(d.userId) || text(d.creatorId);
  if (p.type === "Issue") return { actorId, event: { ...base, kind: "issue_opened", title: `Issue ${ref} opened: ${text(d.title)}`, body: clip(text(d.description)) } };
  return { actorId, event: { ...base, kind: "comment", title: `Comment on ${ref}: ${text(issue.title)}`, body: clip(text(d.body)) } };
}

/** One Linear workspace's intake path. What the Clots' own member did is stored and dropped. */
export function linearHandler(account: LinearAccount, deps: { insertEvent: (event: ClotEvent) => boolean; now: () => number; memberId: () => string }): Handler {
  return (req) => {
    if (!verifyLinear(account.webhookSecret, req.rawBody, req.headers["linear-signature"])) return { status: 401, text: "bad signature" };
    const delivery = req.headers["linear-delivery"];
    if (!delivery) return { status: 400, text: "missing Linear-Delivery" };
    const payload = jsonBody(req.rawBody) as Record<string, any> | undefined;
    if (payload === undefined) return { status: 400, text: "body is not JSON" };
    if (typeof payload.webhookTimestamp === "number" && Math.abs(deps.now() - payload.webhookTimestamp) > MAX_AGE_MS) return { status: 401, text: "stale delivery" };
    const found = normalizeLinear(account, payload, delivery, deps.now());
    if (!found) return { status: 200, text: "ignored" };
    const member = deps.memberId();
    return storeEvent(found.event, deps.insertEvent, member !== "" && found.actorId === member ? "caused by the Clot itself" : undefined);
  };
}

/** Linear's GraphQL API, as the account a personal key belongs to. Throws on an HTTP error or a GraphQL error. */
export function linearApi(apiKey: string, fetchFn: typeof fetch = fetch): (query: string, variables?: Record<string, unknown>) => Promise<any> {
  return async (query, variables = {}) => {
    const response = await fetchFn("https://api.linear.app/graphql", { method: "POST", headers: { authorization: apiKey, "content-type": "application/json" }, body: JSON.stringify({ query, variables }) });
    if (!response.ok) throw Object.assign(new Error(`Linear answered ${response.status}`), { status: response.status });
    const answer: any = await response.json();
    if (Array.isArray(answer.errors) && answer.errors.length > 0) throw Object.assign(new Error(String(answer.errors[0]?.message ?? "Linear refused the request")), { refused: true });
    return answer.data;
  };
}

/** The ID of the Linear account a key belongs to: the Clots' member. */
export async function linearMember(apiKey: string, fetchFn: typeof fetch = fetch): Promise<string> {
  return text((await linearApi(apiKey, fetchFn)("query { viewer { id } }")).viewer?.id);
}

const ISSUE_QUERY = `query Issue($id: String!) {
  issue(id: $id) {
    identifier description priorityLabel
    state { name } assignee { name } labels { nodes { name } }
    comments(last: 10) { nodes { body createdAt user { name } } }
  }
}`;

export const LINEAR_UNREAD = "[More about this issue could not be read from Linear.]";

/** Adds the issue's state, people, description (for a comment) and its latest comments. */
export function linearEnricher(accounts: LinearAccount[], fetchFn: typeof fetch = fetch): Enricher {
  return async (event) => {
    const account = accounts.find((candidate) => candidate.account === event.account);
    if (!account) return event;
    let issue: any;
    try {
      issue = (await linearApi(account.apiKey, fetchFn)(ISSUE_QUERY, { id: event.ref })).issue;
    } catch {
      return appendBody(event, LINEAR_UNREAD);
    }
    if (!issue) return appendBody(event, LINEAR_UNREAD);
    const facts = [`State: ${text(issue.state?.name) || "?"}`, `priority ${text(issue.priorityLabel) || "none"}`, `assigned to ${text(issue.assignee?.name) || "nobody"}`];
    const labels = (issue.labels?.nodes ?? []).map((label: any) => text(label.name)).filter(Boolean);
    if (labels.length > 0) facts.push(`labels ${labels.join(", ")}`);
    const comments = (issue.comments?.nodes ?? []).map((c: any) => `- ${text(c.user?.name) || "someone"} (${text(c.createdAt).slice(0, 10)}): ${text(c.body).replace(/\s+/g, " ").slice(0, 400)}`);
    const block = [
      `From Linear:\n${facts.join("; ")}`,
      ...(event.kind === "comment" && text(issue.description) ? [`Description:\n${text(issue.description).slice(0, 1500)}`] : []),
      ...(comments.length > 0 ? [`Latest comments:\n${comments.join("\n")}`] : []),
    ].join("\n\n");
    return appendBody(event, block);
  };
}

/**
 * Sends a standing rule's message as a comment on the Linear issue the event is about, as the Clots'
 * member. `memberId` gives that member's ID for an account, or "" while it is not known.
 */
export function linearCommentSender(accounts: LinearAccount[], memberId: (account: string) => string, fetchFn: typeof fetch = fetch): Sender {
  const accountOf = (name: string) => accounts.find((candidate) => candidate.account === name);
  return {
    reach(event) {
      if (event.source !== "linear") return "this way of sending answers Linear issues, and this event is not one";
      if (!event.subject.startsWith("issue:")) return "this event is not about a Linear issue";
      if (!accountOf(event.account)) return `the Linear account ${event.account} is not configured`;
      // Its own comment comes back as an event, and must be told apart from anyone else's, or a rule would answer itself.
      if (memberId(event.account) === "") return "the Clots' Linear member is not known yet, so its own comment could not be told apart; nothing is sent until the daemon has read it";
      return undefined;
    },

    async send(event, body) {
      const api = linearApi(accountOf(event.account)!.apiKey, fetchFn);
      try {
        const found = await api("query Find($id: String!) { issue(id: $id) { id } }", { id: event.ref });
        const issueId = text(found.issue?.id);
        if (issueId === "") return { ok: false, refused: true, reason: `Linear has no issue ${event.ref}` };
        const made = await api("mutation Comment($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { url } } }", { input: { issueId, body } });
        if (made.commentCreate?.success !== true) return { ok: false, refused: true, reason: "Linear did not create the comment" };
        return { ok: true, url: text(made.commentCreate.comment?.url) || event.url };
      } catch (error: any) {
        const definite = error?.refused === true || (typeof error?.status === "number" && error.status >= 400 && error.status < 500);
        return { ok: false, refused: definite, reason: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}
