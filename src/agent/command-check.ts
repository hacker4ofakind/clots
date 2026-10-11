/**
 * Decides what a locked turn may do. A locked turn (investigating an event,
 * or brainstorming) can read and look things up, and can change nothing.
 */
export type Verdict = { ok: true } | { ok: false; reason: string };

const OK: Verdict = { ok: true };
const no = (reason: string): Verdict => ({ ok: false, reason });

/**
 * Splits a command line into its commands and their words. Returns the name
 * of the shell feature instead when the line uses one the checker refuses.
 * It understands quotes and backslashes, and nothing cleverer: anything it is
 * not sure about is refused.
 */
function split(line: string): string[][] | string {
  const commands: string[][] = [];
  let words: string[] = [];
  let word = "";
  let inWord = false;
  let quote: "'" | '"' | null = null;

  const endWord = () => {
    if (inWord) words.push(word);
    word = "";
    inWord = false;
  };
  const endCommand = (): boolean => {
    endWord();
    if (words.length === 0) return false;
    commands.push(words);
    words = [];
    return true;
  };

  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    const next = line[i + 1];
    if (quote === "'") {
      if (c === "'") quote = null;
      else word += c;
      continue;
    }
    if (c === "`" || (c === "$" && next === "(")) return "command substitution";
    // The shell would put something else in the word's place, and may split it into several:
    // `a$IFS-delete` reaches `find` as two arguments, and `"-ex${x}ec"` as `-exec`.
    if (c === "$" && next !== undefined && /[A-Za-z0-9_{@*#?!$-]/.test(next)) return "variable expansion";
    // Outside quotes, $'...' is a string with escapes of its own: $'-exec' is `-exec`.
    if (c === "$" && quote === null && (next === "'" || next === '"')) return "a $'...' or $\"...\" string";
    if (quote === '"') {
      if (c === '"') quote = null;
      else if (c === "\\" && next !== undefined) word += line[(i += 1)];
      else word += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      inWord = true;
    } else if (c === "\\" && next !== undefined) {
      word += line[(i += 1)];
      inWord = true;
    } else if (c === "\n" || c === "\r") {
      return "more than one line";
    } else if (c === " " || c === "\t") {
      endWord();
    } else if (c === ">" || c === "<") {
      return "redirection";
    } else if (c === "(" || c === ")" || c === "{" || c === "}") {
      return "a subshell or group";
    } else if (c === "&" && next !== "&") {
      return "background execution";
    } else if (c === "&" || c === "|" || c === ";") {
      if (c !== ";" && next === c) i += 1;
      if (!endCommand()) return "an empty command";
    } else {
      word += c;
      inWord = true;
    }
  }
  if (quote !== null) return "an unclosed quote";
  if (!endCommand()) return "an empty command";
  return commands;
}

/** Commands that only read, whatever their arguments. */
const READERS = new Set(["cat", "head", "tail", "ls", "wc", "cut", "stat", "ps", "grep", "pwd", "echo", "cd", "which", "date"]);

/**
 * For commands that read unless given certain flags: which arguments make them write or run something.
 * GNU tools accept a long option cut short (`sort --o=FILE` is `--output`), so those are matched by
 * their first letters: `--o` can only be `--output`, and `--co` only `--compress-program`.
 */
const WRITING_FLAG: Record<string, (arg: string) => boolean> = {
  find: (a) => ["-exec", "-execdir", "-ok", "-okdir", "-delete", "-fls"].includes(a) || a.startsWith("-fprint"),
  rg: (a) => a.startsWith("--pre") || a.startsWith("--hostname-bin"),
  sort: (a) => a.startsWith("--o") || a.startsWith("--co") || /^-[a-zA-Z]*o/.test(a),
  tree: (a) => a.startsWith("-o") || a.startsWith("--output"),
  // -C (--compile, which `--co` is enough to mean) writes a compiled magic file. It can sit
  // anywhere in a run of short options, after a digit too: `-0C` is `-0 -C`.
  file: (a) => a.startsWith("--co") || /^-[^-]*C/.test(a),
};

const GIT_SUBCOMMANDS = new Set(["log", "diff", "show", "status", "blame", "ls-files", "grep", "branch"]);
const GIT_BRANCH_LISTING = new Set(["-a", "-r", "-v", "-vv", "--list", "--all", "--remotes", "--show-current"]);
const GH_SUBCOMMANDS = new Set(["issue view", "issue list", "pr view", "pr list", "pr diff", "pr checks", "run view", "run list"]);

function checkGit(args: string[]): Verdict {
  const sub = args[0];
  if (sub === undefined || sub.startsWith("-")) return no("git options before the subcommand are not allowed");
  if (!GIT_SUBCOMMANDS.has(sub)) return no(`\`git ${sub}\` is not on the approved list`);
  const rest = args.slice(1);
  // `git grep` accepts a long option cut short, so `--op` is `--open-files-in-pager`, which runs a program.
  const writing = rest.find((a) => a.startsWith("--output") || a === "--ext-diff" || (sub === "grep" && (a.startsWith("--op") || /^-[^-]*O/.test(a))));
  if (writing !== undefined) return no(`\`git ${sub} ${writing}\` can write a file or run a program`);
  if (sub === "branch" && rest.some((a) => !GIT_BRANCH_LISTING.has(a))) return no("`git branch` may only list branches");
  return OK;
}

function checkGh(args: string[]): Verdict {
  const sub = `${args[0] ?? ""} ${args[1] ?? ""}`.trim();
  if (!GH_SUBCOMMANDS.has(sub)) return no(`\`gh ${sub}\` is not on the approved list`);
  if (args.some((a) => a === "--web" || a === "-w")) return no("`gh --web` opens a browser");
  return OK;
}

function checkPing(args: string[]): Verdict {
  let count: number | undefined;
  args.forEach((arg, i) => {
    if (arg === "-c") count = Number(args[i + 1]);
    else if (/^-c\d+$/.test(arg)) count = Number(arg.slice(2));
  });
  if (count === undefined || !Number.isInteger(count) || count < 1 || count > 10) {
    return no("`ping` needs a count of at most ten, for example `ping -c 3 example.com`");
  }
  return OK;
}

/**
 * `uniq INPUT OUTPUT` writes to its second file, so at most one argument that is not an option
 * is allowed. An option's value given separately (`-f 1`) counts as one: it must be attached (`-f1`).
 */
function checkUniq(args: string[]): Verdict {
  const dashes = args.indexOf("--");
  const files = args.filter((a, i) => (dashes !== -1 && i > dashes) || a === "-" || !a.startsWith("-"));
  return files.length > 1 ? no("`uniq` writes to a second file; give it one file at most, and attach option values, as in `-f1`") : OK;
}

function checkWords(words: string[]): Verdict {
  const [name, ...args] = words;
  if (READERS.has(name)) return OK;
  if (name === "uniq") return checkUniq(args);
  const writes = WRITING_FLAG[name];
  if (writes) {
    const flag = args.find(writes);
    return flag === undefined ? OK : no(`\`${name} ${flag}\` can write a file or run a program`);
  }
  if (name === "git") return checkGit(args);
  if (name === "gh") return checkGh(args);
  if (name === "ping") return checkPing(args);
  if (name === "docker") return args[0] === "ps" ? OK : no("only `docker ps` is on the approved list");
  if (name === "pm2") return args[0] === "ps" || args[0] === "list" ? OK : no("only `pm2 ps` and `pm2 list` are on the approved list");
  return no(`\`${name}\` is not on the approved list`);
}

/**
 * Whether a shell command line only reads. Every command in it must be on the
 * approved list. The project's test command, given exactly, is approved too.
 */
export function checkCommand(line: string, testCommand?: string): Verdict {
  const trimmed = line.trim();
  if (trimmed === "") return no("the command is empty");
  if (testCommand !== undefined && testCommand.trim() !== "" && trimmed === testCommand.trim()) return OK;
  // Merging or discarding error output changes nothing, and is too common to refuse.
  const cleaned = trimmed.replace(/(^|\s)2>&1(?=\s|$)/g, "$1").replace(/(^|\s)2>\s?\/dev\/null(?=\s|$)/g, "$1");
  const commands = split(cleaned);
  if (typeof commands === "string") return no(`it uses ${commands}`);
  for (const words of commands) {
    const verdict = checkWords(words);
    if (!verdict.ok) return verdict;
  }
  return OK;
}

/** Tools a locked turn may use without a further check: they read, search or look things up. */
const LOCKED_TOOLS = new Set([
  ...["Read", "Glob", "Grep", "LS", "WebSearch", "WebFetch", "Task", "Agent", "Skill", "ToolSearch"],
  // Claude Code's own bookkeeping: its to-do list, and watching or stopping what it started itself.
  ...["TodoWrite", "TaskCreate", "TaskGet", "TaskList", "TaskUpdate", "TaskOutput", "TaskStop", "BashOutput", "KillShell"],
]);

/** Tools removed from a locked turn altogether, so the model does not reach for them. */
export const LOCK_REMOVED_TOOLS = ["Edit", "Write", "NotebookEdit"];

/** The daemon's answer to a tool request made during a locked turn. */
export function lockDecision(toolName: string, input: Record<string, unknown>, testCommand?: string): Verdict {
  if (toolName === "Bash") {
    if (typeof input.command !== "string") return no("Refused: the command could not be read.");
    const verdict = checkCommand(input.command, testCommand);
    return verdict.ok ? OK : no(`Refused: ${verdict.reason}. While locked, only read-only commands run; nothing can be changed or sent.`);
  }
  if (LOCKED_TOOLS.has(toolName)) return OK;
  return no(`Refused: ${toolName} is not available while locked. Nothing can be changed or sent until the lock is off.`);
}

/**
 * The answer of the hook that runs before every tool call of a locked turn. A hook is asked
 * before Claude Code looks at its permission rules, so nothing a settings file allows, and
 * nothing Claude Code would approve by itself, gets past the lock. An empty answer lets the
 * call go on to the usual permission check.
 */
export function lockHookAnswer(toolName: string, input: unknown, testCommand?: string): { hookSpecificOutput?: { hookEventName: "PreToolUse"; permissionDecision: "deny"; permissionDecisionReason: string } } {
  const verdict = lockDecision(toolName, typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {}, testCommand);
  return verdict.ok ? {} : { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: verdict.reason } };
}
