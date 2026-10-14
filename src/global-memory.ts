import type { MemoryFolders } from "./agent/memory-folder.js";
import type { ChatAdapter, InboundMessage } from "./chat/adapter.js";
import { memoryChannelName } from "./chat/names.js";
import { matchYesNo, MEMORY_REPLIES, MEMORY_RETRY } from "./events/reply.js";
import { compareHome, type MemoryAction } from "./memory-compare.js";
import { frontMatter, indexLine, withGlobalBlock } from "./memory-index.js";
import type { MemoryChangeRow, Store } from "./store.js";

export interface GlobalMemoryDeps {
  store: Store;
  chat: ChatAdapter;
  folders: MemoryFolders;
  /** The home Clot's name: the only Clot whose global memories are read. */
  home: string;
  /** Every Clot the daemon runs, the home Clot among them. */
  clots: string[];
  userId: string;
  /** How many questions may wait for the user at once. */
  max: number;
  /** Posts in a Clot's live channel. Never throws. */
  say: (clot: string, text: string) => Promise<void>;
  /** Whether a turn of this Clot is running. */
  isBusy: (clot: string) => boolean;
}

/** A file's name in the user's eyes: its front matter's `name`, or the file name. */
const title = (file: string, text: string | null | undefined) => (text ? frontMatter(text).name : undefined) ?? file;

/** Shows a memory as a code block, in which nothing is a mention or formatting. A fence in the text is broken up. */
const block = (text: string) => `\`\`\`md\n${text.replace(/```/g, "`​``")}\n\`\`\``;

