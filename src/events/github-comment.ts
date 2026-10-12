import type { ClotEvent } from "./types.js";

/**
 * What became of a send. When it failed, `refused` says whether it is certain that nothing was
 * sent: the source answered and said no. A failure that is not a refusal may have gone through.
 */
export type SendResult = { ok: true; url: string } | { ok: false; refused: boolean; reason: string };

/** One way of sending a standing rule's message: given the event and the final text, send it and return a link. */
export interface Sender {
  send(event: ClotEvent, text: string): Promise<SendResult>;
}

/** The number of the issue or pull request an event is about: "pr:14" gives "14". Nothing for a branch. */
export function threadNumber(subject: string): string | undefined {
  return /^(?:pr|issue):(\d+)$/.exec(subject)?.[1];
}

/** Posts a comment on the issue or pull request the event is about, as the Clots' own account. */
export function githubCommentSender(token: string, fetchFn: typeof fetch = fetch): Sender {
  return {
    async send(event, text) {
      const number = threadNumber(event.subject);
      if (number === undefined) return { ok: false, refused: true, reason: "the event is not about an issue or a pull request" };
      let response: Response;
      try {
        // GitHub takes comments on a pull request at the issues address too.
        response = await fetchFn(`https://api.github.com/repos/${event.repo}/issues/${number}/comments`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "clots", "content-type": "application/json" },
          body: JSON.stringify({ body: text }),
        });
      } catch (error) {
        return { ok: false, refused: false, reason: `GitHub could not be reached (${error instanceof Error ? error.message : String(error)})` };
      }
      if (!response.ok) return { ok: false, refused: response.status >= 400 && response.status < 500, reason: `GitHub answered ${response.status}` };
      const posted: any = await response.json().catch(() => ({}));
      return { ok: true, url: typeof posted?.html_url === "string" ? posted.html_url : event.url };
    },
  };
}
