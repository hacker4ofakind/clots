import { ApiFailure } from "./api-client";

/**
 * Whether the daemon's own words can be shown as they are: a sentence it wrote for a person ("There is a Clot named Home
 * already."), not a code, a status line or a stack ("invalid request", "internal error", "Failed with 500", "TypeError: x").
 */
function isSentence(text: string): boolean {
  if (text.length < 8 || text.length > 240) return false;
  if (!/^[A-Z0-9]/.test(text) || !/[.?!"')]$/.test(text)) return false;
  if (/^Failed with \d+/.test(text) || /^\w*Error\b/.test(text) || /[{}]|\bat .+:\d+|\n/.test(text)) return false;
  return true;
}

/**
 * What to tell a person about a failed call: the daemon's own sentence when it wrote one for them, otherwise a plain line for
 * what kind of failure it was, otherwise `fallback` (which says what was being done: "That tool could not be removed."). Raw
 * server text, status lines and error class names never get through.
 */
export function readableError(error: unknown, fallback: string): string {
  if (!(error instanceof ApiFailure)) return fallback;
  if (error.unreachable) return "The daemon can't be reached. Try again in a moment.";
  if (error.status === 401 || error.status === 403) return "That isn't allowed from this page. Reload it and try again.";
  if (error.status === 413) return "That is too large to send.";
  if (error.status === 429) return "Too many tries. Wait a moment and try again.";
  if (error.status >= 500) return fallback;
  return isSentence(error.message) ? error.message : fallback;
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
