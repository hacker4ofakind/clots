import type { AskKind, Asks } from "../asks.js";
import { choiceChannelName } from "../chat/names.js";
import { matchChoice } from "../events/reply.js";

export interface ChoicePayload {
  question: string;
  options: [string, string];
  /** The Clot's own pick, taken when the user does not answer in time. */
  pick: 1 | 2;
  /** Put in a turn an outsider's text started: every turn it leads to is tainted too. */
  outsider: boolean;
}

/** How many choices a Clot may have open at once. */
export const MAX_CHOICES = 3;

/**
 * Two ways of doing something, put to the user with the Clot's pick. An exact answer decides it;
 * any other text goes to the main session as the user's own words; with no answer by the deadline,
 * the Clot goes with its pick in a turn that carries none of the user's authority.
 */
export function choiceKind(d: { timeoutMinutes: number }): AskKind<ChoicePayload> {
  return {
    kind: "choice",
    channelName: choiceChannelName,
    render: (_clot, p, { deadline }) =>
      `asks: ${p.question}\n\n**1.** ${p.options[0]}\n**2.** ${p.options[1]}\n\nMy pick: ${p.pick}. Answer 1 or 2, "your pick", or write what you want instead. I'll go with ${p.pick} at <t:${Math.floor((deadline ?? 0) / 1000)}:t> if I don't hear from you.`,
    texts: {
      filed: `Put to the user in a separate channel. Do not wait for the answer: end your turn, or carry on with other work. Their answer comes to you as a message from them; with none in ${d.timeoutMinutes} minutes, a turn of your own tells you to go with your pick.`,
      already: "This choice is already with the user.",
      full: (n) => `Not asked: ${n} choices already wait for the user. Decide this one yourself, or put it in your reply.`,
      notAsked: (reason) => `The user could not be asked just now${reason ? ` (${reason})` : ""}. Decide yourself, or put the options in your reply.`,
    },

    async onReply(ask, text, io) {
      const p = ask.payload;
      const answer = matchChoice(text);
      // Both are the user's own words, so both are turns of the user's own.
      if (answer !== undefined) {
        const n = answer === "pick" ? p.pick : answer;
        await io.close(null, `You picked ${n} for "${p.question}": ${p.options[n - 1]}`, { inbox: { id: `choice-answer:${ask.id}`, text: `[Your choice "${p.question}": the user picked ${n}: ${p.options[n - 1]}.]`, kind: "message", outsider: p.outsider } });
        return;
      }
      await io.close(null, null, {
        inbox: { id: `choice-answer:${ask.id}`, text: `[The user answered your choice "${p.question}" (1. ${p.options[0]} 2. ${p.options[1]}; your pick was ${p.pick}):]\n${text}`, kind: "message", outsider: p.outsider },
      });
    },

    async onDeadline(ask, io) {
      const p = ask.payload;
      await io.close(null, null, {
        inbox: {
          id: `choice:${ask.id}`,
          text: `[The user did not answer your choice "${p.question}" within ${d.timeoutMinutes} minutes and appears to be busy. Go with your pick, ${p.pick}: ${p.options[p.pick - 1]}. Tell the user in one line which you took, and that a reply in this channel switches it. Carry on with the pick; do not start a second worker for the same work.]`,
          kind: "choice",
          outsider: p.outsider,
        },
      });
    },
  };
}

/** Opens a choice, decided by the Clot's pick after the timeout. Returns what the tool tells the Clot. */
export function askChoice(asks: Asks, kind: AskKind<ChoicePayload>, o: { now: () => number; timeoutMinutes: number }, clot: string, a: { question: string; options: [string, string]; pick: 1 | 2 }, outsider: boolean): Promise<string> {
  return asks.open(kind, clot, { ...a, outsider }, { summary: `Choice: ${a.question}`, dedupe: a.question, max: MAX_CHOICES, deadline: o.now() + o.timeoutMinutes * 60_000, outsider });
}
