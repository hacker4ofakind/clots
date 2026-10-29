import { githubRequest, isRepo } from "../github-api.js";
import type { ClotEvent } from "./types.js";

/**
 * What became of a send. When it failed, `refused` says whether it is certain that nothing was
 * sent: the source answered and said no. A failure that is not a refusal may have gone through.
 */
export type SendResult = { ok: true; url: string } | { ok: false; refused: boolean; reason: string };

/** One way of sending a standing rule's message: given the event and the final text, send it and return a link. */
export interface Sender {
  /** Why this event cannot be answered this way, or undefined when it can. Asked before anything is recorded. */
  reach(event: ClotEvent): string | undefined;
  send(event: ClotEvent, text: string): Promise<SendResult>;
}

/** The number of the issue or pull request an event is about: "pr:14" gives "14". Nothing for a branch. */
export function threadNumber(subject: string): string | undefined {
  return /^(?:pr|issue):(\d+)$/.exec(subject)?.[1];
}

/** Posts a comment on the issue or pull request the event is about, as the Clots' own account. */
export function githubCommentSender(token: string, fetchFn: typeof fetch = fetch): Sender {
  return {
    reach: (event) => (threadNumber(event.subject) === undefined ? "this event is about a branch, not an issue or a pull request, so there is nowhere to send" : undefined),

    async send(event, text) {
      const number = threadNumber(event.subject);
      if (number === undefined) return { ok: false, refused: true, reason: "the event is not about an issue or a pull request" };
      if (!isRepo(event.place)) return { ok: false, refused: true, reason: "the event's repository name is not one GitHub allows" };
      let answer: { status: number; body: any };
      try {
        // GitHub takes comments on a pull request at the issues address too.
        answer = await githubRequest(token, `/repos/${event.place}/issues/${number}/comments`, { method: "POST", body: { body: text } }, fetchFn);
      } catch (error) {
        return { ok: false, refused: false, reason: error instanceof Error ? error.message : String(error) };
      }
      if (answer.status < 200 || answer.status >= 300) return { ok: false, refused: answer.status >= 400 && answer.status < 500, reason: `GitHub answered ${answer.status}` };
      return { ok: true, url: typeof answer.body?.html_url === "string" ? answer.body.html_url : event.url };
    },
  };
}
