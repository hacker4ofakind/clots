/** Every call to GitHub gives up after this long. */
const TIMEOUT_MS = 15_000;

/** owner/name, as GitHub allows them. Checked before any URL is built. */
const REPO = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
const SHA = /^[0-9a-f]{40}$/i;

export const isRepo = (repo: string) => REPO.test(repo);
export const isSha = (sha: string) => SHA.test(sha);
export const isNumber = (n: number) => Number.isInteger(n) && n > 0;

/** GitHub could not be asked, or did not answer in time. Its message never holds the token. */
export class GithubUnreachable extends Error {}

/**
 * One call to GitHub's REST API with the Clots' token: the token, accept and API-version headers,
 * and a 15-second timeout. Answers with the status and the JSON body; throws GithubUnreachable
 * when there is no answer.
 */
export async function githubRequest(token: string, path: string, init: { method?: string; body?: unknown } = {}, fetchFn: typeof fetch = fetch): Promise<{ status: number; body: any }> {
  let response: Response;
  try {
    response = await fetchFn(`https://api.github.com${path}`, {
      method: init.method ?? "GET",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "clots",
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    const reason = error instanceof Error ? (error.name === "TimeoutError" ? "no answer within 15 seconds" : error.message) : String(error);
    throw new GithubUnreachable(`GitHub could not be reached (${reason.split(token).join("***")})`);
  }
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

export interface PullRequest {
  state: "open" | "closed";
  draft: boolean;
  merged: boolean;
  title: string;
  url: string;
  /** The head branch's name. */
  headRef: string;
  /** owner/name of the repository the head branch is in, lowercased. */
  headRepo: string;
  headSha: string;
  /** The branch it merges into. */
  base: string;
  changedFiles: number;
  additions: number;
  deletions: number;
}

const failure = (what: string, status: number, body: any) => new Error(`${what}: GitHub answered ${status}${typeof body?.message === "string" ? ` (${body.message})` : ""}`);

/** A pull request as GitHub has it now. Throws when it cannot be read. */
export async function getPullRequest(token: string, repo: string, n: number, fetchFn: typeof fetch = fetch): Promise<PullRequest> {
  const { status, body } = await githubRequest(token, `/repos/${repo}/pulls/${n}`, {}, fetchFn);
  if (status !== 200) throw failure(`pull request ${repo}#${n} could not be read`, status, body);
  return {
    state: body.state === "open" ? "open" : "closed",
    draft: body.draft === true,
    merged: body.merged === true,
    title: String(body.title ?? ""),
    url: String(body.html_url ?? ""),
    headRef: String(body.head?.ref ?? ""),
    headRepo: String(body.head?.repo?.full_name ?? "").toLowerCase(),
    headSha: String(body.head?.sha ?? ""),
    base: String(body.base?.ref ?? ""),
    changedFiles: Number(body.changed_files ?? 0),
    additions: Number(body.additions ?? 0),
    deletions: Number(body.deletions ?? 0),
  };
}

/** The repository's default branch. Throws when it cannot be read. */
export async function getDefaultBranch(token: string, repo: string, fetchFn: typeof fetch = fetch): Promise<string> {
  const { status, body } = await githubRequest(token, `/repos/${repo}`, {}, fetchFn);
  if (status !== 200 || typeof body.default_branch !== "string") throw failure(`${repo} could not be read`, status, body);
  return body.default_branch;
}

export interface CheckCounts {
  passed: number;
  failed: number;
  pending: number;
  /** More than 100 check runs: the counts are of the first 100. */
  more: boolean;
}

const PASSED = ["success", "neutral", "skipped"];

/** The check runs and commit statuses of a commit, counted; undefined when they cannot be read. */
export async function checkSummary(token: string, repo: string, sha: string, fetchFn: typeof fetch = fetch): Promise<CheckCounts | undefined> {
  try {
    const [runs, statuses] = await Promise.all([githubRequest(token, `/repos/${repo}/commits/${sha}/check-runs?per_page=100`, {}, fetchFn), githubRequest(token, `/repos/${repo}/commits/${sha}/status`, {}, fetchFn)]);
    if (runs.status !== 200 || statuses.status !== 200) return undefined;
    const counts: CheckCounts = { passed: 0, failed: 0, pending: 0, more: Number(runs.body.total_count ?? 0) > 100 };
    for (const run of (runs.body.check_runs ?? []) as { status?: string; conclusion?: string }[]) {
      if (run.status !== "completed") counts.pending += 1;
      else if (PASSED.includes(run.conclusion ?? "")) counts.passed += 1;
      else counts.failed += 1;
    }
    for (const s of (statuses.body.statuses ?? []) as { state?: string }[]) {
      if (s.state === "success") counts.passed += 1;
      else if (s.state === "pending") counts.pending += 1;
      else counts.failed += 1;
    }
    return counts;
  } catch {
    return undefined;
  }
}

/**
 * Squash-merges a pull request, pinned to the head commit the user was shown: GitHub refuses when
 * the head has moved. A refusal carries GitHub's message; `unclear` means there was no clear answer.
 */
export async function mergePullRequest(token: string, repo: string, n: number, sha: string, fetchFn: typeof fetch = fetch): Promise<{ ok: true } | { ok: false; message: string; unclear?: true }> {
  try {
    const { status, body } = await githubRequest(token, `/repos/${repo}/pulls/${n}/merge`, { method: "PUT", body: { merge_method: "squash", sha } }, fetchFn);
    if (status === 200) return { ok: true };
    const message = typeof body?.message === "string" ? body.message : `GitHub answered ${status}`;
    if (status >= 500) return { ok: false, message, unclear: true };
    return { ok: false, message };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error), unclear: true };
  }
}
