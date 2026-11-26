import { labelOf } from "../clot-name.js";
import type { AskKind, AskResult, AskRow, Asks } from "../asks.js";
import { blockedLine, minutes, waitedMinutes } from "./common.js";
import { checkSummary, getDefaultBranch, getPullRequest, isNumber, isRepo, isSha, mergePullRequest, type CheckCounts } from "../github-api.js";

export interface MergePayload {
  /** owner/name, lowercased. */
  repo: string;
  number: number;
  title: string;
  url: string;
  /** The head commit the user is shown: the merge is pinned to it. */
  headSha: string;
  base: string;
  files: number;
  additions: number;
  deletions: number;
  checks: CheckCounts | null;
  /** Asked for in a turn an outsider's text started. */
  outsider: boolean;
}

export const MERGE_FILED =
  "Put to the user in your chat. Do not wait for the answer, and do not say it is merged. Allowing it merges it; you will be told the outcome, and any text the user types in the chat comes to you as a message from them.";

export interface MergeKindDeps {
  token: string;
  fetchFn?: typeof fetch;
}

const name = (p: Pick<MergePayload, "repo" | "number">) => `${p.repo}#${p.number}`;

function checksLine(checks: CheckCounts | null): string {
  if (checks === null) return "Checks: unknown.";
  return `Checks: ${checks.passed} passed, ${checks.failed} failed, ${checks.pending} pending.${checks.more ? " (100+ check runs; these are the first 100.)" : ""}`;
}

/**
 * Merging a pull request to the default branch: hard to undo, and it reaches everyone. A yes
 * squash-merges it at the commit the user saw; a no leaves it open; any other reply goes to the
 * main session. New commits on it, or its closing, withdraw the ask.
 */
export function mergeKind(d: MergeKindDeps): AskKind<MergePayload> {
  /** Whether GitHub says it is merged; undefined when it cannot be read, so the outcome stays unknown. */
  const readMerged = async (p: MergePayload): Promise<boolean | undefined> => (await getPullRequest(d.token, p.repo, p.number, d.fetchFn).catch(() => undefined))?.merged;
  const unknown = (p: MergePayload): [AskResult, string, string] => ["failed", `Whether ${name(p)} was merged is not known: GitHub did not answer clearly, and the pull request could not be read afterwards. Check it on GitHub before asking again.`, `Whether ${name(p)} was merged is not known; check it on GitHub.`];
  const merged = (p: MergePayload): [AskResult, string, string] => ["approved", `The user approved merging ${name(p)}, and it was squash-merged. Its worker closes when GitHub reports the pull request closed.`, `Merged ${name(p)}.`];
  const unclear = (p: MergePayload): [AskResult, string, string] => ["failed", `GitHub did not answer clearly; the pull request is not merged. Ask again if it should be.`, `GitHub did not answer clearly about merging ${name(p)}; it is not merged.`];
  const stopped = (p: MergePayload): [AskResult, string, string] => ["failed", `The daemon stopped while merging ${name(p)}; it is not merged. Ask again if it should be.`, `The daemon stopped while merging ${name(p)}; it is not merged.`];

  return {
    kind: "merge",
    answers: ["allow", "block"],
    view: (clot, p) => ({
      heading: `Allow ${labelOf(clot)} to merge a pull request?`,
      shortHeading: "Allow merging a pull request?",
      rows: [
        { label: "Pull request", value: `${name(p)}, "${p.title}"`, href: p.url },
        { label: "Into", value: p.base },
        { label: "Changes", value: `${p.files} file${p.files === 1 ? "" : "s"}, +${p.additions} −${p.deletions}` },
        { label: "Commit", value: p.headSha.slice(0, 7) },
        { label: "Checks", value: checksLine(p.checks).replace(/^Checks: /, "") },
      ],
      labels: { allow: "Merge", block: "Don't merge" },
      ...(p.outsider ? { warning: "From an outsider's report." } : {}),
    }),
    texts: {
      filed: MERGE_FILED,
      already: "Merging this pull request is already with the user, waiting for their answer.",
      full: () => "Merging this pull request is already with the user, waiting for their answer.",
      notAsked: (reason) => `The user could not be asked just now${reason ? ` (${reason})` : ""}. Suggest the merge in your reply instead.`,
    },

    async onAnswer(ask, answer, io) {
      const p = ask.payload;
      if (answer.action === "block") {
        await io.close("declined", `The user declined merging ${name(p)}; it stays open. Do not ask again unless the user asks.`, `Not merged: ${name(p)} stays open.`);
        return;
      }
      if (answer.action !== "allow") return;
      if (!io.setBusy()) return;
      const done = await mergePullRequest(d.token, p.repo, p.number, p.headSha, d.fetchFn);
      if (done.ok) {
        await io.close(...merged(p));
      } else if (done.unclear) {
        // A merge whose answer was lost may still have happened: GitHub is asked once.
        const state = await readMerged(p);
        await io.close(...(state === undefined ? unknown(p) : state ? merged(p) : unclear(p)));
      } else {
        await io.close("failed", `GitHub refused the merge: ${done.message.replace(/\.$/, "")}.`, `GitHub refused to merge ${name(p)}: ${done.message}`);
      }
    },

    async onFeedback(ask, text, io) {
      const p = ask.payload;
      const message = `[The user's reply to your ask to merge ${name(p)}, "${p.title}". It was not merged, and the ask is closed:]
${text}`;
      await io.close("feedback", null, `Your reply about merging ${name(p)} was passed on; it is not merged.`, { inbox: { id: `merge-feedback:${ask.id}`, text: message, kind: "message", outsider: p.outsider } }, "You answered in chat.");
    },

    async onDeadline(ask, io) {
      const p = ask.payload;
      await io.close("timed_out", `The user did not answer your ask to merge ${name(p)} within ${minutes(waitedMinutes(ask))}, so it was not merged. Do not ask again unless the user asks.`, blockedLine(ask));
    },

    async interrupted(ask: AskRow<MergePayload>, io) {
      const p = ask.payload;
      const state = await readMerged(p);
      await io.close(...(state === undefined ? unknown(p) : state ? merged(p) : stopped(p)));
    },
  };
}

