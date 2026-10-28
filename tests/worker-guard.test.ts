import { describe, expect, it } from "vitest";
import { guardCommand } from "../src/agent/worker-guard.js";

const worker = { branch: "clot/fix-a1b2", base: "main", repo: "o/r" };
const home = { branch: "clot/x-1234", base: null, repo: null };
const MAIN = "That belongs to the main session: say it in your report or ask with ask_main.";

describe("guardCommand", () => {
  it.each([
    "npm test 2>&1 | tail -20",
    "echo $(date) > notes.txt",
    `git commit -m "Fix: don't push twice"`,
    "git status && git diff",
    "git push -u origin clot/fix-a1b2",
    "git push --force-with-lease origin clot/fix-a1b2 2>&1",
    `gh pr create --title "Fix" --body-file /tmp/body.md`,
    "FOO=1 npm run build | tee build.log",
    "git push origin HEAD:clot/fix-a1b2",
    `gh pr create --title "Fix" --body "…"`,
    `gh pr edit --body "x"`,
    "gh pr close",
    "gh pr checks",
    "gh api repos/o/r/pulls/3/comments",
    "grep -r mailer src",
    "gh pr list -R o/r",
    "git remote -v",
    "gh pr close --delete-branch",
    "gh pr edit --add-label bug --title x",
    "gh pr edit --title=--body",
    "gh pr edit --title -x --body y",
    "env gh pr view",
    "timeout 60 gh pr checks",
  ])("lets %s through", (line) => {
    expect(guardCommand(line, worker)).toEqual({ ok: true });
  });

  it("lets a home Clot worker push its own branch and read any repository", () => {
    expect(guardCommand("git push -u origin clot/x-1234", home)).toEqual({ ok: true });
    expect(guardCommand("gh pr list -R someone/else", home)).toEqual({ ok: true });
  });

  it.each([
    "git push origin main",
    "git push origin HEAD:main",
    "git push origin :clot/fix-a1b2",
    "git push --tags",
    "git push --all",
    "git push origin other-branch",
    "git -C ../repo push origin HEAD",
    "gh pr merge 3",
    "gh pr comment 3 -b hi",
    "gh pr review --approve",
    "gh pr close 7",
    "gh pr edit 7 --title x",
    "gh pr close --delete-branch 42",
    "gh pr edit --add-label bug 7",
    "gh pr edit --title x 7",
    "gh pr edit --title=--body 42",
    "gh pr edit --title --body 42",
    "gh pr edit -t -b 42",
    "gh pr close --comment=--delete-branch 42",
    "gh issue comment 1 -b hi",
    "gh issue close 1",
    "gh release create v1",
    "gh repo edit --visibility public",
    "gh api -X POST repos/o/r/issues",
    "gh api repos/o/r/issues -f title=x",
    `sh -c "gh pr merge 3"`,
    "cd x && gh pr merge 3",
    "echo hi | mail -s x a@b.c",
    "sendmail a@b.c < m.txt",
    "git push",
    "git push -u origin HEAD",
    "git push --force origin clot/fix-a1b2",
    "git push -f origin clot/fix-a1b2",
    "git push --no-verify origin clot/fix-a1b2",
    "/usr/bin/gh pr merge 3",
    `g""h pr merge 3`,
    "FOO=1 gh pr merge 3",
    "env gh pr merge 3",
    "bash -c 'gh pr merge 3'",
    "gh api -XPOST repos/o/r/issues",
    "gh api --method=PUT x",
    "gh api x -ftitle=y",
    "gh auth status --show-token",
    "gh pr list -R other/repo",
    "git -c alias.p=push p origin main",
    "git config alias.p push",
    "git remote set-url origin https://x",
  ])("refuses %s, saying it belongs to the main session", (line) => {
    const verdict = guardCommand(line, worker);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason.endsWith(MAIN)).toBe(true);
  });

  it("refuses a home Clot worker's push of any other branch, and its pull request in a named repository", () => {
    expect(guardCommand("git push origin feature", home).ok).toBe(false);
    expect(guardCommand(`gh pr create -R a/b --title x --body-file f`, home).ok).toBe(false);
  });

  it("refuses a wrapper given options, which could take the command's place", () => {
    for (const line of ["env -u UNUSED gh pr merge 42", "env -u X git push origin main", "sudo -u root gh pr merge 1", "timeout -s KILL 10 gh pr merge 3", "xargs -I {} gh pr merge {}"]) {
      expect(guardCommand(line, worker).ok).toBe(false);
    }
  });

  it("refuses a substitution for its syntax only, with the hint and without the main-session sentence", () => {
    for (const line of [`gh pr create --body "$(cat body.md)"`, "git push origin $(git branch --show-current)"]) {
      const verdict = guardCommand(line, worker);
      expect(verdict).toEqual({ ok: false, reason: "Commands that use gh, git push or a mail sender must be written plainly, with no command substitution. Use --body-file or -F <file> for long text." });
    }
  });
});
