import { labelOf } from "../clot-name.js";
import type { AskKind } from "../asks.js";
import { blockedLine } from "./common.js";

export interface MemoryPayload {
  file: string;
  /** The text the user is asked about. */
  text: string;
  /** The text in force now, if the file is in force. */
  approved?: string;
}

/**
 * A global memory the home Clot wrote in a turn an outsider's text started. Every Clot would
 * trust it from then on, so it is put to the user first: allowing it applies it as any other change,
 * a no puts the home Clot's copy back. Anything else repeats the question.
 */
/** The reason given when the home Clot changed the file again: a new question about the new text follows, so the copy stays. */
export const CHANGED_AGAIN = "the home Clot changed it again";

export function memoryKind(d: {
  resolve(payload: MemoryPayload, answer: "yes" | "no"): Promise<{ note: string | null; line: string }>;
  /** Marks the home Clot's copy to be put back to the text in force; the folder is written soon after. Store writes only, so it can join a transaction. */
  restore(payload: MemoryPayload): void;
  /** Whether this very text is in force: a yes was carried out. */
  inForce(payload: MemoryPayload): boolean;
}): AskKind<MemoryPayload> {
  return {
    kind: "memory",
    answers: ["allow", "block"],
    view: (clot, p) => ({
      heading: `Allow ${labelOf(clot)} to give every Clot a memory?`,
      shortHeading: "Allow a global memory?",
      rows: [{ label: "File", value: p.file }, { label: "Source", value: "A turn an outsider's text started" }],
      body: p.text,
      ...(p.approved === undefined ? {} : { previous: p.approved }),
      labels: { allow: "Allow", block: "Decline" },
      warning: "Every Clot would trust it from then on.",
    }),
    texts: {
      filed: "Put to the user.",
      already: "Already with the user.",
      full: (n) => `Not asked: ${n} global memories already wait for the user.`,
      notAsked: () => "The user could not be asked just now.",
    },
    async onAnswer(ask, answer, io) {
      if (answer.action !== "allow" && answer.action !== "block") return;
      if (!io.setBusy()) return;
      const { note, line } = await d.resolve(ask.payload, answer.action === "allow" ? "yes" : "no");
      await io.close(answer.action === "allow" ? "approved" : "declined", note, line);
    },

    // Silence never approves: an unanswered memory is answered no, so the home Clot's copy is put back.
    async onDeadline(ask, io) {
      if (!io.setBusy()) return;
      const { note, line } = await d.resolve(ask.payload, "no");
      await io.close("timed_out", note, `${blockedLine(ask)} ${line}`);
    },

    // An outsider's text never goes in force without a yes: a question that ends any other way puts
    // the home Clot's copy back, so a later check cannot take it for a change of the user's own.
    async interrupted(ask, io) {
      // A yes carried out before the stop stands, and is said so.
      if (d.inForce(ask.payload)) {
        await io.close("approved", `The user approved the global memory ${ask.payload.file}. It is now in every Clot's memory.`, `Approved. Global memory \`${ask.payload.file}\` is in force for every Clot.`);
        return;
      }
      d.restore(ask.payload);
      await io.close(
        "failed",
        `The daemon stopped while carrying out the user's answer about the global memory ${ask.payload.file}. It is not in force, and your copy was put back. Write it again only if the user asks.`,
        `The daemon stopped while carrying out your answer, so global memory \`${ask.payload.file}\` is not in force and the home Clot's copy was put back.`,
      );
    },

    withdrawn(ask, reason) {
      if (reason !== CHANGED_AGAIN) d.restore(ask.payload);
    },
  };
}
