import type { FileChange, TurnActivity } from "../types.js";

function countLines(text: string): number {
  if (text === "") return 0;
  return text.replace(/\n$/, "").split("\n").length;
}

/**
 * Collects what a turn changed and ran, from the SDK's message stream.
 * File counts come from the results of the edit and write tools, so changes
 * made by a shell command show up as the command, not as a file.
 */
export class ActivityCollector {
  private files = new Map<string, FileChange>();
  private commands: string[] = [];

  constructor(private root: string) {}

  observe(message: unknown): void {
    if (typeof message !== "object" || message === null) return;
    const m = message as Record<string, any>;
    if (m.type === "assistant" && Array.isArray(m.message?.content)) {
      for (const block of m.message.content) {
        if (block?.type === "tool_use" && block.name === "Bash" && typeof block.input?.command === "string") {
          this.commands.push(block.input.command);
        }
      }
    }
    if (m.type === "user") this.observeResult(m.tool_use_result);
  }

  activity(): TurnActivity {
    return { files: [...this.files.values()], commands: [...this.commands] };
  }

  private observeResult(result: unknown): void {
    if (typeof result !== "object" || result === null) return;
    const r = result as Record<string, any>;
    if (typeof r.filePath !== "string" || !Array.isArray(r.structuredPatch)) return;

    let added = 0;
    let removed = 0;
    for (const hunk of r.structuredPatch) {
      for (const line of Array.isArray(hunk?.lines) ? hunk.lines : []) {
        if (typeof line !== "string") continue;
        if (line.startsWith("+")) added += 1;
        else if (line.startsWith("-")) removed += 1;
      }
    }
    // A new file has no patch; every line of it is an addition.
    if (r.type === "create" && typeof r.content === "string") added = countLines(r.content);

    const prefix = `${this.root}/`;
    const path = r.filePath.startsWith(prefix) ? r.filePath.slice(prefix.length) : r.filePath;
    const entry = this.files.get(path) ?? { path, added: 0, removed: 0 };
    entry.added += added;
    entry.removed += removed;
    this.files.set(path, entry);
  }
}