export interface PrepareMergeDeps extends MergeKindDeps {
  /** The Clot's repository as owner/name, lowercased, or null for the home Clot. */
  repoOf(clot: string): string | null;
  /** The repositories the Clot's workers opened pull requests in. */
  workerRepos(clot: string): string[];
}

/** Reads the pull request and checks it may be merged by a Clot. Returns the ask's payload, or why not. */
export async function prepareMerge(d: PrepareMergeDeps, clot: string, a: { number: number; repo?: string }, outsider: boolean): Promise<MergePayload | string> {
  const bound = d.repoOf(clot);
  const repo = (a.repo ?? bound ?? "").toLowerCase();
  if (bound === null && a.repo === undefined) return "Refused: give the repository, owner/name, of one of your workers' pull requests.";
  if (bound !== null && repo !== bound) return `Refused: you can merge only in your own repository, ${bound}.`;
  if (bound === null && !d.workerRepos(clot).includes(repo)) return "Refused: none of your workers opened a pull request in that repository.";
  if (!isRepo(repo) || !isNumber(a.number)) return "Refused: give the repository as owner/name and the pull request's number.";
  let pr;
  let base;
  try {
    [pr, base] = await Promise.all([getPullRequest(d.token, repo, a.number, d.fetchFn), getDefaultBranch(d.token, repo, d.fetchFn)]);
  } catch (error) {
    return `Not asked: ${error instanceof Error ? error.message : String(error)}.`;
  }
  if (pr.state !== "open") return `Refused: ${repo}#${a.number} is ${pr.merged ? "already merged" : "closed"}.`;
  if (pr.draft) return `Refused: ${repo}#${a.number} is a draft.`;
  if (!pr.headRef.startsWith("clot/")) return `Refused: ${repo}#${a.number} is not on a clot/ branch; you can merge only your own workers' pull requests.`;
  if (pr.headRepo !== repo) return `Refused: ${repo}#${a.number} comes from another repository.`;
  if (pr.base !== base) return `Refused: ${repo}#${a.number} merges into ${pr.base}, not the default branch ${base}.`;
  if (!isSha(pr.headSha)) return "Not asked: GitHub gave no head commit for it.";
  const checks = (await checkSummary(d.token, repo, pr.headSha, d.fetchFn)) ?? null;
  return { repo, number: a.number, title: pr.title, url: pr.url, headSha: pr.headSha, base: pr.base, files: pr.changedFiles, additions: pr.additions, deletions: pr.deletions, checks, outsider };
}

/**
 * New commits on a pull request, or its closing, withdraw the ask to merge it: a yes always means
 * what the user saw. A fork's branch, and a replayed delivery for the very commit shown, withdraw nothing.
 */
export async function withdrawMerges(asks: Asks, a: { repo: string; headRepo: string; number: number; action: "opened" | "closed" | "synchronize"; headSha: string }): Promise<void> {
  if (a.headRepo.toLowerCase() !== a.repo.toLowerCase() || a.action === "opened") return;
  const repo = a.repo.toLowerCase();
  const reason = a.action === "synchronize" ? "new commits were pushed" : "the pull request was closed";
  await asks.withdrawWhere<MergePayload>("merge", (p) => p.repo === repo && p.number === a.number && (a.action === "closed" || p.headSha !== a.headSha), reason);
}

/** Opens a merge ask once the pull request has been read. GitHub is asked before the asks' queue. */
export async function askMerge(asks: Asks, kind: AskKind<MergePayload>, d: PrepareMergeDeps, clot: string, a: { number: number; repo?: string }, outsider: boolean): Promise<string> {
  const payload = await prepareMerge(d, clot, a, outsider);
  if (typeof payload === "string") return payload;
  return asks.open(kind, clot, payload, { summary: `Merge ${name(payload)}, "${payload.title}"`, dedupe: `merge:${name(payload)}`, max: Number.MAX_SAFE_INTEGER, outsider });
}
