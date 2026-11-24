import type { MemoryFolders } from "./agent/memory-folder.js";
import { CHANGED_AGAIN, type MemoryPayload } from "./asks/memory.js";
import { compareHome, type MemoryAction } from "./memory-compare.js";
import { frontMatter, indexLine, withGlobalBlock } from "./memory-index.js";
import type { AskRow, MemoryChangeRow, Store } from "./store.js";

export interface GlobalMemoryDeps {
  store: Store;
  folders: MemoryFolders;
  /** The home Clot's name: the only Clot whose global memories are read. */
  home: string;
  /** Every Clot the daemon runs, the home Clot among them. */
  clots: string[];
  /** Posts in a Clot's live channel. Never throws. */
  say: (clot: string, text: string) => Promise<void>;
  /** Whether a turn of this Clot is running. */
  isBusy: (clot: string) => boolean;
  /** Puts a memory from an outsider's turn to the user, and withdraws such a question. */
  asks: {
    open(payload: MemoryPayload): Promise<string>;
    withdraw(id: number, reason: string): Promise<boolean>;
  };
}

/** A file's name in the user's eyes: its front matter's `name`, or the file name. */
const title = (file: string, text: string | null | undefined) => (text ? frontMatter(text).name : undefined) ?? file;

/**
 * The global memories: what the home Clot writes in its `global-clot-` files, copied into every
 * Clot's memory folder. A change is applied at once and posted with its undo, since only the
 * user's Clots see it. One written in a home turn an outsider's text started is asked first.
 * Everything it does runs one step at a time, so a check, an answer and an undo never overlap.
 */
