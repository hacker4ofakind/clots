import { describe, expect, it } from "vitest";
import { checkCommand, lockDecision, lockHookAnswer } from "../src/agent/command-check.js";

const APPROVED = [
  "cat src/index.ts",
  "head -n 20 README.md",
  "tail -f /dev/null",
  "ls -la",
  "wc -l src/*.ts",
  "stat package.json",
  "file dist/app",
  "tree -L 2",
  "ps aux",
  "grep -rn 'TODO' src",
  'grep -n "a > b" notes.txt',
  "rg --json 'use(State|Effect)' src",
  "find . -name '*.ts' -newer package.json",
  "sort -u names.txt",
  "sort -k2,2n data.tsv",
  "sort --check names.txt",
  "uniq -c names.txt",
  "uniq -f1 names.txt",
  "cut -d, -f1 data.csv | sort | uniq -c",
  "git log --oneline -20",
  "git diff main...HEAD -- src",
  "git show HEAD~1:package.json",
  "git status --short",
  "git blame -L 10,20 src/app.ts",
  "git ls-files",
  "git grep -n 'login'",
  "git branch",
  "git branch -a -vv",
  "git branch --show-current",
  "gh issue view 7 --comments",
  "gh issue list --state open",
  "gh pr view 9 --json reviews",
  "gh pr list",
  "gh pr diff 9",
  "gh pr checks 9",
  "gh run view 4242 --log",
  "gh run list --branch clot/fix-login",
  "gh run view 4242 --log 2>&1 | tail -50",
  "gh repo view",
  "gh repo view --json name,description,defaultBranchRef",
  "gh repo view owner/app --json defaultBranchRef --jq .defaultBranchRef.name",
  "ls missing 2>/dev/null",
  "docker ps -a",
  "pm2 ps",
  "pm2 list",
  "ping -c 3 example.com",
  "ping -c3 example.com",
  "git status && git log -1",
  "git status; ls",
  "cat a.txt || cat b.txt",
  "cat 'my file.txt'",
  "file -b --mime-type dist/app",
  'grep -n "total$" report.txt',
  "grep -n 'cost: $5' notes.txt",
  "grep -n price\\$ notes.txt",
  "pwd",
  "echo checking",
  "cd src && ls",
  "which node",
  "date",
  "cat my\\ file.txt",
];

const REFUSED: [command: string, why: string][] = [
  ["", "empty"],
  ["rm -rf node_modules", "not on the approved list"],
  ["npm install", "not on the approved list"],
  ["curl https://example.com", "not on the approved list"],
  ["/bin/cat secrets", "not on the approved list"],
  ["FOO=1 cat a.txt", "not on the approved list"],
  ["xargs cat", "not on the approved list"],
  ["echo hi > out.txt", "redirection"],
  ["cat a.txt >> b.txt", "redirection"],
  ["cat < a.txt", "redirection"],
  ["cat a.txt 2> errors.txt", "redirection"],
  ["cat $(ls)", "command substitution"],
  ["cat `ls`", "command substitution"],
  ['cat "$(ls)"', "command substitution"],
  ["ls & rm -rf .", "background execution"],
  ["(ls)", "subshell"],
  ["ls\nrm -rf .", "more than one line"],
  ["cat 'unterminated", "unclosed quote"],
  ["ls |", "empty command"],
  ["ls;", "empty command"],
  ["cat a.txt | tee b.txt", "not on the approved list"],
  ["git status && rm -rf .", "not on the approved list"],
  ["find . -name '*.log' -delete", "find -delete"],
  ["find . -exec rm {} +", "subshell or group"],
  ["find . -exec rm x \\;", "find -exec"],
  ["find . -fprint out.txt", "find -fprint"],
  ["find . -fprintf out.txt '%p'", "find -fprintf"],
  ["rg --pre ./evil.sh pattern", "rg --pre"],
  ["rg --hostname-bin=./evil.sh pattern", "rg --hostname-bin"],
  ["sort -o out.txt in.txt", "sort -o"],
  ["sort -uo out.txt in.txt", "sort -uo"],
  ["sort --output=out.txt in.txt", "sort --output"],
  ["sort --o=out.txt in.txt", "sort --o=out.txt"],
  ["sort --compress-program=./evil.sh big.txt", "sort --compress-program"],
  ["sort --compress-prog=./evil.sh big.txt", "sort --compress-prog"],
  ["uniq in.txt out.txt", "second file"],
  ["uniq -c -- in.txt out.txt", "second file"],
  ["uniq -f 1 in.txt", "second file"],
  ["tree -o out.txt", "tree -o"],
  ["file -C -m magic", "file -C"],
  ["file -bC -m magic", "file -bC"],
  ["file -0C -m magic", "file -0C"],
  ["git grep -5O./evil.sh login", "git grep -5O"],
  ["file --compile -m magic", "file --compile"],
  ["file --comp -m magic", "file --comp"],
  ["find /dev/null $'-exec' sh -c 'printf harmless' \\;", "$'...'"],
  ["sort $'-o' out.txt in.txt", "$'...'"],
  ['cat $"file"', "$'...'"],
  ["find . -name a$IFS-delete", "variable expansion"],
  ['find . "-ex${x}ec" rm {} +', "variable expansion"],
  ["cat $HOME/.npmrc", "variable expansion"],
  ['cat "$1"', "variable expansion"],
  ["git push", "git push"],
  ["git commit -am x", "git commit"],
  ["git checkout main", "git checkout"],
  ["git -c core.pager=./evil.sh log", "before the subcommand"],
  ["git -C /tmp status", "before the subcommand"],
  ["git diff --output=out.patch", "git diff --output"],
  ["git log --ext-diff -p", "git log --ext-diff"],
  ["git grep -O'./evil.sh' login", "git grep -O"],
  ["git grep --open-files-in-pager=./evil.sh login", "git grep --open-files-in-pager"],
  ["git grep --open=./evil.sh login", "git grep --open"],
  ["git branch new-branch", "only list"],
  ["git branch -D old", "only list"],
  ["gh pr merge 9", "gh pr merge"],
  ["gh pr comment 9 --body hi", "gh pr comment"],
  ["gh issue close 7", "gh issue close"],
  ["gh api repos/o/r/issues -X POST", "gh api"],
  ["gh pr view 9 --web", "browser"],
  ["gh repo view --web", "browser"],
  ["gh repo view owner/app -w", "browser"],
  ["gh repo", "gh repo"],
  ["gh repo list", "gh repo list"],
  ["gh repo create owner/new --private", "gh repo create"],
  ["gh repo delete owner/app --yes", "gh repo delete"],
  ["gh repo edit --visibility public", "gh repo edit"],
  ["gh repo fork owner/app", "gh repo fork"],
  ["gh repo clone owner/app", "gh repo clone"],
  ["gh repo rename new-name", "gh repo rename"],
  ["gh repo sync", "gh repo sync"],
  ["gh repo archive owner/app", "gh repo archive"],
  ["gh repo set-default owner/app", "gh repo set-default"],
  ["docker run --rm alpine", "docker ps"],
  ["docker exec app sh", "docker ps"],
  ["pm2 restart all", "pm2 ps"],
  ["ping example.com", "count"],
  ["ping -c 500 example.com", "count"],
  ["ping -c x example.com", "count"],
];

