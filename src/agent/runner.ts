import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Effort, LimitInfo, TurnActivity } from "../types.js";
import { ActivityCollector } from "./activity.js";
import type { DaemonTools } from "../tools.js";
import { DAEMON_TOOL_SERVER, LOCK_REMOVED_TOOLS, lockDecision, lockHookAnswer } from "./command-check.js";
import { toolServer } from "./tool-server.js";
import { containerName, makeSpawn, sessionExists } from "./container.js";
import { CLOT_SYSTEM_PROMPT, PR_ATTRIBUTION } from "./prompts.js";
import { InputQueue } from "./input-queue.js";
import { isSuccessfulResult, isTurnActivity, TurnTracker } from "./turn-tracker.js";
import { parseRateLimit } from "./usage.js";

export interface TurnRequest {
  /** Set to continue an existing session. */
  resume?: string;
  /** Set to start a new session with this ID. Exactly one of resume and newSessionId is set. */
  newSessionId?: string;
  prompt: string;
  effort: Effort;
  /** Runs the turn under the lock: it can read and look things up, and can change nothing. */
  locked: boolean;
  /** The daemon's tools for this turn. They run in the daemon, and are made for the turn so that they know what kind it is. */
  tools?: DaemonTools;
  onText: (text: string) => void;
}

export interface TurnResult {
  sessionId: string;
  contextPercent: number;
  ok: boolean;
  limit?: LimitInfo;
  activity?: TurnActivity;
}

export interface TurnHandle {
  /**
   * Feeds a message into the running turn. Returns false when the turn no longer accepts input; the message was then not delivered.
   * An effort, when given, applies from the model's next step.
   */
  push(text: string, effort?: Effort): boolean;
  done: Promise<TurnResult>;
}

export interface AgentRunner {
  startTurn(req: TurnRequest): TurnHandle;
}

const CWD = "/workspace/repo";

function userMessage(text: string): SDKUserMessage {
  return { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null };
}

export class SdkRunner implements AgentRunner {
  private graceMs: number;

  constructor(
    private o: {
      clot: string;
      env: Record<string, string>;
      graceMs?: number;
      /** The project's test command, which a locked turn may run. */
      testCommand?: string;
      /** Where turns start in the container. A Clot with a repository starts in its clone. */
      cwd?: string;
      /** What is added to Claude Code's own system prompt. */
      systemPrompt?: string;
    },
  ) {
    this.graceMs = o.graceMs ?? 15_000;
  }

  startTurn(req: TurnRequest): TurnHandle {
    const input = new InputQueue<SDKUserMessage>([userMessage(req.prompt)]);
    const finish = () => input.close();

    // A first turn cut off by a daemon restart leaves its transcript behind, and
    // Claude Code refuses to start a session under an ID that already has one.
    const container = containerName(this.o.clot);
    const cwd = this.o.cwd ?? CWD;
    const resume = req.resume ?? (req.newSessionId && sessionExists(container, req.newSessionId) ? req.newSessionId : undefined);

    const session = query({
      prompt: input,
      options: {
        model: "claude-opus-5-5",
        effort: req.effort,
        ...(resume ? { resume } : { sessionId: req.newSessionId }),
        cwd,
        ...(req.tools ? { mcpServers: { [DAEMON_TOOL_SERVER]: toolServer(req.tools) } } : {}),
        // The lock has two parts. The hook below is asked before every tool call, ahead of any
        // permission rule, and refuses what the lock does not approve: an allow rule in a settings
        // file cannot get past it. What it lets through goes on to the usual check, where in the
        // default mode everything that is not plainly read-only is put to the callback, which gives
        // the same answer. Plan mode is not used, because it never consults the callback.
        permissionMode: req.locked ? "default" : "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        settings: { attribution: { pr: PR_ATTRIBUTION } },
        // AskUserQuestion: its prompts cannot be shown in chat; the Clot asks in plain text instead.
        disallowedTools: req.locked ? ["AskUserQuestion", ...LOCK_REMOVED_TOOLS] : ["AskUserQuestion"],
        ...(req.locked
          ? {
              hooks: {
                PreToolUse: [
                  {
                    hooks: [async (hook) => (hook.hook_event_name === "PreToolUse" ? lockHookAnswer(hook.tool_name, hook.tool_input, this.o.testCommand) : {})],
                  },
                ],
              },
              canUseTool: async (toolName: string, toolInput: Record<string, unknown>) => {
                const verdict = lockDecision(toolName, toolInput, this.o.testCommand);
                return verdict.ok ? { behavior: "allow" as const, updatedInput: toolInput } : { behavior: "deny" as const, message: verdict.reason };
              },
            }
          : {}),
        systemPrompt: { type: "preset", preset: "claude_code", append: this.o.systemPrompt ?? CLOT_SYSTEM_PROMPT },
        spawnClaudeCodeProcess: makeSpawn({ container, cwd, env: this.o.env }),
      },
    });

    const tracker = new TurnTracker();
    const collector = new ActivityCollector(cwd);
    const done = (async (): Promise<TurnResult> => {
      const result: TurnResult = { sessionId: req.resume ?? req.newSessionId ?? "", contextPercent: 0, ok: false };
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
          if (message.type === "assistant" && message.parent_tool_use_id === null) {
            for (const block of message.message.content) {
              if (block.type === "text" && block.text.trim() !== "") req.onText(block.text);
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
      done,
    };
  }
}
