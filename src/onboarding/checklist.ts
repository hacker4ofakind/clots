/** One step of a new Clot's setup, as the chat's checklist card shows it. */
export interface ChecklistItem {
  id: "webhook" | "tools" | "push-branch";
  done: boolean;
  detail: string;
}

/** The small key-value store the marks are kept in, so a daemon restart does not untick a step. */
export interface Marks {
  getState(key: string): string | undefined;
  setState(key: string, value: string): void;
  deleteState(key: string): void;
}

const keyFor = (kind: "webhook" | "push", repo: string) => `onboarding:${kind}:${repo.toLowerCase()}`;

/** GitHub's ping for a repository arrived: its webhook works. */
export const markWebhook = (marks: Marks, repo: string): void => marks.setState(keyFor("webhook", repo), "1");

/** Forgets GitHub's ping for a repository, so its webhook step is open again (the webhook may have been deleted on GitHub). */
export const resetWebhook = (marks: Marks, repo: string): void => marks.deleteState(keyFor("webhook", repo));

/** A push to a repository by the Clots' own GitHub account: a branch was pushed with the Clot's token. Pushes by anyone else do not count. */
export function markPush(marks: Marks, repo: string, sender: string, clotLogin: string): boolean {
  if (clotLogin === "" || sender.toLowerCase() !== clotLogin.toLowerCase()) return false;
  marks.setState(keyFor("push", repo), "1");
  return true;
}

export interface ChecklistDeps {
  marks: Marks;
  /** The Clot's repository as owner/name, or null (the home Clot has none). */
  repo: string | null;
  /** The Composio tools bound to the Clot, each with whether its connection is active. */
  tools: { id: string; active: boolean }[];
  /** Whether a worker of the Clot has a pull request open (a branch is certainly pushed). */
  hasPullRequest: boolean;
}

/**
 * The checklist, each step by a real check: GitHub's ping for the repository, every tool's connection active, a branch pushed by the
 * Clot's account (GitHub's push event from its login, or a pull request one of its workers opened). A Clot with no tool to connect has
 * that step done: there is nothing to check.
 */
export function checklist(d: ChecklistDeps): ChecklistItem[] {
  const pinged = d.repo !== null && d.marks.getState(keyFor("webhook", d.repo)) !== undefined;
  const pushed = d.hasPullRequest || (d.repo !== null && d.marks.getState(keyFor("push", d.repo)) !== undefined);
  const waiting = d.tools.filter((t) => !t.active);
  return [
    { id: "webhook", done: pinged, detail: pinged ? "GitHub has reached Clots." : `Waiting to hear from GitHub about ${d.repo ?? "the repository"}.` },
    {
      id: "tools",
      done: waiting.length === 0,
      detail: d.tools.length === 0 ? "No tool to connect. Add one in Settings, Integrations when it needs one." : waiting.length === 0 ? `${d.tools.length} connected.` : `Waiting for ${waiting.map((t) => t.id).join(", ")} to connect.`,
    },
    { id: "push-branch", done: pushed, detail: pushed ? "The Clot has pushed a branch." : "Done once the Clot has pushed a branch." },
  ];
}