describe("checkCommand", () => {
  it.each(APPROVED)("approves: %s", (command) => {
    expect(checkCommand(command)).toEqual({ ok: true });
  });

  it.each(REFUSED)("refuses: %s", (command, why) => {
    const verdict = checkCommand(command);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toContain(why);
  });

  it("approves the project's test command only when given exactly", () => {
    expect(checkCommand("npm test", "npm test")).toEqual({ ok: true });
    expect(checkCommand("  npm test  ", "npm test")).toEqual({ ok: true });
    expect(checkCommand("npm test && rm -rf .", "npm test").ok).toBe(false);
    expect(checkCommand("npm test -- --update", "npm test").ok).toBe(false);
    expect(checkCommand("npm test").ok).toBe(false);
    expect(checkCommand("npm test", "").ok).toBe(false);
  });
});

describe("lockDecision", () => {
  it("lets reading, searching, the web and subagents through", () => {
    for (const tool of ["Read", "Glob", "Grep", "WebSearch", "WebFetch", "Task", "Agent", "Skill", "ToolSearch", "TodoWrite", "TaskOutput"]) {
      expect(lockDecision(tool, {})).toEqual({ ok: true });
    }
  });

  it("checks shell commands", () => {
    expect(lockDecision("Bash", { command: "git status" })).toEqual({ ok: true });
    const refused = lockDecision("Bash", { command: "git push" });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reason).toContain("`git push` is not on the approved list");
    expect(lockDecision("Bash", {}).ok).toBe(false);
  });

  it("passes the test command through", () => {
    expect(lockDecision("Bash", { command: "npm test" }, "npm test")).toEqual({ ok: true });
  });

  it("refuses every other tool, including ones that write files or reach other services", () => {
    for (const tool of ["Edit", "Write", "NotebookEdit", "mcp__claude_ai_Slack__send_message", "SomethingNew"]) {
      expect(lockDecision(tool, {}).ok).toBe(false);
    }
  });
});

describe("lockHookAnswer", () => {
  it("says nothing about a call the lock approves, so the usual permission check goes on", () => {
    expect(lockHookAnswer("Read", { file_path: "a.ts" })).toEqual({});
    expect(lockHookAnswer("Bash", { command: "git status" })).toEqual({});
    expect(lockHookAnswer("Bash", { command: "npm test" }, "npm test")).toEqual({});
  });

  it("denies everything else, with the reason", () => {
    expect(lockHookAnswer("Bash", { command: "git push" })).toEqual({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: expect.stringContaining("`git push` is not on the approved list") },
    });
    for (const [tool, input] of [["Write", { file_path: "a.ts" }], ["mcp__x__send", {}], ["Bash", undefined], ["Bash", "git status"], ["Bash", { command: "file -0C -m magic" }]] as const) {
      expect(lockHookAnswer(tool, input).hookSpecificOutput?.permissionDecision).toBe("deny");
    }
  });
});