/**
 * The global memories: what the home Clot writes in its `global-clot-` files, asked about in a
 * temporary channel, and copied into every Clot's memory folder once the user has said yes.
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

  /** Looks at the home Clot's folder after its turn, and once at startup. Never throws. */
  afterHomeTurn(): Promise<void> {
    return this.serial(async () => {
      try {
        await this.check();
      } catch (error) {
        console.error(`[${this.d.home}] checking global memories failed:`, error);
      }
    });
  }

  /** Handles a message in a question's channel. Returns false when the channel is not one, so the message belongs elsewhere. */
  async onReply(m: InboundMessage): Promise<boolean> {
    const question = this.d.store.memoryQuestionByChannel(m.channelId);
    if (!question) return false;
    if (m.authorId !== this.d.userId) return true;
    const answer = matchYesNo(m.text);
    if (answer === undefined) {
      await this.d.chat.post(m.channelId, MEMORY_RETRY).catch(() => undefined);
      return true;
    }
    await this.serial(() => this.resolve(m.channelId, answer));
    return true;
  }

  /** Closes the questions whose channel was removed while the daemon was down. The next check asks again. */
  closeOrphans(): Promise<void> {
    return this.serial(async () => {
      for (const question of this.d.store.memoryQuestions()) {
        // Not knowing whether it exists is no reason to close anything.
        const exists = await this.d.chat.channelExists(question.channelId).catch(() => undefined);
        if (exists === false) this.d.store.deleteMemoryQuestion(question.file);
      }
    });
  }

  /** Answers `&memory`. */
  list(): string {
    const approved = [...this.d.store.approvedMemories()];
    const waiting = this.d.store.memoryQuestions();
    const lines = [
      approved.length === 0 ? "No global memories are in force." : "Global memories in force:",
      ...approved.map(([file, text]) => {
        const { description } = frontMatter(text);
        return `- ${title(file, text)} (\`${file}\`)${description === undefined ? "" : `: ${description}`}`;
      }),
    ];
    if (waiting.length > 0) lines.push("", "Waiting for your answer:", ...waiting.map((q) => `- \`${q.file}\` in ${this.d.chat.channelLink(q.channelId)}`));
    return lines.join("\n");
  }

  /** Answers `&memory undo`: reverts the latest change that spread. */
  undo(): Promise<string> {
    return this.serial(async () => {
      const { store } = this.d;
      const change = store.lastMemoryChange();
      if (!change) return "There is no global memory change left to undo.";
      if (store.memoryQuestions().some((q) => q.file === change.file)) {
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

  /**
   * Makes a Clot's folder match the approved set: every approved file written, every other
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

  private async check(): Promise<void> {
    const { store } = this.d;
    // The copies the user declined or undid are put back first, so they are not taken for new changes.
    const home = await this.sync(this.d.home);
    for (const action of compareHome(home, store.approvedMemories(), store.memoryQuestions())) await this.carryOut(action);
  }

  private async carryOut(action: MemoryAction): Promise<void> {
    const { store, chat, home } = this.d;
    if (action.kind === "withdraw") {
      if (!store.deleteMemoryQuestion(action.file)) return;
      await chat.deleteChannel(action.channelId).catch(() => undefined);
      await this.d.say(home, `Withdrawn: the question about global memory \`${action.file}\`, which the home Clot has since removed or put back.`);
    } else if (action.kind === "delete") {
      const text = store.approvedMemories().get(action.file);
      store.applyMemoryChange(action.file, null);
      this.noteOthers(spreadNote(action.file, text ?? null, null));
      await this.d.say(home, `Global memory removed from every Clot: ${title(action.file, text)} (\`${action.file}\`). \`&memory undo\` brings it back.`);
    } else if (action.kind === "update") {
      // The answer moves to the new text only once the user has been shown it; otherwise the next check posts it again.
      try {
        await chat.post(action.channelId, `The home Clot changed \`${action.file}\` again. Your answer now applies to this text:\n\n${block(action.text)}\n\n${MEMORY_REPLIES}`);
      } catch {
        return;
      }
      store.setMemoryQuestionText(action.file, action.text);
    } else {
      await this.ask(action.file, action.text, action.approved);
    }
  }

  private async ask(file: string, text: string, approved: string | undefined): Promise<void> {
    const { store, chat } = this.d;
    // A file that finds the limit reached is asked about after an earlier question closes.
    if (store.memoryQuestions().length >= this.d.max) return;
    const row = store.getClot(this.d.home);
    if (!row) return;
    let channelId: string;
    let channelName: string;
    try {
      channelName = memoryChannelName(this.d.home, await chat.listChannelNames(row.categoryId));
      channelId = await chat.createChannel(row.categoryId, channelName);
    } catch {
      return;
    }
    const what =
      approved === undefined
        ? `The home Clot wrote a new global memory, \`${file}\`:\n\n${block(text)}`
        : `The home Clot changed the global memory \`${file}\`. As it is now:\n\n${block(approved)}\n\nAs it would be:\n\n${block(text)}`;
    try {
      await chat.post(channelId, `${chat.mention(this.d.userId)} ${what}\n\nIf you say yes, every Clot gets it.\n\n${MEMORY_REPLIES}`);
    } catch {
      // Nothing is stored, so the next check asks again.
      await chat.deleteChannel(channelId).catch(() => undefined);
      return;
    }
    store.createMemoryQuestion({ file, text, channelId, channelName });
  }

  private async resolve(channelId: string, answer: "yes" | "no"): Promise<void> {
    const { store, home } = this.d;
    const question = store.memoryQuestionByChannel(channelId);
    // Closed meanwhile, by another answer or by a check.
    if (!question || !store.deleteMemoryQuestion(question.file)) return;
    const name = title(question.file, question.text);
    const old = store.approvedMemories().get(question.file);
    if (answer === "yes") {
      store.applyMemoryChange(question.file, question.text);
      this.noteOthers(spreadNote(question.file, old ?? null, question.text));
      store.addNote(home, `The user approved the global memory ${name} (${question.file}). It is now in every Clot's memory.`);
      await this.d.say(home, `Approved. Global memory ${name} (\`${question.file}\`) is in force for every Clot.`);
    } else {
      store.addMemoryRestore(question.file);
      store.addNote(
        home,
        `The user declined the global memory you wrote, ${name} (${question.file}). Your copy was ${old === undefined ? "removed" : "put back to the approved text"}. Do not write it again unless the user asks.`,
      );
      await this.d.say(home, `Declined: global memory ${name} (\`${question.file}\`).`);
      await this.restoreHomeNow();
    }
    await this.d.chat.deleteChannel(question.channelId).catch(() => undefined);
  }

  /** Leaves a note for every Clot but the home Clot, which is told in its own words. */
  private noteOthers(text: string): void {
    for (const clot of this.d.clots) if (clot !== this.d.home) this.d.store.addNote(clot, text);
  }
}

/** `MEMORY.md` with the daemon's block listing the approved files. */
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

/** What `&memory undo` reverted, in words. */
function undoneWhat(change: MemoryChangeRow): string {
  const name = title(change.file, change.newText ?? change.oldText);
  if (change.oldText === null) return `the addition of global memory ${name} (\`${change.file}\`)`;
  if (change.newText === null) return `the removal of global memory ${name} (\`${change.file}\`)`;
  return `the change to global memory ${name} (\`${change.file}\`)`;
}
