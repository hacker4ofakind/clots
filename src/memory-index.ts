import { parse } from "yaml";

/** The start of every global memory's file name. Only the home Clot writes such files. */
export const GLOBAL_PREFIX = "global-clot-";

/** The names a global memory may have. Anything else is not one, and is left alone. */
const GLOBAL_FILE = /^global-clot-[a-z0-9][a-z0-9-]*\.md$/;

export const BLOCK_START = "<!-- clots: global memories, kept by the daemon. Do not edit. -->";
export const BLOCK_END = "<!-- clots: end of global memories -->";

/** A line of the index that links to a global memory, wherever it is. */
const GLOBAL_LINK = /\]\(global-clot-[^)]*\)/;

export function isGlobalFile(name: string): boolean {
  return GLOBAL_FILE.test(name);
}

/** The `name` and `description` from a memory file's front matter, when it has them. */
export function frontMatter(text: string): { name?: string; description?: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) return {};
  let data: unknown;
  try {
    data = parse(match[1]);
  } catch {
    return {};
  }
  if (data === null || typeof data !== "object") return {};
  const field = (key: string) => {
    const value = (data as Record<string, unknown>)[key];
    return typeof value === "string" && value.trim() !== "" ? value.replace(/\s+/g, " ").trim() : undefined;
  };
  return { name: field("name"), description: field("description") };
}

/** The index line for one global memory: its name, or the file name when it has none, then its description. */
export function indexLine(file: string, text: string): string {
  const { name, description } = frontMatter(text);
  const title = (name ?? file).replace(/[[\]]/g, "");
  return `- [${title}](${file})${description === undefined ? "" : ` — ${description}`}`;
}

/**
 * Returns `MEMORY.md` with the daemon's block at the top, holding these lines. The block is
 * taken out wherever the Clot has moved it, and so is any line outside it that links to a global
 * memory; every other line the Clot wrote stays as it was. With no lines, no block is written.
 */
export function withGlobalBlock(index: string, lines: string[]): string {
  const all = index.split("\n");
  const kept: string[] = [];
  for (let i = 0; i < all.length; i += 1) {
    const line = all[i];
    if (line.trim() === BLOCK_START) {
      // A start with no end after it marks nothing: only the marker goes, and the Clot's lines stay.
      const end = all.findIndex((other, j) => j > i && other.trim() === BLOCK_END);
      if (end !== -1) i = end;
      continue;
    }
    if (line.trim() === BLOCK_END || GLOBAL_LINK.test(line)) continue;
    kept.push(line);
  }
  if (lines.length === 0) return kept.join("\n");
  return [BLOCK_START, ...lines, BLOCK_END, ...kept].join("\n");
}
