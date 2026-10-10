/**
 * A turn starts with one prompt. Messages pushed while it runs may be folded
 * into the same result or get a result of their own, so after a result that
 * follows a push we wait for more activity before ending the turn.
 */
const ACTIVITY = ["assistant", "user", "stream_event"];

/**
 * Whether a message shows the model working. Only these may postpone the end
 * of a turn: the SDK also sends bookkeeping (task summaries, rate-limit
 * events) after a result, and those must not keep a finished turn open.
 */
export function isTurnActivity(type: string): boolean {
  return ACTIVITY.includes(type);
}

export class TurnTracker {
  private pushedSinceResult = 0;

  onPush(): void {
    this.pushedSinceResult += 1;
  }

  onResult(): "finish" | "wait" {
    if (this.pushedSinceResult === 0) return "finish";
    this.pushedSinceResult = 0;
    return "wait";
  }
}
