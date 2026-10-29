/** What the daemon does about one file after looking at the home Clot's folder. */
export type MemoryAction =
  /** The home Clot removed a memory in force: remove it everywhere. */
  | { kind: "delete"; file: string }
  /** A new memory, or a change to one in force. */
  | { kind: "apply"; file: string; text: string; approved: string | undefined };

/**
 * Compares the global memories in the home Clot's folder with the set in force. Deletions come
 * first; within each kind, files are in name order.
 */
export function compareHome(home: Map<string, string>, approved: Map<string, string>): MemoryAction[] {
  const actions: MemoryAction[] = [];
  for (const file of approved.keys()) if (!home.has(file)) actions.push({ kind: "delete", file });
  for (const [file, text] of home) if (text !== approved.get(file)) actions.push({ kind: "apply", file, text, approved: approved.get(file) });
  return actions.sort((a, b) => (a.kind === b.kind ? a.file.localeCompare(b.file) : a.kind === "delete" ? -1 : 1));
}
