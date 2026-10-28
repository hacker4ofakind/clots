import { query, type Options, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Effort, LimitInfo, TurnActivity } from "../types.js";
import { ActivityCollector } from "./activity.js";
import type { DaemonTools, WorkerTools } from "../tools.js";
import { DAEMON_TOOL_SERVER, LOCK_REMOVED_TOOLS, lockDecision, lockHookAnswer } from "./command-check.js";
import { toolServer, WORKER_TOOL_PREFIX, WORKER_TOOL_SERVER, workerToolServer } from "./tool-server.js";
import { containerName, makeSpawn, sessionExists } from "./container.js";
import { CLOT_SYSTEM_PROMPT, PR_ATTRIBUTION } from "./prompts.js";
import { InputQueue } from "./input-queue.js";
import { isSuccessfulResult, isTurnActivity, TurnTracker } from "./turn-tracker.js";
import { parseRateLimit } from "./usage.js";
import { guardCommand, type GuardContext } from "./worker-guard.js";

interface TurnBase {
  /** Set to continue an existing session. */
  resume?: string;
  /** Set to start a new session with this ID. Exactly one of resume and newSessionId is set. */
  newSessionId?: string;
  prompt: string;
  effort: Effort;
  /** The full model ID. */
  model: string;
  /** Overrides the runner's directory. */
  cwd?: string;
  /** Overrides what the runner adds to Claude Code's own system prompt. */
  systemPrompt?: string;
  onText: (text: string) => void;
  /** Called for each tool call the session makes itself (not its subagents), with a short name for it. */
  onStep?: (step: string) => void;
}

/** A main session turn, always under the lock: it reads and looks things up, and changes nothing but its memory. */
export interface MainTurnRequest extends TurnBase {
  role: "main";
  /** The daemon's tools for this turn. They run in the daemon, and are made for the turn so that they know what kind it is. */
  tools?: DaemonTools;
}

/** A worker's turn: it works freely in its own directory, behind the worker guard. */
export interface WorkerTurnRequest extends TurnBase {
  role: "worker";
  cwd: string;
  systemPrompt: string;
  guard: GuardContext;
  workerTools: WorkerTools;
  onStep: (step: string) => void;
  /** Extra environment for the session: the worker's own PORT. */
  env?: Record<string, string>;
}

export type TurnRequest = MainTurnRequest | WorkerTurnRequest;

export interface TurnResult {
  sessionId: string;
  contextPercent: number;
  ok: boolean;
  limit?: LimitInfo;
  activity?: TurnActivity;
  /** Whether any model response came back. A turn that failed before one did is worth trying again. */
  responded?: boolean;
}

export interface TurnHandle {
  /**
   * Feeds a message into the running turn. Returns false when the turn no longer accepts input; the message was then not delivered.
   * An effort, when given, applies from the model's next step.
   */
  push(text: string, effort?: Effort): boolean;
  /** Ends the turn: closes its input and interrupts the session. `done` still resolves. */
  stop(): void;
  done: Promise<TurnResult>;
}

export interface AgentRunner {
  startTurn(req: TurnRequest): TurnHandle;
}

const CWD = "/workspace/repo";
const MAX_STEP = 120;

function userMessage(text: string): SDKUserMessage {
  return { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null };
}

/** A word that can only be a program's name: no URL, path, assignment or value. */
const PLAIN_WORD = /^[a-z][a-z0-9._-]{0,39}$/i;

const PACKAGE_MANAGER = ["test", "run", "install", "ci", "build", "exec", "start", "lint", "add"];
/** The subcommands a step may name, by program. Any other second word could be an argument, and a secret. */
const SUBCOMMANDS: Record<string, Set<string>> = {
  npm: new Set(PACKAGE_MANAGER),
  pnpm: new Set(PACKAGE_MANAGER),
  yarn: new Set(PACKAGE_MANAGER),
  bun: new Set(PACKAGE_MANAGER),
  git: new Set(["status", "diff", "log", "show", "add", "commit", "push", "fetch", "pull", "checkout", "switch", "branch", "rebase", "merge", "stash", "reset", "restore", "worktree"]),
  gh: new Set(["pr", "issue", "run", "repo", "api", "auth"]),
  docker: new Set(["build", "run", "compose", "ps", "exec", "logs"]),
  cargo: new Set(["build", "test", "run", "check", "clippy", "fmt"]),
  go: new Set(["build", "test", "run", "vet", "mod"]),
};

