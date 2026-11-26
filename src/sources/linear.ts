import type { Composio } from "../composio/component.js";
import type { Mapper } from "../composio/intake.js";
import { LINEAR, LINEAR_GRAPHQL } from "../composio/toolkits/linear.js";
import type { ZodType } from "zod";
import type { LinearAccount } from "../config.js";
import type { Enricher } from "../enrich.js";
import { appendBody, clip } from "../events/body.js";
import type { Sender } from "../events/github-comment.js";

const text = (value: unknown): string => (typeof value === "string" ? value : "");

/**
 * Turns Composio's Linear trigger payloads into the common events of stage 2c: a new issue or a new
 * comment. Composio reports no actor type, so a comment with no user (an integration's) is the one
 * that counts as automated. The ID is the issue's or comment's own, so a repeated poll is a repeat.
 */
export const linearMapper: Mapper = (account, slug, payload, _webhookId, receivedAt) => {
  if (typeof payload !== "object" || payload === null) return undefined;
  const d = payload as Record<string, any>;
  const isIssue = slug === LINEAR.issueCreated;
  if (!isIssue && slug !== LINEAR.commentCreated) return undefined;
  const issue: Record<string, any> = isIssue ? d : (d.issue ?? {});
  const identifier = text(issue.identifier);
  const ref = identifier || text(issue.id);
  if (ref === "" || text(d.id) === "") return undefined;
  const who: Record<string, any> | undefined = (isIssue ? d.creator : d.user) ?? undefined;
  const known = who !== undefined && text(who.id) !== "";
  // The team's key; its ID until an enrichment can read the key, and never empty, since routing needs a place.
  const place = text(issue.team?.key) || (identifier.includes("-") ? identifier.slice(0, identifier.lastIndexOf("-")) : "") || text(issue.team?.id) || "linear";
  const base = {
    id: `linear:${account.account}:${isIssue ? "Issue" : "Comment"}:${text(d.id)}`,
    source: "linear",
    account: account.account,
    place,
    actor: text(who?.name) || "unknown",
    url: text(d.url) || text(issue.url),
    ref,
    subject: `issue:${ref}`,
    automated: !isIssue && !known,
    outsider: !known,
    receivedAt,
  };
  const actorId = known ? text(who!.id) : "";
  if (isIssue) return { actorId, objectIds: [text(d.id)], event: { ...base, kind: "issue_opened", title: `Issue ${ref} opened: ${text(d.title)}`, body: clip(text(d.description)) } };
  return { actorId, objectIds: [text(d.id)], event: { ...base, kind: "comment", title: `Comment on ${ref}: ${text(issue.title)}`, body: clip(text(d.body)) } };
};

/**
 * Runs a GraphQL operation as the account's own member, through Composio. Throws `refused` when Linear or Composio turned it down,
 * or when the answer did not have the shape `check` (the whole answer, from `LINEAR_GRAPHQL`) says the caller relies on.
 */
export async function linearGraphql(c: Composio, account: LinearAccount, query: string, variables: Record<string, unknown> = {}, check?: ZodType): Promise<any> {
  const result = await c.runChecked(account, LINEAR.graphql, { query_or_mutation: query, variables }, check);
  if (!result.ok) throw Object.assign(new Error(result.error), { refused: result.reason === "refused" || result.reason === "auth" });
  const answer = (result.data as any)?.data;
  const errors = (result.data as any)?.errors;
  if (Array.isArray(errors) && errors.length > 0) throw Object.assign(new Error(String(errors[0]?.message ?? "Linear refused the request")), { refused: true });
  return answer;
}

const ISSUE_QUERY = `query Issue($id: String!) {
  issue(id: $id) {
    identifier description priorityLabel team { key }
    state { name } assignee { name } labels { nodes { name } }
    comments(last: 10) { nodes { body createdAt user { name } } }
  }
}`;

export const LINEAR_UNREAD = "[More about this issue could not be read from Linear.]";

/** Adds the issue's state, people, description (for a comment) and its latest comments, and the team's key as the place. */
export function linearEnricher(c: Composio): Enricher {
  return async (event) => {
    const account = c.account(event.account, "linear") as LinearAccount | undefined;
    if (!account) return event;
    let issue: any;
    try {
      issue = (await linearGraphql(c, account, ISSUE_QUERY, { id: event.ref }, LINEAR_GRAPHQL.issue))?.issue;
    } catch {
      return appendBody(event, LINEAR_UNREAD);
    }
    if (!issue) return appendBody(event, LINEAR_UNREAD);
    const facts = [`State: ${text(issue.state?.name) || "?"}`, `priority ${text(issue.priorityLabel) || "none"}`, `assigned to ${text(issue.assignee?.name) || "nobody"}`];
    const labels = (issue.labels?.nodes ?? []).map((label: any) => text(label.name)).filter(Boolean);
    if (labels.length > 0) facts.push(`labels ${labels.join(", ")}`);
    const comments = (issue.comments?.nodes ?? []).map((n: any) => `- ${text(n.user?.name) || "someone"} (${text(n.createdAt).slice(0, 10)}): ${text(n.body).replace(/\s+/g, " ").slice(0, 400)}`);
    const block = [
      `From Linear:\n${facts.join("; ")}`,
      ...(event.kind === "comment" && text(issue.description) ? [`Description:\n${text(issue.description).slice(0, 1500)}`] : []),
      ...(comments.length > 0 ? [`Latest comments:\n${comments.join("\n")}`] : []),
    ].join("\n\n");
    const key = text(issue.team?.key);
    return appendBody(key !== "" && event.place !== key ? { ...event, place: key } : event, block);
  };
}

/**
 * Sends a standing rule's message as a comment on the Linear issue the event is about, as the Clots'
 * member. Not rated again: the rule is what the user approved. Until the member's ID is known its own
 * comment could not be told apart, so nothing is sent.
 */
export function linearCommentSender(c: Composio): Sender {
  const accountOf = (name: string) => c.account(name, "linear") as LinearAccount | undefined;
  return {
    reach(event) {
      if (event.source !== "linear") return "this way of sending answers Linear issues, and this event is not one";
      if (!event.subject.startsWith("issue:")) return "this event is not about a Linear issue";
      const account = accountOf(event.account);
      if (!account) return `the Linear account ${event.account} is not configured`;
      // Its own comment comes back as an event, and must be told apart from anyone else's, or a rule would answer itself.
      if (c.identity(account) === "") return "the Clots' Linear member is not known yet, so its own comment could not be told apart; nothing is sent until Clots has read it";
      return undefined;
    },

    async send(event, body) {
      const account = accountOf(event.account)!;
      try {
        const found = await linearGraphql(c, account, "query Find($id: String!) { issue(id: $id) { id } }", { id: event.ref }, LINEAR_GRAPHQL.issueId);
        const issueId = text(found?.issue?.id);
        if (issueId === "") return { ok: false, refused: true, reason: `Linear has no issue ${event.ref}` };
        const made = await linearGraphql(c, account, "mutation Comment($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { id url } } }", { input: { issueId, body } }, LINEAR_GRAPHQL.commentCreate);
        if (made?.commentCreate?.success !== true) return { ok: false, refused: true, reason: "Linear did not create the comment" };
        return { ok: true, url: text(made.commentCreate.comment?.url) || event.url };
      } catch (error: any) {
        return { ok: false, refused: error?.refused === true, reason: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}
