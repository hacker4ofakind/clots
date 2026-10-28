import path from "node:path";
import { splitCommandLine, type Verdict } from "./command-check.js";

/** What the guard knows about the worker: its branch, the default branch it started from, and its repository. */
export interface GuardContext {
  branch: string | null;
  base: string | null;
  /** owner/name, or null for a home Clot worker, whose repository the daemon does not know. */
  repo?: string | null;
}

const OK: Verdict = { ok: true };
const MAIN = " That belongs to the main session: say it in your report or ask with ask_main.";
/** A refusal for what a command does. */
const no = (reason: string): Verdict => ({ ok: false, reason: `Refused: ${reason}.${MAIN}` });

const MAILERS = new Set(["sendmail", "mail", "mailx", "mutt", "msmtp", "ssmtp", "swaks"]);
const SHELLS = new Set(["sh", "bash", "zsh"]);
const WRAPPERS = new Set(["env", "command", "nohup", "timeout", "xargs", "sudo"]);

const GH_ALLOWED = new Set([
  ...["pr create", "pr view", "pr list", "pr diff", "pr checks", "pr status"],
  ...["issue view", "issue list", "run view", "run list", "run watch", "repo view", "repo list", "repo clone", "auth status"],
]);
/** Those that change something on GitHub: with -R they must name the worker's own repository. */
const GH_WRITING = new Set(["pr create", "pr edit", "pr close"]);
const GH_API_WRITING = new Set(["-X", "--method", "-f", "-F", "--field", "--raw-field", "--input"]);
const PUSH_FLAGS = new Set(["-u", "--set-upstream", "--force-with-lease"]);

/**
 * The worker guard's verdict on a shell command line. A worker works freely: pipes, redirections
 * and substitutions are everyday development. Only a line that names gh, a git push or config, or
 * a mail sender is read closely, and it must then be written plainly enough to be read.
 */
export function guardCommand(line: string, w: GuardContext): Verdict {
  const scan = line
    .replace(/["']/g, "")
    .split(/[\s|&;()<>`$=]+/)
    .filter((token) => token !== "")
    .map((token) => path.posix.basename(token));
  if (scan.some((token) => MAILERS.has(token))) return no("a worker sends no mail");
  const gh = scan.includes("gh");
  const git = scan.includes("git") && (scan.some((token) => ["push", "config", "remote", "alias"].includes(token)) || scan.some((token, i) => token === "git" && scan[i + 1] === "-c"));
  if (!gh && !git) return OK;

  const cleaned = line.trim().replace(/(^|\s)2>&1(?=\s|$)/g, "$1").replace(/(^|\s)2>\s?\/dev\/null(?=\s|$)/g, "$1");
  const commands = splitCommandLine(cleaned);
  if (typeof commands === "string") return { ok: false, reason: `Commands that use gh, git push or a mail sender must be written plainly, with no ${commands}. Use --body-file or -F <file> for long text.` };
  for (const words of commands) {
    const verdict = checkCommand(words, w);
    if (!verdict.ok) return verdict;
  }
  return OK;
}

function checkCommand(raw: string[], w: GuardContext): Verdict {
  const words = unwrap(raw);
  if (!Array.isArray(words)) return words;
  if (words.length === 0) return OK;
  const name = path.posix.basename(words[0]);
  if (SHELLS.has(name)) {
    const flag = words.findIndex((word, i) => i > 0 && /^-[a-z]*c[a-z]*$/.test(word));
    return flag !== -1 && words[flag + 1] !== undefined ? guardCommand(words[flag + 1], w) : OK;
  }
  if (MAILERS.has(name)) return no("a worker sends no mail");
  const args = expand(words.slice(1));
  if (name === "gh") return checkGh(args, w);
  if (name === "git") return checkGit(args, w);
  return OK;
}

/**
 * Leaves out leading NAME=value assignments and the wrappers that run the command after them.
 * A wrapper given options is refused: some take a value (`env -u NAME`, `sudo -u user`), and
 * guessing which would let the value pass for the command.
 */
function unwrap(words: string[]): string[] | Verdict {
  let rest = words;
  while (rest.length > 0) {
    const first = rest[0];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(first)) rest = rest.slice(1);
    else if (WRAPPERS.has(path.posix.basename(first))) {
      const wrapper = path.posix.basename(first);
      rest = rest.slice(1);
      if (rest[0]?.startsWith("-")) return { ok: false, reason: `Commands that use gh, git push or a mail sender must be written plainly, with no options on \`${wrapper}\`.` };
      // timeout takes its duration before the command.
      if (wrapper === "timeout" && rest.length > 0) rest = rest.slice(1);
    } else break;
  }
  return rest;
}

/** `--opt=value` becomes `--opt value`; a short flag with its value joined on (`-XPOST`, `-ftitle=x`) becomes the flag and the value. */
function expand(args: string[]): string[] {
  return args.flatMap((arg) => {
    if (arg.startsWith("--force-with-lease")) return ["--force-with-lease"];
    const long = /^(--[^=]+)=(.*)$/s.exec(arg);
    if (long) return [long[1], long[2]];
    const short = /^(-[A-Za-z])(.+)$/s.exec(arg);
    return short ? [short[1], short[2]] : [arg];
  });
}

/** The flags of `gh pr edit` and `gh pr close` that take a value. Every other flag is boolean. */
const GH_PR_VALUE_FLAGS = new Set([
  ...["-t", "--title", "-b", "--body", "-F", "--body-file", "-B", "--base", "-m", "--milestone", "-c", "--comment"],
  ...["--add-label", "--remove-label", "--add-assignee", "--remove-assignee", "--add-reviewer", "--remove-reviewer", "--add-project", "--remove-project"],
]);

/**
 * Words that are neither flags nor the value of a flag that takes one: a pull request selector,
 * wherever it stands. Read left to right as gh reads them: a flag that takes a value consumes the
 * next word, whatever it looks like, so `--title --body 42` leaves 42 as the selector.
 */
function positionals(args: string[]): string[] {
  const found: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    if (GH_PR_VALUE_FLAGS.has(args[i])) i += 1;
    else if (!args[i].startsWith("-")) found.push(args[i]);
  }
  return found;
}

