const ACTIVITY = ["assistant", "user", "stream_event"];

/**
 * Whether a message shows the model working. Only these may postpone the end
 * of a turn: the SDK also sends bookkeeping (task summaries, rate-limit
 * events) after a result, and those must not keep a finished turn open.
 */
export function isTurnActivity(type: string): boolean {
  return ACTIVITY.includes(type);
}

/** A result with the success subtype can still carry an API error. */
export function isSuccessfulResult(result: { subtype: string; is_error: boolean }): boolean {
  return result.subtype === "success" && !result.is_error;
}

/**
 * Decides what to do when a result arrives. A turn starts with one prompt;
 * messages pushed while it runs are either folded into it or queued as turns
 * of their own.
 *
 * - "wait": the SDK reports queued turns, so another result will follow.
 * - "grace": something was pushed and the SDK reports no queue. The push was
 *   either folded into this result or has not reached the queue yet, so allow
 *   a short time for a new turn to begin.
 * - "finish": nothing is outstanding.
 */
export class TurnTracker {
  private pushedSinceResult = 0;

  onPush(): void {
    this.pushedSinceResult += 1;
  }

  /** queuedTurnCount is the result's queued_turn_count; older producers omit it. */
  onResult(queuedTurnCount?: number): "finish" | "wait" | "grace" {
    const pushed = this.pushedSinceResult;
    this.pushedSinceResult = 0;
    if (queuedTurnCount !== undefined && queuedTurnCount > 0) return "wait";
    return pushed > 0 ? "grace" : "finish";
  }
}