export class GlobalMemory {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private d: GlobalMemoryDeps) {}

  private serial<T>(step: () => Promise<T>): Promise<T> {
    const result = this.queue.then(step);
    this.queue = result.catch(() => undefined);
    return result;
  }

  /** Brings a Clot's folder up to date before its turn. Never throws: a failed sync is tried again before the next turn. */
  beforeTurn(clot: string): Promise<void> {
    return this.serial(async () => {
      await this.sync(clot).catch((error) => console.error(`[${clot}] syncing global memories failed:`, error));
    });
  }

  /** Looks at the home Clot's folder after its turn, and once at startup. outsider: the turn came from an outsider's text. Never throws. */
  afterHomeTurn(o: { outsider: boolean } = { outsider: false }): Promise<void> {
    return this.serial(async () => {
      try {
        await this.check(o.outsider);
      } catch (error) {
        console.error(`[${this.d.home}] checking global memories failed:`, error);
      }
    });
  }

  /** Answers `/memory`. */
  list(): string {
    const approved = [...this.d.store.approvedMemories()];
    return [
      approved.length === 0 ? "No global memories are in force." : "Global memories in force:",
      ...approved.map(([file, text]) => {
        const { description } = frontMatter(text);
        return `- ${title(file, text)} (\`${file}\`)${description === undefined ? "" : `: ${description}`}`;
      }),
    ].join("\n");
  }

  /** Answers `/memory undo`: reverts the latest change that spread. */
  undo(): Promise<string> {
    return this.serial(async () => {
      const { store } = this.d;
      const change = store.lastMemoryChange();
      if (!change) return "There is no global memory change left to undo.";
      if (this.openAsks().some((ask) => ask.payload.file === change.file)) {
        return `\`${change.file}\` has a question waiting for your answer. Answer it first, then undo.`;
      }
      store.undoMemoryChange(change);
      store.addMemoryRestore(change.file);
      const what = undoneWhat(change);
      this.noteOthers(spreadNote(change.file, change.newText, change.oldText));
      store.addNote(this.d.home, `The user undid ${what}. Your copy was put back to match. Do not write it again unless the user asks.`);
      await this.restoreHomeNow();
      return `Undid ${what}.`;
    });
  }

  /** Carries out the user's answer to a memory from an outsider's turn. Returns the note for the home Clot and the line for its channel. */
  resolve(p: MemoryPayload, answer: "yes" | "no"): Promise<{ note: string; line: string }> {
    return this.serial(async () => {
      const { store } = this.d;
      const name = title(p.file, p.text);
      const old = store.approvedMemories().get(p.file);
      if (answer === "yes") {
        this.apply(p.file, p.text, old);
        return { note: `The user approved the global memory ${name} (${p.file}). It is now in every Clot's memory.`, line: `Approved. ${appliedLine(p.file, p.text, old)}` };
      }
      store.addMemoryRestore(p.file);
      await this.restoreHomeNow();
      return {
        note: `The user declined the global memory you wrote, ${name} (${p.file}). Your copy was ${old === undefined ? "removed" : "put back to the text in force"}. Do not write it again unless the user asks.`,
        line: `Declined: global memory ${name} (\`${p.file}\`).`,
      };
    });
  }

  /** Puts the home Clot's copy of a file asked about back to the text in force, now or after its running turn. */
  restore(p: MemoryPayload): void {
    // Recorded at once, in the caller's transaction; the folder is written after the step running now, which may be the check that withdrew it.
    this.d.store.addMemoryRestore(p.file);
    void this.serial(() => this.restoreHomeNow());
  }

  /** Whether this text of the file is the one in force. */
  inForce(p: MemoryPayload): boolean {
    return this.d.store.approvedMemories().get(p.file) === p.text;
  }

  private openAsks(): AskRow<MemoryPayload>[] {
    return this.d.store.openAsks(this.d.home).filter((ask) => ask.kind === "memory") as AskRow<MemoryPayload>[];
  }

  /**
   * Makes a Clot's folder match the set in force: every file in force written, every other
   * global memory removed, and the daemon's block in `MEMORY.md`. The home Clot's files are where
   * changes come from, so only those the user declined or undid are put back, unless its folder
   * is missing. Returns the global memories the folder holds afterwards.
   */
  private async sync(clot: string): Promise<Map<string, string>> {
    const { store, folders } = this.d;
    const approved = store.approvedMemories();
    const state = await folders.read(clot);
    const files = new Map(state?.files ?? []);
    const put: Record<string, string> = {};
    const remove: string[] = [];
    const isHome = clot === this.d.home;
    const restores = isHome ? store.memoryRestores() : [];

    const wanted = !isHome || state === undefined ? new Set([...approved.keys(), ...files.keys()]) : new Set(restores);
    for (const file of wanted) {
      const text = approved.get(file);
      if (text === undefined) {
        if (files.has(file)) remove.push(file);
      } else if (files.get(file) !== text) {
        put[file] = text;
      }
    }

    const oldIndex = state?.index ?? "";
    const index = withBlock(oldIndex, approved);
    if (Object.keys(put).length > 0 || remove.length > 0 || index !== oldIndex) {
      await folders.write(clot, { put, remove, ...(index !== oldIndex ? { index } : {}) });
    }
    if (isHome) store.clearMemoryRestores(state === undefined ? store.memoryRestores() : restores);
    for (const [file, text] of Object.entries(put)) files.set(file, text);
    for (const file of remove) files.delete(file);
    return files;
  }

  /** Puts back the home Clot's declined or undone copies now, unless a turn of it is running: then after that turn. */
  private async restoreHomeNow(): Promise<void> {
    if (this.d.isBusy(this.d.home)) return;
    await this.sync(this.d.home).catch((error) => console.error(`[${this.d.home}] putting back global memories failed:`, error));
  }

  private async check(outsider: boolean): Promise<void> {
    const { store } = this.d;
    // The copies the user declined or undid are put back first, so they are not taken for new changes.
    const home = await this.sync(this.d.home);
    const asked = this.openAsks();
    // A question whose file is gone, or back to the text in force, no longer asks anything.
    for (const ask of asked) {
      const now = home.get(ask.payload.file);
      if (now === undefined || now === store.approvedMemories().get(ask.payload.file)) await this.d.asks.withdraw(ask.id, "the home Clot has since removed it or put it back");
    }
    for (const action of compareHome(home, store.approvedMemories())) await this.carryOut(action, outsider, asked);
  }

  private async carryOut(action: MemoryAction, outsider: boolean, asked: AskRow<MemoryPayload>[]): Promise<void> {
    const { store, home } = this.d;
    if (action.kind === "delete") {
      // A deletion only takes away: it applies at once in every turn.
      const text = store.approvedMemories().get(action.file);
      store.applyMemoryChange(action.file, null);
      this.noteOthers(spreadNote(action.file, text ?? null, null));
      await this.d.say(home, `Global memory removed from every Clot: ${title(action.file, text)} (\`${action.file}\`). \`/memory undo\` brings it back.`);
      return;
    }
    const open = asked.find((ask) => ask.payload.file === action.file);
    // Still waiting for the answer about this very text: a later, untainted turn does not apply it.
    if (open?.payload.text === action.text) return;
    if (open) await this.d.asks.withdraw(open.id, CHANGED_AGAIN);
    if (outsider || open) {
      // Written in an outsider's turn, or changed again while one was asked: the user is asked about the new text.
      await this.d.asks.open({ file: action.file, text: action.text, ...(action.approved === undefined ? {} : { approved: action.approved }) });
      // Not asked (Discord down, the limit reached): the copy is put back, so no later check applies it unasked.
      if (!this.openAsks().some((ask) => ask.payload.file === action.file && ask.payload.text === action.text)) this.restore({ file: action.file, text: action.text });
      return;
    }
    this.apply(action.file, action.text, action.approved);
    await this.d.say(home, `${appliedLine(action.file, action.text, action.approved)} \`/memory undo\` takes it back.`);
  }

  private apply(file: string, text: string, old: string | undefined): void {
    this.d.store.applyMemoryChange(file, text);
    this.noteOthers(spreadNote(file, old ?? null, text));
  }

  /** Leaves a note for every Clot but the home Clot, which is told in its own words. */
  private noteOthers(text: string): void {
    for (const clot of this.d.clots) if (clot !== this.d.home) this.d.store.addNote(clot, text);
  }
}

/** The line the home Clot's channel gets when a memory is put in force. */
function appliedLine(file: string, text: string, old: string | undefined): string {
  return `Global memory ${old === undefined ? "added" : "changed"} for every Clot: ${title(file, text)} (\`${file}\`).`;
}

/** `MEMORY.md` with the daemon's block listing the files in force. */
function withBlock(index: string, approved: Map<string, string>): string {
  return withGlobalBlock(index, [...approved].map(([file, text]) => indexLine(file, text)));
}

/** The note every other Clot gets when a global memory changes. */
function spreadNote(file: string, oldText: string | null, newText: string | null): string {
  const name = title(file, newText ?? oldText);
  if (newText === null) return `The global memory ${name} (${file}) was removed. Stop acting on it.`;
  if (oldText === null) return `A global memory was added: ${name} (${file}). It is listed in your MEMORY.md.`;
  return `The global memory ${name} (${file}) was changed. Read it again before relying on it.`;
}

/** What `/memory undo` reverted, in words. */
function undoneWhat(change: MemoryChangeRow): string {
  const name = title(change.file, change.newText ?? change.oldText);
  if (change.oldText === null) return `the addition of global memory ${name} (\`${change.file}\`)`;
  if (change.newText === null) return `the removal of global memory ${name} (\`${change.file}\`)`;
  return `the change to global memory ${name} (\`${change.file}\`)`;
}