/**
 * A short name for a tool call, shown to the user as a worker's latest step. For Bash it is the
 * program's name, and its subcommand when the program is a known one and the word one of its
 * subcommands, nothing else: a command line can hold a connection string or a token, in an
 * assignment, a URL or any argument.
 */
export function stepOf(block: { name: string; input: unknown }): string {
  if (block.name !== "Bash") return block.name;
  const command = typeof (block.input as { command?: unknown })?.command === "string" ? (block.input as { command: string }).command : "";
  const words = (command.split(/\r?\n/)[0] ?? "").trim().split(/\s+/).filter((word) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word));
  const program = (words[0] ?? "").split("/").pop() ?? "";
  if (!PLAIN_WORD.test(program)) return "Bash";
  return SUBCOMMANDS[program]?.has(words[1] ?? "") ? `${program} ${words[1]}`.slice(0, MAX_STEP) : program;
}

type HookAnswer = { hookSpecificOutput?: { hookEventName: "PreToolUse"; permissionDecision: "deny"; permissionDecisionReason: string } };

/**
 * The answer of the hook that runs before every tool call of a worker. Shell commands go to the
 * guard. MCP tools other than the worker's own are refused: the container's login and copied setup
 * can bring connectors (mail, Slack) that would send without any check.
 */
export function workerHookAnswer(toolName: string, input: unknown, guard: GuardContext): HookAnswer {
  const deny = (reason: string): HookAnswer => ({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } });
  if (toolName === "Bash") {
    const command = (input as { command?: unknown } | null)?.command;
    if (typeof command !== "string") return deny("Refused: the command could not be read.");
    const verdict = guardCommand(command, guard);
    return verdict.ok ? {} : deny(verdict.reason);
  }
  if (toolName.startsWith("mcp__") && !toolName.startsWith(WORKER_TOOL_PREFIX)) return deny(`Refused: ${toolName} is not available to a worker. Say what is needed in your report.`);
  return {};
}

export interface RunnerOptions {
  clot: string;
  env: Record<string, string>;
  graceMs?: number;
  /** The project's test command, which a locked turn may run. */
  testCommand?: string;
  /** Where turns start in the container. A Clot with a repository starts in its clone. */
  cwd?: string;
  /** What is added to Claude Code's own system prompt. */
  systemPrompt?: string;
}