function checkGh(all: string[], w: GuardContext): Verdict {
  const repos: string[] = [];
  const args: string[] = [];
  for (let i = 0; i < all.length; i += 1) {
    if (all[i] === "-R" || all[i] === "--repo") repos.push((all[(i += 1)] ?? "").toLowerCase());
    else args.push(all[i]);
  }
  const sub = `${args[0] ?? ""} ${args[1] ?? ""}`.trim();
  const rest = args.slice(2);

  if (repos.length > 0) {
    const own = w.repo?.toLowerCase();
    if (own === undefined || own === null) {
      if (GH_WRITING.has(sub)) return no(`a worker of the home Clot cannot run \`gh ${sub}\` in a named repository`);
    } else if (repos.some((repo) => repo !== own)) return no(`\`gh -R\` may only name this worker's repository, ${own}`);
  }

  if (sub === "pr edit" || sub === "pr close") {
    if (positionals(rest).length > 0) return no(`\`gh ${sub}\` may only act on this branch's own pull request, so it takes no number`);
    if (sub === "pr close" && rest.some((arg) => arg === "-c" || arg === "--comment")) return no("a worker posts no comments");
    return OK;
  }
  if (args[0] === "api") {
    const writing = args.find((arg) => GH_API_WRITING.has(arg));
    return writing === undefined ? OK : no(`\`gh api ${writing}\` can change something on GitHub`);
  }
  if (sub === "auth status" && rest.some((arg) => arg === "-t" || arg === "--show-token")) return no("a worker does not show its token");
  if (GH_ALLOWED.has(sub)) return OK;
  return no(`\`gh ${sub}\` is not allowed for a worker`);
}

function checkGit(args: string[], w: GuardContext): Verdict {
  const sub = args[0];
  if (sub === undefined) return OK;
  if (sub.startsWith("-")) return no("git options before the subcommand are not allowed for a worker");
  const rest = args.slice(1);
  if (sub === "config" || sub === "remote") {
    const other = rest.find((arg) => !["-v", "show", "get-url"].includes(arg));
    return other === undefined ? OK : no(`\`git ${sub}\` may only be read`);
  }
  if (sub === "push") return checkPush(rest, w);
  return OK;
}

function checkPush(args: string[], w: GuardContext): Verdict {
  const flag = args.find((arg) => arg.startsWith("-") && !PUSH_FLAGS.has(arg));
  if (flag !== undefined) return no(`\`git push ${flag}\` is not allowed for a worker`);
  const targets = args.filter((arg) => !arg.startsWith("-"));
  if (w.branch === null) return no("this worker has no branch to push");
  const only = `\`git push -u origin ${w.branch}\``;
  if (targets.length !== 2 || targets[0] !== "origin") return no(`a worker pushes only with ${only}`);
  const refspec = targets[1];
  const destination = refspec.includes(":") ? refspec.slice(refspec.indexOf(":") + 1) : refspec;
  if (w.base !== null && destination === w.base) return no("a worker never pushes the default branch");
  if (refspec !== w.branch && refspec !== `HEAD:${w.branch}`) return no(`a worker pushes only its own branch, with ${only}`);
  return OK;
}
