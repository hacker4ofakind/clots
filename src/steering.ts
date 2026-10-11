import { STEERED_PREFIX } from "./agent/prompts.js";
import type { ChatAdapter, InboundMessage } from "./chat/adapter.js";
import { askChannelName } from "./chat/names.js";
import { formatEvent } from "./events/format.js";
import { ASK_REPLIES, ASK_RETRY, matchReply } from "./events/reply.js";
import type { ClotEvent, ReplyOutcome } from "./events/types.js";
import { fallbackExplanation, type Explainer } from "./explainer.js";
import type { AskRow, Store } from "./store.js";

/** The part of a Clot that steering needs. */
export interface ClotPort {
  isBusy(): boolean;
  steerEvent(text: string): boolean;
  queueEvent(event: ClotEvent, notice: string, kick?: boolean): Promise<void>;
}

export interface SteeringDeps {
  store: Store;
  chat: ChatAdapter;
  explainer: Explainer;
  userId: string;
  timeZone: string;
  clots: Map<string, ClotPort>;
}

/**
 * Asks the user about an event that bears on the turn that is running, in a
 * temporary channel, and carries out the answer: feed it into the turn, queue
 * it, or drop it. Nothing is fed into a turn without the user's yes.
 */
export class Steering {
  constructor(private d: SteeringDeps) {}

  /** Opens the question. Returns false when it could not be asked at all; the caller then queues the event. */
  async ask(clotName: string, event: ClotEvent, message: string): Promise<boolean> {
    const { store, chat } = this.d;
    const clot = store.getClot(clotName);
    const port = this.d.clots.get(clotName);
    if (!clot || !port) return false;

    let channelId: string;
    try {
      const names = await chat.listChannelNames(clot.categoryId);
      channelId = await chat.createChannel(clot.categoryId, askChannelName(clotName, names));
    } catch {
      return false;
    }
    const ask: AskRow = { eventId: event.id, clot: clotName, channelId };
    store.createAsk(ask);
    store.setEventStatus(event.id, "asking");

    const why = await this.d.explainer.explain({ event, message, tail: store.tail(clotName, 4) }).catch(() => fallbackExplanation(event, message));
    try {
      await chat.post(channelId, `${chat.mention(this.d.userId)} ${why}\n\n${ASK_REPLIES}`);
    } catch {
      await this.resolve(ask, "queue", true);
      return true;
    }
    // The turn may have ended while the question was being written.
    if (!port.isBusy() && store.askByChannel(channelId)) await this.resolve(ask, "queue", true);
    return true;
  }

  /** Handles a message in a question's channel. Returns false when the channel is not one, so the message belongs elsewhere. */
  async onReply(m: InboundMessage): Promise<boolean> {
    const ask = this.d.store.askByChannel(m.channelId);
    if (!ask) return false;
    if (m.authorId !== this.d.userId) return true;
    const outcome = matchReply(m.text);
    if (outcome === undefined) {
      await this.d.chat.post(m.channelId, ASK_RETRY).catch(() => undefined);
      return true;
    }
    await this.resolve(ask, outcome, true);
    return true;
  }

  /**
   * Closes every open question for a Clot as "queue". Called when no turn is
   * running any more: "relevant right now" has stopped being true. The Clot
   * calls this from its own drain, so the queued events are not kicked.
   */
  async lapse(clotName: string): Promise<void> {
    for (const ask of this.d.store.openAsks(clotName)) await this.resolve(ask, "queue", false);
  }

  private async resolve(ask: AskRow, outcome: ReplyOutcome, kick: boolean): Promise<void> {
    const { store, chat } = this.d;
    // Closed first, and only whoever closed it goes on: a second reply, or a lapse working from
    // a list it read a moment ago, must not undo what the user has already decided.
    if (!store.deleteAsk(ask.eventId)) return;
    const event = store.getEvent(ask.eventId);
    const port = this.d.clots.get(ask.clot);
    if (event && port) {
      const notice = event.triageMessage ?? event.title;
      if (outcome === "drop") {
        store.setEventStatus(event.id, "dropped", "declined by the user");
      } else if (outcome === "steer" && port.steerEvent(`${STEERED_PREFIX}\n${formatEvent(event, this.d.timeZone)}`)) {
        store.setEventStatus(event.id, "steered");
        const session = store.activeSession(ask.clot);
        if (session) await chat.post(session.channelId, `${notice} <${event.url}> (handling it now, as you approved)`).catch(() => undefined);
      } else {
        // "After", or a yes that came too late: the turn has ended or no longer accepts input.
        await port.queueEvent(event, notice, kick);
      }
    }
    await chat.deleteChannel(ask.channelId).catch(() => undefined);
  }
}
