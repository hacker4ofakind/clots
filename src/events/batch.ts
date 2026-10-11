import { MAX_BODY } from "./github.js";
import type { ClotEvent } from "./types.js";

/** Longest body kept from each event that goes into a batch, in characters. */
const MAX_MEMBER_BODY = 800;

/** "pr:14" becomes "pull request #14"; "issue:7", "issue #7"; "branch:main", "branch main". */
export function describeSubject(subject: string): string {
  const at = subject.indexOf(":");
  const type = subject.slice(0, at);
  const name = subject.slice(at + 1);
  if (type === "pr") return `pull request #${name}`;
  if (type === "issue") return `issue #${name}`;
  return `branch ${name}`;
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
  const name = first.subject.slice(at + 1);
  const body = kept.map((e) => [`- ${e.title}`, `  by ${e.actor}: ${e.url}`, ...(e.body.trim() === "" ? [] : [clip(e.body.trim(), MAX_MEMBER_BODY)])].join("\n")).join("\n\n");
  return {
    event: {
      id: `batch:${first.id}`,
      source: first.source,
      kind: "batch",
      repo: first.repo,
      actor: [...new Set(kept.map((e) => e.actor))].join(", "),
      title: `${kept.length} automated reports on ${describeSubject(first.subject)}`,
      body: clip(body, MAX_BODY),
      url: first.subject.startsWith("pr:") ? `https://github.com/${first.repo}/pull/${name}` : first.url,
      ref: name,
      subject: first.subject,
      automated: true,
      receivedAt: first.receivedAt,
    },
    absorbed: events,
  };
}
