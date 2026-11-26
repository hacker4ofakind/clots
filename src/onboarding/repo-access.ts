import { isRepo } from "../github-api.js";

export type RepoAccess = { ok: true; accepted?: boolean } | { ok: false; login?: string; message: string; invite: boolean; /** Checking again can change the answer once the person has acted or waited. */ again?: boolean };

/**
 * Whether the machine account can reach a repository. When it cannot, but an invitation is waiting, the invitation is
 * accepted with the account's own token; when there is none, the answer says whom to invite, so the user can do it and check again.
 */
export async function checkRepoAccess(o: { token: string; repo: string; fetchFn?: typeof fetch }): Promise<RepoAccess> {
  const { token, repo } = o;
  const doFetch = o.fetchFn ?? fetch;
  if (!isRepo(repo)) return { ok: false, invite: false, message: "A repository is written owner/name." };
  const call = (path: string, init: RequestInit = {}) => doFetch(`https://api.github.com${path}`, { ...init, headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "clots" } });
  try {
    const res = await call(`/repos/${repo}`);
    if (res.ok) return { ok: true };
    if (res.status === 401) return { ok: false, invite: false, again: true, message: "GitHub did not accept the Clots GitHub account's key. Replace CLOT_GITHUB_TOKEN under Keys." };
    if (res.status === 429 || (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0")) return { ok: false, invite: false, again: true, message: "GitHub is limiting requests right now. Wait a few minutes." };
    if (res.status >= 500) return { ok: false, invite: false, again: true, message: "GitHub is having trouble right now. Wait a moment." };
    // Not found or forbidden: an invitation may be waiting.
    const invitations = await call("/user/repository_invitations");
    if (invitations.ok) {
      const list = (await invitations.json()) as { id: number; repository?: { full_name?: string } }[];
      const mine = list.find((i) => i.repository?.full_name?.toLowerCase() === repo.toLowerCase());
      if (mine) {
        const accepted = await call(`/user/repository_invitations/${mine.id}`, { method: "PATCH" });
        if (accepted.ok || accepted.status === 204) return { ok: true, accepted: true };
      }
    }
    const who = await call("/user");
    const login = who.ok ? ((await who.json()) as { login?: string }).login : undefined;
    return { ok: false, invite: true, again: true, ...(login === undefined ? {} : { login }), message: `${login ?? "The machine account"} cannot reach ${repo}. Invite ${login ?? "it"} as a collaborator on the repository.` };
  } catch {
    return { ok: false, invite: false, again: true, message: "GitHub could not be reached. Check the internet connection." };
  }
}
