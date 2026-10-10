/**
 * A turn starts with one prompt. Messages pushed while it runs may be folded
 * into the same result or get a result of their own, so after a result that
 * follows a push we wait for more activity before ending the turn.
 */
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
