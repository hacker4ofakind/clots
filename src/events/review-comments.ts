import { MAX_BODY } from "./github.js";
import type { ClotEvent } from "./types.js";

/** Added to a review's body when its inline comments could not be fetched. */
export const INLINE_UNREAD = "[This review's inline comments could not be read.]";

/** Added when a pull request has more comments than the daemon reads. */
export const INLINE_PARTIAL = "[This pull request has more comments than could be read; some of this review's inline comments may be missing.]";

/** The first line of the block of inline comments. */
export const INLINE_HEADING = "Inline comments:";

/** GitHub's largest page, and how many pages are read before giving up. */
const PER_PAGE = 100;
const MAX_PAGES = 10;

/** Whether a review's body already holds what the reader adds, so that it is not added twice. */
export function hasInline(event: ClotEvent): boolean {
  return [INLINE_HEADING, INLINE_UNREAD, INLINE_PARTIAL].some((mark) => event.body.includes(mark));
}

/** The review's ID, which GitHub puts at the end of its link: ".../pull/9#pullrequestreview-123". */
export function reviewIdOf(event: ClotEvent): string | undefined {
  return /#pullrequestreview-(\d+)$/.exec(event.url)?.[1];
}

/** Where a comment sits: ":12", or ":10-14" for a range, and a note when the line is one the pull request removes. */
function place(c: any): string {
  const line = c.line ?? c.original_line;
  if (typeof line !== "number") return "";
  const start = c.start_line ?? c.original_start_line;
  const range = typeof start === "number" && start !== line ? `${start}-${line}` : `${line}`;
  return `:${range}${c.side === "LEFT" ? " (old version of the file)" : ""}`;
}

/** Most lines of code shown for a comment on a range. */
const MAX_CODE_LINES = 12;

/**
 * The code a comment is on, from the piece of diff GitHub sends with it, which ends at the
 * commented line: that line, or for a comment on a range, the lines of the range.
 */
function codeOf(c: any): string {
  if (typeof c.diff_hunk !== "string") return "";
  const line = c.line ?? c.original_line;
  const start = c.start_line ?? c.original_start_line;
  const count = typeof line === "number" && typeof start === "number" && line > start ? Math.min(line - start + 1, MAX_CODE_LINES) : 1;
  // A comment on the new version of the file is not about the lines the diff removes, and the other way round.
  const otherSide = c.side === "LEFT" ? "+" : "-";
  const code = c.diff_hunk
    .split("\n")
    .filter((l: string) => !l.startsWith("@@") && !l.startsWith(otherSide))
    .slice(-count)
    .map((l: string) => l.replace(/^[+\- ]/, "").trimEnd().slice(0, 200));
  if (code.every((l: string) => l.trim() === "")) return "";
  return code.length === 1 ? `\n  on: ${code[0].trim()}` : `\n  on:\n${code.map((l: string) => `    ${l}`).join("\n")}`;
}

/**
 * A pull request's review comments as lines of "path:line: text", each followed by the
 * code it is on. With a review ID, only that review's comments. Returns "" when there are none.
 */
export function formatInlineComments(comments: unknown, reviewId?: string): string {
  if (!Array.isArray(comments)) return "";
  const lines = comments
    .filter((c) => typeof c?.path === "string" && typeof c?.body === "string" && (reviewId === undefined || String(c.pull_request_review_id) === reviewId))
    .map((c) => `- ${c.path}${place(c)}: ${c.body.trim()}${codeOf(c)}`);
  return lines.length === 0 ? "" : `${INLINE_HEADING}\n${lines.join("\n")}`;
}

/** The review with a block of text added to its body, inside the usual length limit. */
export function withInline(event: ClotEvent, block: string): ClotEvent {
  if (block === "") return event;
  const body = event.body.trim() === "" ? block : `${event.body}\n\n${block}`;
  return { ...event, body: body.length > MAX_BODY ? `${body.slice(0, MAX_BODY)}\n[truncated]` : body };
}

/**
 * Makes the function the pipeline uses to add a review's inline comments to its
 * event. GitHub does not send them with the review, so they are fetched with
 * the Clots' token. A review whose comments cannot be fetched says so in its body.
 */
export function inlineCommentReader(token: string, fetchFn: typeof fetch = fetch): (event: ClotEvent) => Promise<ClotEvent> {
  return async (event) => {
    const id = reviewIdOf(event);
    if (event.kind !== "review" || id === undefined) return event;
    try {
      // The list of one review's comments leaves out their line numbers, so the pull request's
      // comments are fetched, newest first and page by page, and this review's are picked out.
      const comments: unknown[] = [];
      let complete = false;
      for (let page = 1; page <= MAX_PAGES && !complete; page += 1) {
        const response = await fetchFn(`https://api.github.com/repos/${event.repo}/pulls/${event.ref}/comments?sort=created&direction=desc&per_page=${PER_PAGE}&page=${page}`, {
          headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "clots" },
        });
        if (!response.ok) return withInline(event, INLINE_UNREAD);
        const batch: unknown = await response.json();
        if (!Array.isArray(batch)) return withInline(event, INLINE_UNREAD);
        comments.push(...batch);
        complete = batch.length < PER_PAGE;
      }
      const block = formatInlineComments(comments.reverse(), id);
      return withInline(event, complete ? block : [block, INLINE_PARTIAL].filter((part) => part !== "").join("\n"));
    } catch {
      return withInline(event, INLINE_UNREAD);
    }
  };
}
