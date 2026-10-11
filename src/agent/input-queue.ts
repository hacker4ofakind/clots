/**
 * The stream of user messages fed to a running turn. Once closed it accepts
 * nothing more: the process is on its way out, and a message pushed then
 * would never be read.
 */
export class InputQueue<T> implements AsyncIterable<T> {
  private items: T[];
  private closed = false;
  private wake?: () => void;

  constructor(initial: T[] = []) {
    this.items = [...initial];
  }

  /** Returns false when the queue has been closed and the item was not accepted. */
  push(item: T): boolean {
    if (this.closed) return false;
    this.items.push(item);
    this.wake?.();
    return true;
  }

  close(): void {
    this.closed = true;
    this.wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T, void> {
    while (true) {
      while (this.items.length > 0) yield this.items.shift()!;
      if (this.closed) return;
      await new Promise<void>((resolve) => (this.wake = resolve));
    }
  }
}
