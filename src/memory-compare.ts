/** A question about a global memory that is waiting for the user's answer. */
export interface OpenQuestion {
  file: string;
  /** The text the user is being asked about. */
  text: string;
  channelId: string;
}

/** What the daemon does about one file after looking at the home Clot's folder. */
export type MemoryAction =
  /** Withdraw the question: the file is gone, or back to the text the user approved. */
  | { kind: "withdraw"; file: string; channelId: string }
  /** The home Clot removed an approved memory: remove it everywhere. */
  | { kind: "delete"; file: string }
  /** The home Clot changed the file again before the user answered: ask about the new text. */
  | { kind: "update"; file: string; text: string; channelId: string }
  /** A new memory, or a change to an approved one: ask the user. */
  | { kind: "ask"; file: string; text: string; approved: string | undefined };

const ORDER: MemoryAction["kind"][] = ["withdraw", "delete", "update", "ask"];

/**
 * Compares the global memories in the home Clot's folder with the approved set and the open
 * questions. Withdrawals come first, so that the questions they close make room for new ones;
 * within each kind, files are in name order.
 */
export function compareHome(home: Map<string, string>, approved: Map<string, string>, questions: OpenQuestion[]): MemoryAction[] {
  const actions: MemoryAction[] = [];
  const question = new Map(questions.map((q) => [q.file, q]));

  for (const [file, text] of home) {
    const q = question.get(file);
    if (text === approved.get(file)) {
      if (q) actions.push({ kind: "withdraw", file, channelId: q.channelId });
    } else if (!q) {
      actions.push({ kind: "ask", file, text, approved: approved.get(file) });
    } else if (q.text !== text) {
      actions.push({ kind: "update", file, text, channelId: q.channelId });
    }
  }
  for (const file of approved.keys()) {
    if (home.has(file)) continue;
    actions.push({ kind: "delete", file });
    const q = question.get(file);
    if (q) actions.push({ kind: "withdraw", file, channelId: q.channelId });
  }
  for (const q of questions) {
    if (!home.has(q.file) && !approved.has(q.file)) actions.push({ kind: "withdraw", file: q.file, channelId: q.channelId });
  }

  return actions.sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind) || a.file.localeCompare(b.file));
}
