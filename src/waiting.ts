import { isUnknown, type ChatAdapter } from "./chat/adapter.js";
import type { AskRow, Store } from "./store.js";

export const WAITING_CHANNEL = "clots-waiting";
const CHANNEL_KEY = "waiting.channel";
const MESSAGE_KEY = "waiting.message";
const TEXT_KEY = "waiting.text";

const DEBOUNCE_MS = 2_000;
/** A failed edit is tried again after these waits, then left for the next change. */
const RETRY_MS = [5_000, 30_000, 120_000];
const MAX_LENGTH = 2_000;

export interface WaitingDeps {
  store: Store;
  chat: ChatAdapter;
  /** A one-off timer; returns its cancel. */
  after: (ms: number, fn: () => void) => () => void;
}

/** One line per open ask, oldest first, under the heading; past Discord's 2,000 characters the list ends with how many more there are. */
export function renderWaiting(asks: AskRow[], link: (channelId: string) => string): string {
  const shown = asks.filter((ask) => ask.state !== "posting");
  if (shown.length === 0) return "Nothing is waiting for you.";
  const lines = shown.map((ask) => `• ${ask.clot}: ${ask.summary} → ${link(ask.channelId)}${ask.kind === "choice" && ask.deadline !== null ? ` (decides at <t:${Math.floor(ask.deadline / 1000)}:t>)` : ""}`);
  const out = ["**Waiting for you**"];
  for (const [i, line] of lines.entries()) {
    const rest = lines.length - i - 1;
    const tail = rest === 0 ? "" : `\n…and ${rest} more`;
    if ([...out, line].join("\n").length + tail.length > MAX_LENGTH) {
      out.push(`…and ${lines.length - i} more`);
      break;
    }
    out.push(line);
  }
  return out.join("\n");
}

/**
 * The pinned message in clots-waiting that lists everything waiting for the user. It is edited only
 * when the list changes, a little after the change, one edit at a time, and it pings no one. When
 * Discord says the message or the channel is gone, a new one is posted and pinned.
 */
export class Waiting {
  private debounce?: () => void;
  private retry?: () => void;
  private chain: Promise<unknown> = Promise.resolve();
  /** The stored message is known to be pinned. */
  private pinned = false;

  constructor(private d: WaitingDeps) {}

  /** Whether a channel is clots-waiting: nothing posted there reaches a Clot. */
  isChannel(channelId: string): boolean {
    return this.d.store.getState(CHANNEL_KEY) === channelId;
  }

  /** Makes sure the channel and its message exist and are current. Called once at startup. */
  init(): Promise<void> {
    return this.serial(() => this.sync(0));
  }

  /** Brings the message up to date a little later. Several changes close together make one edit. */
  refresh(): void {
    if (this.debounce) return;
    this.debounce = this.d.after(DEBOUNCE_MS, () => {
      this.debounce = undefined;
      void this.serial(() => this.sync(0)).catch((error) => console.error("[waiting] updating clots-waiting failed:", error));
    });
  }

  private serial(step: () => Promise<void>): Promise<void> {
    const result = this.chain.then(step);
    this.chain = result.catch(() => undefined);
    return result;
  }

  private async sync(attempt: number): Promise<void> {
    await this.syncText(attempt);
    await this.ensurePinned();
  }

  /**
   * Pins the stored message unless it is pinned already. Checked at startup and again after each
   * change until a check succeeds, so a pin that failed before the bot could pin is made later. Best-effort.
   */
  private async ensurePinned(): Promise<void> {
    const { store, chat } = this.d;
    const channel = store.getState(CHANNEL_KEY);
    const message = store.getState(MESSAGE_KEY);
    if (this.pinned || channel === undefined || message === undefined) return;
    try {
      if (!(await chat.isPinned(channel, message))) await chat.pin(channel, message);
      this.pinned = true;
    } catch (error) {
      console.warn("[waiting] pinning the clots-waiting message failed; it is tried again at the next change:", error);
    }
  }

  private async syncText(attempt: number): Promise<void> {
    const { store, chat } = this.d;
    this.retry?.();
    this.retry = undefined;
    const text = renderWaiting(store.openAsks(), (id) => chat.channelLink(id));
    const channel = store.getState(CHANNEL_KEY);
    const message = store.getState(MESSAGE_KEY);
    if (channel !== undefined && message !== undefined) {
      if (text === store.getState(TEXT_KEY)) return;
      try {
        await chat.editMessage(channel, message, text);
        store.setState(TEXT_KEY, text);
        return;
      } catch (error) {
        if (!isUnknown(error)) {
          // Discord is unreachable or slow: the same message is tried again, and nothing new is posted.
          if (attempt < RETRY_MS.length) this.retry = this.d.after(RETRY_MS[attempt], () => void this.serial(() => this.sync(attempt + 1)).catch(() => undefined));
          return;
        }
      }
    }
    await this.post(text);
  }

  /** Posts a new message in the channel, made when it is missing, stores where it is at once, and pins it. */
  private async post(text: string): Promise<void> {
    const { store, chat } = this.d;
    let channel = await chat.ensureTopChannel(WAITING_CHANNEL);
    let message: string;
    try {
      message = await chat.postMessage(channel, text);
    } catch (error) {
      if (!isUnknown(error)) throw error;
      // The stored channel was deleted meanwhile: look it up again by name.
      channel = await chat.ensureTopChannel(WAITING_CHANNEL);
      message = await chat.postMessage(channel, text);
    }
    store.setState(CHANNEL_KEY, channel);
    store.setState(MESSAGE_KEY, message);
    store.setState(TEXT_KEY, text);
    // A new message is not pinned yet: ensurePinned pins it.
    this.pinned = false;
  }
}
