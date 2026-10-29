import type { AskKind } from "../asks.js";
import { memoryChannelName } from "../chat/names.js";
import { matchYesNo } from "../events/reply.js";

export interface MemoryPayload {
  file: string;
  /** The text the user is asked about. */
  text: string;
  /** The text in force now, if the file is in force. */
  approved?: string;
}

export const MEMORY_REPLIES = [
  "Reply with one of:",
  "- `yes`, `sure`, `do that` or `yeah` to give it to every Clot",
  "- `no`, `dont` or `not at all` to decline it; the home Clot's copy is put back",
].join("\n");

const MEMORY_RETRY = `I couldn't match that reply.\n\n${MEMORY_REPLIES}`;

/** Shows a memory as a code block, in which nothing is a mention or formatting. A fence in the text is broken up. */
export const block = (text: string) => `\`\`\`md\n${text.replace(/```/g, "`​``")}\n\`\`\``;

/**
 * A global memory the home Clot wrote in a turn an outsider's text started. Every Clot would
 * trust it from then on, so it is put to the user first: a yes applies it as any other change,
 * a no puts the home Clot's copy back. Anything else repeats the question.
 */
export function memoryKind(d: { resolve(payload: MemoryPayload, answer: "yes" | "no"): Promise<{ note: string | null; line: string }> }): AskKind<MemoryPayload> {
  return {
    kind: "memory",
    channelName: memoryChannelName,
    render: (_clot, p) => {
      const what =
        p.approved === undefined
          ? `wrote a new global memory, \`${p.file}\`, in a turn an outsider's text started:\n\n${block(p.text)}`
          : `changed the global memory \`${p.file}\`, in a turn an outsider's text started. As it is now:\n\n${block(p.approved)}\n\nAs it would be:\n\n${block(p.text)}`;
      return `${what}\n\nIf you say yes, every Clot gets it.\n\n${MEMORY_REPLIES}`;
    },
    texts: {
      filed: "Put to the user.",
      already: "Already with the user.",
      full: (n) => `Not asked: ${n} global memories already wait for the user.`,
      notAsked: () => "The user could not be asked just now.",
    },
    async onReply(ask, text, io) {
      const answer = matchYesNo(text);
      if (answer === undefined) return io.repeat(MEMORY_RETRY);
      if (!io.setBusy()) return;
      const { note, line } = await d.resolve(ask.payload, answer);
      await io.close(note, line);
    },
  };
}
