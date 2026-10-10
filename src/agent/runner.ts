import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Effort, LimitInfo, TurnActivity } from "../types.js";
import { ActivityCollector } from "./activity.js";
import { containerName, makeSpawn, sessionExists } from "./container.js";
import { CLOT_SYSTEM_PROMPT } from "./prompts.js";
import { isTurnActivity, TurnTracker } from "./turn-tracker.js";
import { parseRateLimit } from "./usage.js";

export interface TurnRequest {
  /** Set to continue an existing session. */
  resume?: string;
  /** Set to start a new session with this ID. Exactly one of resume and newSessionId is set. */
  newSessionId?: string;
  prompt: string;
  effort: Effort;
  planMode: boolean;
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
  push(text: string, effort: Effort): void;
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

  constructor(private o: { clot: string; env: Record<string, string>; graceMs?: number }) {
    this.graceMs = o.graceMs ?? 15_000;
  }

  startTurn(req: TurnRequest): TurnHandle {
    const queue: SDKUserMessage[] = [userMessage(req.prompt)];
    let wake: (() => void) | undefined;
    let closed = false;
    async function* input(): AsyncGenerator<SDKUserMessage, void> {
      while (true) {
        while (queue.length > 0) yield queue.shift()!;
        if (closed) return;
        await new Promise<void>((resolve) => (wake = resolve));
      }
    }
    const finish = () => {
      closed = true;
      wake?.();
    };

    // A first turn cut off by a daemon restart leaves its transcript behind, and
    // Claude Code refuses to start a session under an ID that already has one.
    const container = containerName(this.o.clot);
    const resume = req.resume ?? (req.newSessionId && sessionExists(container, req.newSessionId) ? req.newSessionId : undefined);

    const session = query({
      prompt: input(),
      options: {
        model: "claude-opus-5-5",
        effort: req.effort,
        ...(resume ? { resume } : { sessionId: req.newSessionId }),
        cwd: CWD,
        permissionMode: req.planMode ? "plan" : "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        // Its prompts cannot be shown in chat; the Clot asks in plain text instead.
        disallowedTools: ["AskUserQuestion"],
        // Only consulted in plan mode; bypassPermissions approves before the callback.
        ...(req.planMode
          ? { canUseTool: async () => ({ behavior: "deny" as const, message: "Brainstorm mode: no changes until the user says to start working." }) }
          : {}),
        systemPrompt: { type: "preset", preset: "claude_code", append: CLOT_SYSTEM_PROMPT },
        spawnClaudeCodeProcess: makeSpawn({ container, cwd: CWD, env: this.o.env }),
      },
    });

    const tracker = new TurnTracker();
    const collector = new ActivityCollector(CWD);
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
            result.ok = message.subtype === "success";
            try {
              result.contextPercent = (await session.getContextUsage()).percentage;
            } catch {
              // Leave the previous value; rollover is retried after the next turn.
            }
            if (tracker.onResult() === "finish") finish();
            else grace = setTimeout(finish, this.graceMs);
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
        tracker.onPush();
        void session.applyFlagSettings({ effortLevel: effort }).catch(() => undefined);
        queue.push(userMessage(text));
        wake?.();
      },
      done,
    };
  }
}
