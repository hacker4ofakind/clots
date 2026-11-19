import os from "node:os";
import { query, type Options } from "@anthropic-ai/claude-agent-sdk";

export interface StructuredCall {
  prompt: string;
  model: string;
  effort: NonNullable<Options["effort"]>;
  systemPrompt: string;
  schema: Record<string, unknown>;
}

/** Called with what a call cost in USD, and the Clot it is for (null when it is the daemon's). */
export type OnCost = (usd: number, clot: string | null) => void;

/**
 * A one-shot model call without tools, answering with JSON that fits a schema. Triage, the router and
 * the routing call all run this. `output` is the structured answer of a successful result; `costUsd` is
 * the result's own cost, success or not. Never throws: a failed call answers nothing.
 */
export async function structuredQuery(call: StructuredCall): Promise<{ output?: unknown; costUsd?: number }> {
  try {
    const run = query({
      prompt: call.prompt,
      options: {
        model: call.model,
        effort: call.effort,
        cwd: os.tmpdir(),
        systemPrompt: call.systemPrompt,
        settingSources: [],
        strictMcpConfig: true,
        tools: [],
        maxTurns: 3,
        outputFormat: { type: "json_schema", schema: call.schema },
      },
    });
    for await (const message of run) {
      if (message.type !== "result") continue;
      const costUsd = typeof message.total_cost_usd === "number" ? message.total_cost_usd : undefined;
      return message.subtype === "success" ? { output: message.structured_output, costUsd } : { costUsd };
    }
  } catch {
    // The caller falls back to its default.
  }
  return {};
}
