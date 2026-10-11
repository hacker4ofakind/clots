import { createHmac, timingSafeEqual } from "node:crypto";
import type { ClotEvent } from "./types.js";

/** Longest body kept from a payload, in characters. */
export const MAX_BODY = 4000;

/** Checks GitHub's `X-Hub-Signature-256` header against the raw request body. */
export function verifySignature(secret: string, rawBody: Buffer, header: string | undefined): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const expected = Buffer.from(`sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`);
  const given = Buffer.from(header);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** "https://github.com/Owner/Repo.git" becomes "owner/repo". */
export function repoSlug(repoUrl: string): string | undefined {
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(repoUrl.trim());
  return match ? `${match[1]}/${match[2]}`.toLowerCase() : undefined;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function trimBody(body: string): string {
  return body.length > MAX_BODY ? `${body.slice(0, MAX_BODY)}\n[truncated]` : body;
}

/**
 * Turns one GitHub delivery into the common event. Returns nothing for a
 * delivery outside the five kinds the Clots react to.
 */
export function normalizeGithub(eventName: string, deliveryId: string, payload: unknown, receivedAt: number): ClotEvent | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const p = payload as Record<string, any>;
  const repo = text(p.repository?.full_name).toLowerCase();
  const actor = text(p.sender?.login);
  const action = text(p.action);
  if (repo === "" || actor === "") return undefined;
  const base = { id: deliveryId, source: "github" as const, repo, actor, receivedAt };
  const bot = p.sender?.type === "Bot" || actor.endsWith("[bot]");

  if (eventName === "issues" && (action === "opened" || action === "reopened") && p.issue) {
    return {
      ...base,
      kind: "issue_opened",
      title: `Issue #${p.issue.number} ${action}: ${text(p.issue.title)}`,
      body: trimBody(text(p.issue.body)),
      url: text(p.issue.html_url),
      ref: String(p.issue.number),
      subject: `issue:${p.issue.number}`,
      automated: bot,
    };
  }

  // GitHub sends comments on pull requests through this event too.
  if (eventName === "issue_comment" && action === "created" && p.issue && p.comment) {
    const on = p.issue.pull_request ? "pull request" : "issue";
    return {
      ...base,
      kind: "comment",
      title: `Comment on ${on} #${p.issue.number}: ${text(p.issue.title)}`,
      body: trimBody(text(p.comment.body)),
      url: text(p.comment.html_url),
      ref: String(p.issue.number),
      subject: `${p.issue.pull_request ? "pr" : "issue"}:${p.issue.number}`,
      automated: bot,
    };
  }

  if (eventName === "pull_request_review" && action === "submitted" && p.review && p.pull_request) {
    return {
      ...base,
      kind: "review",
      title: `Review (${text(p.review.state)}) on pull request #${p.pull_request.number}: ${text(p.pull_request.title)}`,
      body: trimBody(text(p.review.body)),
      url: text(p.review.html_url),
      ref: String(p.pull_request.number),
      subject: `pr:${p.pull_request.number}`,
      automated: bot,
    };
  }

  if (eventName === "pull_request" && (action === "opened" || action === "reopened") && p.pull_request) {
    return {
      ...base,
      kind: "pr_opened",
      title: `Pull request #${p.pull_request.number} ${action}: ${text(p.pull_request.title)}`,
      body: trimBody(text(p.pull_request.body)),
      url: text(p.pull_request.html_url),
      ref: String(p.pull_request.number),
      subject: `pr:${p.pull_request.number}`,
      automated: bot,
    };
  }

  if (eventName === "workflow_run" && action === "completed" && p.workflow_run) {
    const conclusion = text(p.workflow_run.conclusion);
    if (conclusion !== "failure" && conclusion !== "timed_out") return undefined;
    // GitHub lists the pull request a run belongs to; a run on a branch without one is about the branch.
    const pr = p.workflow_run.pull_requests?.[0]?.number;
    return {
      ...base,
      kind: "ci_failed",
      title: `CI ${conclusion === "timed_out" ? "timed out" : "failed"}: ${text(p.workflow_run.name)} on ${text(p.workflow_run.head_branch)}`,
      body: `Workflow run ID: ${p.workflow_run.id}`,
      url: text(p.workflow_run.html_url),
      ref: text(p.workflow_run.head_branch),
      subject: typeof pr === "number" ? `pr:${pr}` : `branch:${text(p.workflow_run.head_branch)}`,
      automated: true,
    };
  }

  return undefined;
}

/**
 * Whether the Clot wrote the thing itself. A failed CI run is never
 * self-caused: GitHub names whoever pushed as its actor, so a failure on the
 * Clot's own branch carries the Clot's login and is exactly what it must hear.
 * A batch is never self-caused either: what went into it was checked on arrival.
 */
export function isSelfCaused(event: ClotEvent, clotLogin: string): boolean {
  if (clotLogin === "" || event.kind === "ci_failed" || event.kind === "batch") return false;
  return event.actor.toLowerCase() === clotLogin.toLowerCase();
}