/** The SDK options for a turn, apart from its input and session ID. */
export function turnOptions(req: TurnRequest, o: RunnerOptions): Options {
  const cwd = req.cwd ?? o.cwd ?? CWD;
  const container = containerName(o.clot);
  const common = {
    model: req.model,
    effort: req.effort,
    cwd,
    allowDangerouslySkipPermissions: true,
    systemPrompt: { type: "preset" as const, preset: "claude_code" as const, append: req.systemPrompt ?? o.systemPrompt ?? CLOT_SYSTEM_PROMPT },
  };
  if (req.role === "worker") {
    const env = { ...o.env, ...req.env, CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" };
    return {
      ...common,
      mcpServers: { [WORKER_TOOL_SERVER]: workerToolServer(req.workerTools) },
      permissionMode: "bypassPermissions",
      // Workers keep no memory of their own: the main session's is the one it trusts.
      settings: { attribution: { pr: PR_ATTRIBUTION }, autoMemoryEnabled: false } as Options["settings"],
      // AskUserQuestion cannot reach chat. A worker asks the main session with ask_main.
      disallowedTools: ["AskUserQuestion"],
      hooks: { PreToolUse: [{ hooks: [async (hook) => (hook.hook_event_name === "PreToolUse" ? workerHookAnswer(hook.tool_name, hook.tool_input, req.guard) : {})] }] },
      spawnClaudeCodeProcess: makeSpawn({ container, cwd, env }),
    };
  }
  return {
    ...common,
    ...(req.tools ? { mcpServers: { [DAEMON_TOOL_SERVER]: toolServer(req.tools) } } : {}),
    // The lock has two parts. The hook below is asked before every tool call, ahead of any
    // permission rule, and refuses what the lock does not approve: an allow rule in a settings
    // file cannot get past it. What it lets through goes on to the usual check, where in the
    // default mode everything that is not plainly read-only is put to the callback, which gives
    // the same answer. Plan mode is not used, because it never consults the callback.
    permissionMode: "default",
    settings: { attribution: { pr: PR_ATTRIBUTION } },
    // AskUserQuestion: its prompts cannot be shown in chat; the Clot asks in plain text instead.
    disallowedTools: ["AskUserQuestion", ...LOCK_REMOVED_TOOLS],
    hooks: { PreToolUse: [{ hooks: [async (hook) => (hook.hook_event_name === "PreToolUse" ? lockHookAnswer(hook.tool_name, hook.tool_input, o.testCommand) : {})] }] },
    canUseTool: async (toolName: string, toolInput: Record<string, unknown>) => {
      const verdict = lockDecision(toolName, toolInput, o.testCommand);
      return verdict.ok ? { behavior: "allow" as const, updatedInput: toolInput } : { behavior: "deny" as const, message: verdict.reason };
    },
    spawnClaudeCodeProcess: makeSpawn({ container, cwd, env: o.env }),
  };
}

export class SdkRunner implements AgentRunner {
  private graceMs: number;

  constructor(private o: RunnerOptions) {
    this.graceMs = o.graceMs ?? 15_000;
  }

  startTurn(req: TurnRequest): TurnHandle {
    const input = new InputQueue<SDKUserMessage>([userMessage(req.prompt)]);
    const finish = () => input.close();

    // A first turn cut off by a daemon restart leaves its transcript behind, and
    // Claude Code refuses to start a session under an ID that already has one.
    // Workers checks that itself, without blocking, before it starts a worker's turn.
    const container = containerName(this.o.clot);
    const cwd = req.cwd ?? this.o.cwd ?? CWD;
    const resume = req.resume ?? (req.role === "main" && req.newSessionId && sessionExists(container, req.newSessionId) ? req.newSessionId : undefined);

    const session = query({
      prompt: input,
      options: { ...turnOptions(req, this.o), ...(resume ? { resume } : { sessionId: req.newSessionId }) },
    });

    const tracker = new TurnTracker();
    const collector = new ActivityCollector(cwd);
    const done = (async (): Promise<TurnResult> => {
      const result: TurnResult = { sessionId: req.resume ?? req.newSessionId ?? "", contextPercent: 0, ok: false, responded: false };
      let grace: NodeJS.Timeout | undefined;
      try {
        for await (const message of session) {
          if (grace && isTurnActivity(message.type)) {
            clearTimeout(grace);
            grace = undefined;
          }
          collector.observe(message);
          const limit = parseRateLimit(message);
          if (limit?.status === "rejected") {
            result.limit = { resetsAt: limit.resetsAt ?? Math.floor(Date.now() / 1000) + 5 * 3600 };
          }
          if (message.type === "assistant") result.responded = true;
          if (message.type === "assistant" && message.parent_tool_use_id === null) {
            for (const block of message.message.content) {
              if (block.type === "text" && block.text.trim() !== "") req.onText(block.text);
              if (block.type === "tool_use") req.onStep?.(stepOf(block));
            }
          }
          if (message.type === "result") {
            result.sessionId = message.session_id;
            result.ok = isSuccessfulResult(message);
            try {
              result.contextPercent = (await session.getContextUsage()).percentage;
            } catch {
              // Leave the previous value; rollover is retried after the next turn.
            }
            if (grace) clearTimeout(grace);
            grace = undefined;
            const next = tracker.onResult(message.queued_turn_count);
            if (next === "finish") finish();
            else if (next === "grace") grace = setTimeout(finish, this.graceMs);
            // "wait": the SDK has queued turns, so another result is on its way.
          }
        }
      } catch {
        result.ok = false;
      } finally {
        if (grace) clearTimeout(grace);
        finish();
      }
      result.activity = collector.activity();
      return result;
    })();

    return {
      push: (text, effort) => {
        if (!input.push(userMessage(text))) return false;
        tracker.onPush();
        if (effort) void session.applyFlagSettings({ effortLevel: effort }).catch(() => undefined);
        return true;
      },
      stop: () => {
        finish();
        void session.interrupt().catch(() => undefined);
      },
      done,
    };
  }
}
