import { MAX_BODY } from "./github.js";
import type { ClotEvent } from "./types.js";

/** Longest body kept from each event that goes into a batch, in characters. */
const MAX_MEMBER_BODY = 800;

/**
 * A subject in words: "pr:14" is "pull request #14", "issue:7" "issue #7", "issue:ENC-12"
 * "issue ENC-12", "customer:cus_1" "customer cus_1". A subject with no type is given as it is.
 */
export function describeSubject(subject: string): string {
  const at = subject.indexOf(":");
  if (at < 0) return subject;
  const type = subject.slice(0, at);
  const name = subject.slice(at + 1);
  if (type === "pr") return `pull request #${name}`;
  if (type === "issue") return /^\d+$/.test(name) ? `issue #${name}` : `issue ${name}`;
  return `${type} ${name}`;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n[truncated]` : text;
}

/**
 * Turns the automated events that were held for one subject into the one event
 * the rest of the pipeline sees. A CI failure reported twice (the same workflow
 * on the same branch) counts once: the latest is kept. When one event is left it
 * is returned as it is; several become a single "batch" event that lists them.
 * `absorbed` holds the events the returned one stands in for.
 */
export function combine(events: ClotEvent[]): { event: ClotEvent; absorbed: ClotEvent[] } {
  const kept = events.filter((e, i) => !(e.kind === "ci_failed" && events.some((later, j) => j > i && later.kind === "ci_failed" && later.title === e.title)));
  if (kept.length === 1) return { event: kept[0], absorbed: events.filter((e) => e !== kept[0]) };

  const first = kept[0];
  const at = first.subject.indexOf(":");
  const name = at < 0 ? first.subject : first.subject.slice(at + 1);
  const body = kept.map((e) => [`- ${e.title}`, `  by ${e.actor}: ${e.url}`, ...(e.body.trim() === "" ? [] : [clip(e.body.trim(), MAX_MEMBER_BODY)])].join("\n")).join("\n\n");
  // A GitHub pull request has a page that gathers what happened to it; any other subject is shown by its first report.
  const onPullRequest = first.source === "github" && first.subject.startsWith("pr:");
  return {
    event: {
      id: `batch:${first.id}`,
      source: first.source,
      account: first.account,
      kind: "batch",
      place: first.place,
      actor: [...new Set(kept.map((e) => e.actor))].join(", "),
      title: `${kept.length} automated reports on ${describeSubject(first.subject)}`,
      body: clip(body, MAX_BODY),
      url: onPullRequest ? `https://github.com/${first.place}/pull/${name}` : first.url,
      ref: name,
      subject: first.subject,
      automated: true,
      outsider: kept.some((e) => e.outsider),
      receivedAt: first.receivedAt,
    },
    absorbed: events,
  };
}
