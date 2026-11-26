import { isSentence, readableText } from "@clots/ui-api-schemas";
import { ApiFailure } from "./api-client";

/**
 * The central place for what a person reads when something fails. Nothing else in the app shows an error as the daemon, the network or
 * a library worded it. The mapping of raw text to sentences is shared with the daemon (packages/ui-api-schemas/src/readable.ts).
 */
export { GENERIC_ERROR, isSentence, readableBuildFailure, readableText } from "@clots/ui-api-schemas";

export const DAEMON_UNREACHABLE = "Can't reach the Clots daemon. Check that it is running, then try again.";
export const TIMED_OUT = "That took too long. Check the connection and try again.";
/** What a hand-edited clots.config.json that could not be used says: the file is the user's, its error is the daemon's. */
export const CONFIG_FILE_PROBLEM = "The file has a mistake, so the last good settings stay in force. Fix it and save again.";
const DAEMON_BUSY = "The Clots daemon isn't answering right now. Try again in a moment.";
const NOT_ALLOWED = "That isn't allowed from this page. Reload it and try again.";
const TOO_LARGE = "That is too large to send.";
const UNSUPPORTED = "That kind of file isn't supported.";
const TOO_MANY = "Too many tries. Wait a moment and try again.";

/** What the daemon said, as text: the `error` of its answer, when it gave one. */
function said(error: ApiFailure): string | undefined {
  const text = typeof error.body === "object" && error.body !== null && "error" in error.body ? (error.body as { error: unknown }).error : undefined;
  return typeof text === "string" ? text.trim() : undefined;
}

/**
 * What to tell a person about a failed call: the daemon's own sentence when it wrote one for them, otherwise a plain line for what
 * kind of failure it was, with what to do next, otherwise `fallback` (which says what was being done: "That tool could not be
 * removed."). Raw server text, status lines, error class names and library messages never get through.
 */
export function readableError(error: unknown, fallback: string): string {
  if (!(error instanceof ApiFailure)) return fallback;
  if (error.timedOut) return TIMED_OUT;
  if (error.unreachable) return DAEMON_UNREACHABLE;
  const text = said(error);
  if (text !== undefined && isSentence(text)) return text;
  const { status } = error;
  if (status === 401 || status === 403) return NOT_ALLOWED;
  if (status === 408 || status === 504) return TIMED_OUT;
  if (status === 413) return TOO_LARGE;
  if (status === 415) return UNSUPPORTED;
  if (status === 429) return TOO_MANY;
  if (status === 502 || status === 503) return DAEMON_BUSY;
  if (status === 404) return `${fallback} It may already be gone. Reload the page.`;
  if (status === 409) return `${fallback} It changed while you were working. Reload the page and try again.`;
  if (status >= 500) return fallback;
  // A 400 with words that name a known failure ("Composio ... 401") still says what to do.
  return text === undefined ? fallback : readableText(text, fallback);
}

/**
 * Like readableError, for a refusal that lists its reasons under `errors` (a list, or a field to its reason): the reasons that are
 * sentences are joined; the rest are left out.
 */
export function readableReasons(error: unknown, fallback: string): string {
  if (error instanceof ApiFailure && !error.unreachable) {
    const errors = (error.body as { errors?: unknown } | null)?.errors;
    const values = Array.isArray(errors) ? errors : errors !== null && typeof errors === "object" ? Object.values(errors) : [];
    const sentences = values.map(String).filter(isSentence);
    if (sentences.length > 0) return sentences.join(" ");
  }
  return readableError(error, fallback);
}

/** A field's reason from the daemon, in words a person reads beside the field. */
export const readableReason = (text: unknown): string => readableText(text, "That isn't valid. Check it and try again.");
