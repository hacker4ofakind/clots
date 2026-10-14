# Clots Global Memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (recommended) or superpowers:subagent-driven-development (can be usage intensive) to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The home Clot writes global memories, the user approves each in a temporary channel, and the daemon copies the approved ones into every Clot's own memory folder before its turns; `&memory` lists them and `&memory undo` steps back through the changes.

**Architecture:** The daemon keeps the approved set in its store. After each home Clot turn it reads the home Clot's `global-clot-*.md` files through `docker exec`, compares them with the approved set and the open questions (a pure function), and asks, updates, withdraws or deletes. Before each turn of any Clot it syncs that Clot's folder: approved files written, other global memories removed, and a marked block of index lines kept at the top of `MEMORY.md` (another pure function). One coordinator runs all of this one step at a time.

**Tech Stack:** as stage 2b (Node 22+, TypeScript ESM, `@anthropic-ai/claude-agent-sdk`, `discord.js` 14, `better-sqlite3`, `zod`, `yaml`, `vitest`, `tsx`, Docker). No new dependency.

**Spec:** `.superpowers/specs/2026-10-14-clots-global-memory-design.md`. Read all of it. Stage 2b's spec, for proposals, notes and the home Clot: `.superpowers/specs/2026-10-12-clots-stage-2b-rulebook-design.md`. Parent design: `.superpowers/specs/2026-10-10-clots-design.md`, section 6 ("Memory" and "Commands").

## Global Constraints

- Only the home Clot writes global memories. A global memory is a file named `global-clot-<topic>.md` in the home Clot's memory folder, the topic in lowercase letters, digits and hyphens. A file named any other way is not one, and the daemon leaves it alone.
- Memory folders: `/home/clot/.claude/projects/-workspace/memory/` for the home Clot (turns start in `/workspace`), `/home/clot/.claude/projects/-workspace-repo/memory/` for a project Clot (turns start in `/workspace/repo`). The daemon reaches them only through `docker exec`, as the container's own user.
- The approved set in the daemon's store is what is in force. The home Clot's folder is where changes come from, never the record.
- A new or changed global memory spreads only after the user's yes, given in a temporary channel `home-memory` (`-2`, ...) in the home Clot's category. Replies are matched as for a rule proposal: `yes`, `sure`, `do that`, `yeah`; `no`, `dont`, `not at all`; anything else repeats the question. The reply never reaches the model.
- A deletion by the home Clot is applied at once, without a yes.
- On a no, and on `&memory undo`, the home Clot's copy is put back to the approved text (or removed), and only while no home Clot turn runs.
- At most `CLOTS_MAX_PROPOSALS` (default `3`) questions are open at once, counted apart from rule proposals. Questions do not close with a session.
- Before every turn of every Clot, the daemon syncs its folder. The home Clot's own `global-clot-` files are left alone, except those to be put back and when its folder is missing.
- The daemon's block in `MEMORY.md` starts with `<!-- clots: global memories, kept by the daemon. Do not edit. -->`, ends with `<!-- clots: end of global memories -->`, and sits at the top of the file. The Clot's own lines are never changed.
- Every change that spreads (an approval, a deletion, an undo) leaves a note for every Clot.
- `&memory` and `&memory undo` are answered by the daemon at once, in any Clot's channel, never reach the model, and work while a turn runs. `&memory undo` needs no further yes, and is refused while the file it would revert has an open question.
- Secrets live in `.env` and are never committed, printed or posted.
- Before stopping or restarting the daemon, check that no turn is running, and confirm the `node` process is gone before starting another.
- Edit files with the editor, not with scripts. Existing files are changed by replacing the exact text shown under **Replace** with the text under **With**.
- Commit once, at the end of Task 9. Work on the `global-memory` branch.
- If any check in Task 1 fails, stop and report to the user. Do not work around it.

## File Structure

| File | Responsibility | |
|---|---|---|
| `scripts/spike-memory.ts` | Checks that a session reads the daemon's block, before and after a resume | New |
| `src/memory-index.ts` | Global memory names, front matter, index lines, the daemon's block in `MEMORY.md` (pure) | New |
| `src/memory-compare.ts` | Compares the home Clot's files with the approved set and open questions (pure) | New |
| `src/agent/memory-folder.ts` | Reads and writes a Clot's memory folder through `docker exec` | New |
| `src/store.ts` | The approved set, the change log, questions, copies to put back | Changed |
| `src/chat/names.ts`, `src/events/reply.ts` | `memoryChannelName`; the replies a question accepts | Changed |
| `src/commands.ts` | `&memory`, `&memory undo` | Changed |
| `src/agent/prompts.ts` | What project Clots and the home Clot are told about global memories | Changed |
| `src/global-memory.ts` | Checks, questions, answers, syncs, `&memory` | New |
| `src/clot.ts` | A sync before each turn; `&memory` | Changed |
| `src/daemon.ts` | Wiring | Changed |

---

### Task 1: Environment, branch and checks

Nothing else is built until this task passes.

**Files:**
- Create: `scripts/spike-memory.ts`

**Interfaces:**
- Consumes: `SdkRunner` from `src/agent/runner.ts`; `containerName` from `src/agent/container.ts`.
- Produces: branch `global-memory`; confirmation of section 14 of the spec.

- [ ] **Step 1: Check the environment**

**Local (the default).** Say to the user: "Please make sure Docker Desktop is running." Then:

Run: `npm run preflight`
Expected: `PREFLIGHT OK`.

**Claude Code cloud environment (only if the user said this session runs in one).** Before anything else, measure CPU count, memory, free disk, and whether Docker can start a container (`docker run --rm hello-world`). One Clot in development needs the daemon, one container running Claude Code, and a project build. If the environment falls short, stop and tell the user; they will restart the session locally.

If the daemon is running, check that no turn is in progress, stop it, and confirm no `node` process running `src/daemon.ts` is left.

- [ ] **Step 2: Be on the branch**

Run: `git branch --show-current`
If it does not print `global-memory`, run `git checkout -b global-memory`. The spec, this plan and the updated parent design and stage 2b documents are uncommitted and come along.

Run: `npm test`
Expected: every test passes. This is the baseline.

- [ ] **Step 3: Check that auto memory is on in the Clots' containers**

Run: `docker start clot-encryptify clot-home`, then:

```bash
docker exec clot-encryptify sh -c 'id -un; ls /home/clot/.claude/projects/'
docker exec clot-home sh -c 'ls -d /home/clot/.claude/projects/-workspace/memory'
```

Expected: `clot`; a `-workspace-repo` folder in the first list (it may hold a `memory` folder with the Clot's own memories); and the home Clot's memory folder. If the home Clot has had no turn yet and the folder is missing, that is fine: the daemon creates it.

- [ ] **Step 4: Check that a session reads the daemon's block, also after a resume**

Create `scripts/spike-memory.ts`:

```ts
// Global memory assumption check: does a session the daemon starts read MEMORY.md and follow a
// line in the daemon's block to the file, and does a resumed session see a block the daemon
// rewrote between its turns?
// Run: node --env-file=.env --import tsx scripts/spike-memory.ts
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { SdkRunner } from "../src/agent/runner.js";
import { containerName } from "../src/agent/container.js";

const clot = "spikememory";
const name = containerName(clot);
const MEMORY = "/home/clot/.claude/projects/-workspace-repo/memory";

/** Writes a file in the container as the daemon would: through `docker exec`, with the text on stdin. */
function put(path: string, text: string): void {
  execFileSync("docker", ["exec", "-i", name, "sh", "-c", 'mkdir -p "$(dirname "$1")" && cat > "$1"', "sh", path], { input: text });
}

const block = (lines: string[]) =>
  ["<!-- clots: global memories, kept by the daemon. Do not edit. -->", ...lines, "<!-- clots: end of global memories -->", ""].join("\n");

try { execFileSync("docker", ["rm", "-f", name], { stdio: "ignore" }); } catch { /* not running */ }
execFileSync("docker", ["run", "-d", "--name", name, "clots-clot:dev"], { stdio: "ignore" });
execFileSync("docker", ["exec", name, "mkdir", "-p", "/workspace/repo"]);

put(`${MEMORY}/global-clot-colour.md`, "---\nname: Favourite colour\ndescription: the user's favourite colour\ntype: user\n---\n\nThe user's favourite colour is teal.\n");
put(`${MEMORY}/MEMORY.md`, block(["- [Favourite colour](global-clot-colour.md) — the user's favourite colour"]) + "- [Own note](own-note.md) — a line the Clot wrote itself\n");

const runner = new SdkRunner({ clot, env: { CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN! } });
const id = randomUUID();
const ask = async (prompt: string, resume: boolean) => {
  const result = await runner.startTurn({ ...(resume ? { resume: id } : { newSessionId: id }), prompt, effort: "low", locked: true, onText: (t) => console.log("[clot]", t) }).done;
  console.log("ok:", result.ok);
};

console.log("== new session");
await ask("First, without using any tool, copy out the lines of your memory index (MEMORY.md) exactly as they appear in your context, or say you have none. Then: what is the user's favourite colour? You may read files.", false);

put(`${MEMORY}/global-clot-pet.md`, "---\nname: Pet\ndescription: the user's pet\ntype: user\n---\n\nThe user's pet is a ferret named Bolt.\n");
put(
  `${MEMORY}/MEMORY.md`,
  block(["- [Favourite colour](global-clot-colour.md) — the user's favourite colour", "- [Pet](global-clot-pet.md) — the user's pet"]) + "- [Own note](own-note.md) — a line the Clot wrote itself\n",
);

console.log("== resumed session, after the block was rewritten");
await ask("Without using any tool, copy out the lines of your memory index (MEMORY.md) exactly as they appear in your context now, and say whether they differ from what you saw at the start.", true);

execFileSync("docker", ["rm", "-f", name], { stdio: "ignore" });
```

Run: `node --env-file=.env --import tsx scripts/spike-memory.ts`
Expected, read by you rather than matched exactly:
- under `== new session`, the two index lines (the comment lines are not shown to the model) and the answer `teal`, then `ok: true`;
- under `== resumed session`, three index lines, `Pet` among them, and a statement that the index changed, then `ok: true`.

If the new session sees no index, or the resumed one does not see the `Pet` line, stop and report what it printed.

- [ ] **Step 5: Check the container's `base64`**

Run: `docker exec clot-home sh -c 'printf "a b" | base64 -w0; echo; echo YWI= | base64 -d; echo'`
Expected: `YSBi`, then `ab`. Task 4 moves file text in and out of containers with these two forms.

---

### Task 2: The daemon's block in `MEMORY.md`

**Files:**
- Create: `src/memory-index.ts`
- Test: `tests/memory-index.test.ts`

**Interfaces:**
- Consumes: `parse` from `yaml`.
- Produces, from `src/memory-index.ts`:
  - `GLOBAL_PREFIX = "global-clot-"`, `BLOCK_START`, `BLOCK_END` (strings)
  - `isGlobalFile(name: string): boolean`
  - `frontMatter(text: string): { name?: string; description?: string }`
  - `indexLine(file: string, text: string): string`
  - `withGlobalBlock(index: string, lines: string[]): string`

- [ ] **Step 1: Write the failing tests**

Create `tests/memory-index.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { BLOCK_END, BLOCK_START, frontMatter, indexLine, isGlobalFile, withGlobalBlock } from "../src/memory-index.js";

const memory = (front: string, body = "The user deploys on Fridays only.") => `---\n${front}\n---\n\n${body}\n`;
const deploy = "- [Deploy days](global-clot-deploy-days.md) — the user deploys on Fridays only";
const pet = "- [Pet](global-clot-pet.md) — the user's pet";

describe("isGlobalFile", () => {
  it("accepts global-clot- names of lowercase letters, digits and hyphens", () => {
    expect(isGlobalFile("global-clot-deploy-days.md")).toBe(true);
    expect(isGlobalFile("global-clot-2fa.md")).toBe(true);
    for (const name of ["deploy-days.md", "global-clot-.md", "global-clot-Deploy.md", "global-clot-a b.md", "global-clot-x.txt", "MEMORY.md"]) {
      expect(isGlobalFile(name)).toBe(false);
    }
  });
});

describe("frontMatter", () => {
  it("reads name and description", () => {
    expect(frontMatter(memory("name: Deploy days\ndescription: the user deploys on Fridays only\ntype: user"))).toEqual({ name: "Deploy days", description: "the user deploys on Fridays only" });
  });

  it("reads quoted values and folds line breaks", () => {
    expect(frontMatter(memory('name: "Deploy: days"\ndescription: >\n  the user deploys\n  on Fridays only'))).toEqual({ name: "Deploy: days", description: "the user deploys on Fridays only" });
  });

  it("gives nothing for a file without front matter, or with front matter that is not a mapping", () => {
    expect(frontMatter("The user deploys on Fridays only.")).toEqual({});
    expect(frontMatter(memory("- a list"))).toEqual({});
    expect(frontMatter(memory("name: [unclosed"))).toEqual({});
  });
});

describe("indexLine", () => {
  it("links the file under its name, with its description", () => {
    expect(indexLine("global-clot-deploy-days.md", memory("name: Deploy days\ndescription: the user deploys on Fridays only"))).toBe(deploy);
  });

  it("uses the file name when there is no name, and leaves out a missing description", () => {
    expect(indexLine("global-clot-x.md", "Just text.")).toBe("- [global-clot-x.md](global-clot-x.md)");
    expect(indexLine("global-clot-x.md", memory("description: about x"))).toBe("- [global-clot-x.md](global-clot-x.md) — about x");
  });

  it("keeps brackets in a name from breaking the link", () => {
    expect(indexLine("global-clot-x.md", memory("name: Deploy [days]"))).toBe("- [Deploy days](global-clot-x.md)");
  });
});

describe("withGlobalBlock", () => {
  const own = "- [Own note](own-note.md) — a line the Clot wrote itself\n";

  it("writes the block into an empty or missing index", () => {
    expect(withGlobalBlock("", [deploy])).toBe(`${BLOCK_START}\n${deploy}\n${BLOCK_END}\n`);
  });

  it("puts the block at the top and keeps the Clot's own lines as they were", () => {
    expect(withGlobalBlock(own, [deploy, pet])).toBe(`${BLOCK_START}\n${deploy}\n${pet}\n${BLOCK_END}\n${own}`);
  });

  it("gives the same text when applied twice", () => {
    const once = withGlobalBlock(own, [deploy]);
    expect(withGlobalBlock(once, [deploy])).toBe(once);
  });

  it("moves a block the Clot moved back to the top, and replaces what the Clot wrote inside it", () => {
    const moved = `${own}${BLOCK_START}\n${deploy}\n- [Mine](mine.md) — slipped into the block\n${BLOCK_END}\n- [Later](later.md)\n`;
    expect(withGlobalBlock(moved, [pet])).toBe(`${BLOCK_START}\n${pet}\n${BLOCK_END}\n${own}- [Later](later.md)\n`);
  });

  it("drops a line outside the block that links to a global memory", () => {
    expect(withGlobalBlock(`${own}${deploy}\n`, [deploy])).toBe(`${BLOCK_START}\n${deploy}\n${BLOCK_END}\n${own}`);
  });

  it("takes out only a start marker that has no end after it", () => {
    expect(withGlobalBlock(`${BLOCK_START}\n${own}`, [deploy])).toBe(`${BLOCK_START}\n${deploy}\n${BLOCK_END}\n${own}`);
  });

  it("removes the block when there are no global memories, and leaves an index without one untouched", () => {
    expect(withGlobalBlock(`${BLOCK_START}\n${deploy}\n${BLOCK_END}\n${own}`, [])).toBe(own);
    expect(withGlobalBlock(`\n\n${own}`, [])).toBe(`\n\n${own}`);
  });
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest run tests/memory-index.test.ts`
Expected: FAIL, because `../src/memory-index.js` does not exist.

- [ ] **Step 3: Write the module**

Create `src/memory-index.ts`:

```ts
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
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `npx vitest run tests/memory-index.test.ts`
Expected: PASS, 14 tests.

---

### Task 3: Comparing the home Clot's folder

**Files:**
- Create: `src/memory-compare.ts`
- Test: `tests/memory-compare.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces, from `src/memory-compare.ts`:
  - `interface OpenQuestion { file: string; text: string; channelId: string }`
  - `type MemoryAction = { kind: "withdraw"; file; channelId } | { kind: "delete"; file } | { kind: "update"; file; text; channelId } | { kind: "ask"; file; text; approved: string | undefined }`
  - `compareHome(home: Map<string, string>, approved: Map<string, string>, questions: OpenQuestion[]): MemoryAction[]`

- [ ] **Step 1: Write the failing tests**

Create `tests/memory-compare.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { compareHome, type OpenQuestion } from "../src/memory-compare.js";

const A = "global-clot-a.md";
const B = "global-clot-b.md";
const map = (entries: [string, string][] = []) => new Map(entries);
const q = (file: string, text: string, channelId = `ch-${file}`): OpenQuestion => ({ file, text, channelId });

describe("compareHome, one row of the spec's table each", () => {
  it("same text as approved, no question: nothing", () => {
    expect(compareHome(map([[A, "v1"]]), map([[A, "v1"]]), [])).toEqual([]);
  });

  it("same text as approved, with a question: withdraws it", () => {
    expect(compareHome(map([[A, "v1"]]), map([[A, "v1"]]), [q(A, "v2")])).toEqual([{ kind: "withdraw", file: A, channelId: `ch-${A}` }]);
  });

  it("different text, no question: asks, about a new memory or a change", () => {
    expect(compareHome(map([[A, "v1"]]), map(), [])).toEqual([{ kind: "ask", file: A, text: "v1", approved: undefined }]);
    expect(compareHome(map([[A, "v2"]]), map([[A, "v1"]]), [])).toEqual([{ kind: "ask", file: A, text: "v2", approved: "v1" }]);
  });

  it("different text, with a question about other text: updates the question", () => {
    expect(compareHome(map([[A, "v3"]]), map([[A, "v1"]]), [q(A, "v2")])).toEqual([{ kind: "update", file: A, text: "v3", channelId: `ch-${A}` }]);
    expect(compareHome(map([[A, "v3"]]), map(), [q(A, "v2")])).toEqual([{ kind: "update", file: A, text: "v3", channelId: `ch-${A}` }]);
  });

  it("different text, with a question about this text: nothing", () => {
    expect(compareHome(map([[A, "v2"]]), map([[A, "v1"]]), [q(A, "v2")])).toEqual([]);
  });

  it("missing but approved: a deletion, and its question is withdrawn", () => {
    expect(compareHome(map(), map([[A, "v1"]]), [])).toEqual([{ kind: "delete", file: A }]);
    expect(compareHome(map(), map([[A, "v1"]]), [q(A, "v2")])).toEqual([
      { kind: "withdraw", file: A, channelId: `ch-${A}` },
      { kind: "delete", file: A },
    ]);
  });

  it("missing and never approved, with a question: withdraws it", () => {
    expect(compareHome(map(), map(), [q(A, "v1")])).toEqual([{ kind: "withdraw", file: A, channelId: `ch-${A}` }]);
  });
});

it("puts withdrawals first, then deletions, updates and questions, each in name order", () => {
  const actions = compareHome(
    map([
      [B, "new"],
      [A, "new"],
      ["global-clot-c.md", "v3"],
    ]),
    map([["global-clot-d.md", "x"]]),
    [q("global-clot-c.md", "v2"), q("global-clot-e.md", "gone")],
  );
  expect(actions.map((a) => `${a.kind} ${a.file}`)).toEqual([
    "withdraw global-clot-e.md",
    "delete global-clot-d.md",
    "update global-clot-c.md",
    `ask ${A}`,
    `ask ${B}`,
  ]);
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest run tests/memory-compare.test.ts`
Expected: FAIL, because `../src/memory-compare.js` does not exist.

- [ ] **Step 3: Write the module**

Create `src/memory-compare.ts`:

```ts
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
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `npx vitest run tests/memory-compare.test.ts`
Expected: PASS, 8 tests.

Run: `npm run typecheck`
Expected: no errors.

---

### Task 4: A Clot's memory folder, through `docker exec`

**Files:**
- Create: `src/agent/memory-folder.ts`
- Test: `tests/memory-folder.test.ts`

**Interfaces:**
- Consumes: `isGlobalFile` (Task 2); `containerName` from `src/agent/container.ts`.
- Produces, from `src/agent/memory-folder.ts`:
  - `memoryDir(cwd: string): string`
  - `interface FolderState { files: Map<string, string>; index: string | null }`
  - `interface FolderChange { put: Record<string, string>; remove: string[]; index?: string }`
  - `interface MemoryFolders { read(clot: string): Promise<FolderState | undefined>; write(clot: string, change: FolderChange): Promise<void> }`
  - `READ_SCRIPT`, `WRITE_SCRIPT` (strings); `parseRead(out: string): FolderState | undefined`; `encodeChange(change: FolderChange): string`
  - `class DockerMemoryFolders implements MemoryFolders`, `constructor(cwdOf: (clot: string) => string)`

- [ ] **Step 1: Write the failing tests**

Create `tests/memory-folder.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { encodeChange, memoryDir, parseRead } from "../src/agent/memory-folder.js";

const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64");

describe("memoryDir", () => {
  it("names the folder the way Claude Code does, from the directory a turn starts in", () => {
    expect(memoryDir("/workspace/repo")).toBe("/home/clot/.claude/projects/-workspace-repo/memory");
    expect(memoryDir("/workspace")).toBe("/home/clot/.claude/projects/-workspace/memory");
  });
});

describe("parseRead", () => {
  it("reads the global memories and the index", () => {
    const out = `F global-clot-a.md ${b64("Teal — the user's colour.\n")}\nF global-clot-b.md \nI - ${b64("- [A](global-clot-a.md)\n")}\n`;
    const state = parseRead(out)!;
    expect([...state.files]).toEqual([
      ["global-clot-a.md", "Teal — the user's colour.\n"],
      ["global-clot-b.md", ""],
    ]);
    expect(state.index).toBe("- [A](global-clot-a.md)\n");
  });

  it("gives no index when there is none, and nothing for a folder that does not exist", () => {
    expect(parseRead("")).toEqual({ files: new Map(), index: null });
    expect(parseRead("MISSING\n")).toBeUndefined();
  });

  it("leaves out a file whose name is not a global memory's", () => {
    expect(parseRead(`F global-clot-Odd.md ${b64("x")}\n`)!.files.size).toBe(0);
  });
});

describe("encodeChange", () => {
  it("writes, removes and re-indexes, one line each", () => {
    expect(encodeChange({ put: { "global-clot-a.md": "é\n" }, remove: ["global-clot-b.md"], index: "" })).toBe(`P global-clot-a.md ${b64("é\n")}\nR global-clot-b.md -\nI - \n`);
    expect(encodeChange({ put: {}, remove: [] })).toBe("");
  });

  it("refuses to touch a file that is not a global memory", () => {
    expect(() => encodeChange({ put: { "MEMORY.md": "x" }, remove: [] })).toThrow("not a global memory");
    expect(() => encodeChange({ put: {}, remove: ["../x.md"] })).toThrow("not a global memory");
  });
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest run tests/memory-folder.test.ts`
Expected: FAIL, because `../src/agent/memory-folder.js` does not exist.

- [ ] **Step 3: Write the module**

Create `src/agent/memory-folder.ts`:

```ts
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { isGlobalFile } from "../memory-index.js";
import { containerName } from "./container.js";

const run = promisify(execFile);

/** Where Claude Code keeps the auto memory of a session that starts in this directory. */
export function memoryDir(cwd: string): string {
  return `/home/clot/.claude/projects/${cwd.replace(/[^a-zA-Z0-9]/g, "-")}/memory`;
}

/** The global memories in one Clot's memory folder, and its index. */
export interface FolderState {
  /** File name to text, for every global memory in the folder. */
  files: Map<string, string>;
  /** `MEMORY.md`, or null when there is none. */
  index: string | null;
}

/** Files to write and remove in one Clot's memory folder, and its new index when that changes. */
export interface FolderChange {
  put: Record<string, string>;
  remove: string[];
  index?: string;
}

export interface MemoryFolders {
  /** Reads a Clot's global memories and index. Undefined when the folder does not exist; throws when it cannot be read. */
  read(clot: string): Promise<FolderState | undefined>;
  /** Writes, removes and re-indexes in one step, creating the folder when needed. Throws when it fails. */
  write(clot: string, change: FolderChange): Promise<void>;
}

/** Prints the folder as lines: `F <name> <base64>` for each global memory, `I - <base64>` for the index. */
export const READ_SCRIPT = `d="$1"
[ -d "$d" ] || { echo MISSING; exit 0; }
for f in "$d"/global-clot-*.md; do [ -f "$f" ] && echo "F $(basename "$f") $(base64 -w0 < "$f")"; done
[ -f "$d/MEMORY.md" ] && echo "I - $(base64 -w0 < "$d/MEMORY.md")"
exit 0`;

/** Reads lines from stdin: `P <name> <base64>` writes a file, `R <name> -` removes one, `I - <base64>` writes the index. */
export const WRITE_SCRIPT = `set -e
d="$1"
mkdir -p "$d"
while read -r op name data; do
  case "$op" in
    P) printf '%s' "$data" | base64 -d > "$d/.$name.tmp"; mv "$d/.$name.tmp" "$d/$name" ;;
    R) rm -f "$d/$name" ;;
    I) printf '%s' "$data" | base64 -d > "$d/.MEMORY.md.tmp"; mv "$d/.MEMORY.md.tmp" "$d/MEMORY.md" ;;
  esac
done`;

const decode = (data: string | undefined) => Buffer.from(data ?? "", "base64").toString("utf8");
const encode = (text: string) => Buffer.from(text, "utf8").toString("base64");

/** Reads what READ_SCRIPT printed. A file whose name is not a global memory's is left out. */
export function parseRead(out: string): FolderState | undefined {
  const lines = out.split("\n").filter((line) => line !== "");
  if (lines[0] === "MISSING") return undefined;
  const state: FolderState = { files: new Map(), index: null };
  for (const line of lines) {
    const [op, name, data] = line.split(" ");
    if (op === "F" && isGlobalFile(name)) state.files.set(name, decode(data));
    if (op === "I") state.index = decode(data);
  }
  return state;
}

/** The input for WRITE_SCRIPT. Refuses a name that is not a global memory's, so nothing else in the folder can be touched. */
export function encodeChange(change: FolderChange): string {
  const lines: string[] = [];
  for (const [name, text] of Object.entries(change.put)) {
    if (!isGlobalFile(name)) throw new Error(`not a global memory: ${name}`);
    lines.push(`P ${name} ${encode(text)}`);
  }
  for (const name of change.remove) {
    if (!isGlobalFile(name)) throw new Error(`not a global memory: ${name}`);
    lines.push(`R ${name} -`);
  }
  if (change.index !== undefined) lines.push(`I - ${encode(change.index)}`);
  return lines.map((line) => `${line}\n`).join("");
}

/** Runs a command with text on its stdin. Rejects when it exits with anything but 0. */
function runWithInput(args: string[], input: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, { stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`docker exited with ${code}: ${stderr.trim()}`))));
    child.stdin.end(input);
  });
}

/** Each Clot's memory folder, in its container, through `docker exec` as the container's own user. */
export class DockerMemoryFolders implements MemoryFolders {
  /** cwdOf gives the directory a Clot's turns start in, which names its memory folder. */
  constructor(private cwdOf: (clot: string) => string) {}

  async read(clot: string): Promise<FolderState | undefined> {
    const { stdout } = await run("docker", ["exec", containerName(clot), "sh", "-c", READ_SCRIPT, "sh", memoryDir(this.cwdOf(clot))], { maxBuffer: 64 * 1024 * 1024 });
    return parseRead(stdout);
  }

  async write(clot: string, change: FolderChange): Promise<void> {
    await runWithInput(["exec", "-i", containerName(clot), "sh", "-c", WRITE_SCRIPT, "sh", memoryDir(this.cwdOf(clot))], encodeChange(change));
  }
}
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `npx vitest run tests/memory-folder.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Round-trip a folder in a throwaway container**

```bash
docker rm -f clot-tryfolder 2>/dev/null; docker run -d --name clot-tryfolder clots-clot:dev
node --import tsx --input-type=module -e "
const { DockerMemoryFolders } = await import('./src/agent/memory-folder.ts');
const f = new DockerMemoryFolders(() => '/workspace/repo');
console.log('before:', await f.read('tryfolder'));
await f.write('tryfolder', { put: { 'global-clot-a.md': 'Teal — é\n\`\`\`x\n', 'global-clot-b.md': '' }, remove: [], index: '- [A](global-clot-a.md)\n' });
await f.write('tryfolder', { put: {}, remove: ['global-clot-b.md'] });
const s = await f.read('tryfolder');
console.log('after:', s);
console.log(s.files.get('global-clot-a.md') === 'Teal — é\n\`\`\`x\n' && !s.files.has('global-clot-b.md') && s.index === '- [A](global-clot-a.md)\n' ? 'FOLDER OK' : 'FOLDER FAILED');
"
docker rm -f clot-tryfolder
```

Expected: `before: undefined`, the folder printed with one file and the index, then `FOLDER OK`.

---

### Task 5: The store

**Files:**
- Modify: `src/store.ts`
- Test: `tests/store.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces, on `Store`:
  - `interface MemoryQuestionRow { file: string; text: string; channelId: string; channelName: string }`
  - `interface MemoryChangeRow { id: number; file: string; oldText: string | null; newText: string | null }`
  - `approvedMemories(): Map<string, string>` (file name order)
  - `applyMemoryChange(file: string, newText: string | null): void` (null removes; logs the text it replaced)
  - `lastMemoryChange(): MemoryChangeRow | undefined`; `undoMemoryChange(change: MemoryChangeRow): void`
  - `createMemoryQuestion(q: MemoryQuestionRow): void`; `memoryQuestions(): MemoryQuestionRow[]` (file name order); `memoryQuestionByChannel(channelId: string): MemoryQuestionRow | undefined`; `setMemoryQuestionText(file: string, text: string): void`; `deleteMemoryQuestion(file: string): boolean`
  - `addMemoryRestore(file: string): void`; `memoryRestores(): string[]`; `clearMemoryRestores(files: string[]): void`

- [ ] **Step 1: Write the failing tests**

In `tests/store.test.ts`:

**Replace**

```ts
    store.setInterrupted("s1", false);
    expect(store.activeSession("graphite")).toMatchObject({ interrupted: false, interruptedEvent: null });
  });
});
```

**With**

```ts
    store.setInterrupted("s1", false);
    expect(store.activeSession("graphite")).toMatchObject({ interrupted: false, interruptedEvent: null });
  });
});

describe("Store, global memory", () => {
  it("keeps the approved set, logs each change with what it replaced, and undoes the latest first", () => {
    const store = new Store(":memory:");
    store.applyMemoryChange("global-clot-b.md", "b1");
    store.applyMemoryChange("global-clot-a.md", "a1");
    store.applyMemoryChange("global-clot-a.md", "a2");
    store.applyMemoryChange("global-clot-b.md", null);
    expect([...store.approvedMemories()]).toEqual([["global-clot-a.md", "a2"]]);

    const deletion = store.lastMemoryChange()!;
    expect(deletion).toMatchObject({ file: "global-clot-b.md", oldText: "b1", newText: null });
    store.undoMemoryChange(deletion);
    const change = store.lastMemoryChange()!;
    expect(change).toMatchObject({ file: "global-clot-a.md", oldText: "a1", newText: "a2" });
    store.undoMemoryChange(change);
    expect([...store.approvedMemories()]).toEqual([
      ["global-clot-a.md", "a1"],
      ["global-clot-b.md", "b1"],
    ]);
    store.undoMemoryChange(store.lastMemoryChange()!);
    expect(store.lastMemoryChange()).toMatchObject({ file: "global-clot-b.md", oldText: null, newText: "b1" });
    store.undoMemoryChange(store.lastMemoryChange()!);
    expect(store.approvedMemories().size).toBe(0);
    expect(store.lastMemoryChange()).toBeUndefined();
  });

  it("keeps questions until they are closed, and closes each exactly once", () => {
    const store = new Store(":memory:");
    store.createMemoryQuestion({ file: "global-clot-b.md", text: "b", channelId: "ch-2", channelName: "home-memory-2" });
    store.createMemoryQuestion({ file: "global-clot-a.md", text: "a", channelId: "ch-1", channelName: "home-memory" });
    expect(store.memoryQuestions().map((q) => q.file)).toEqual(["global-clot-a.md", "global-clot-b.md"]);
    store.setMemoryQuestionText("global-clot-a.md", "a2");
    expect(store.memoryQuestionByChannel("ch-1")).toEqual({ file: "global-clot-a.md", text: "a2", channelId: "ch-1", channelName: "home-memory" });
    expect(store.deleteMemoryQuestion("global-clot-a.md")).toBe(true);
    expect(store.deleteMemoryQuestion("global-clot-a.md")).toBe(false);
    expect(store.memoryQuestionByChannel("ch-1")).toBeUndefined();
  });

  it("remembers which of the home Clot's copies are still to be put back", () => {
    const store = new Store(":memory:");
    store.addMemoryRestore("global-clot-b.md");
    store.addMemoryRestore("global-clot-a.md");
    store.addMemoryRestore("global-clot-a.md");
    expect(store.memoryRestores()).toEqual(["global-clot-a.md", "global-clot-b.md"]);
    store.clearMemoryRestores(["global-clot-a.md"]);
    expect(store.memoryRestores()).toEqual(["global-clot-b.md"]);
  });
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest run tests/store.test.ts`
Expected: FAIL in the three new tests, with `store.applyMemoryChange is not a function` and the like.

- [ ] **Step 3: Add the rows**

In `src/store.ts`:

**Replace**

```ts
/**
 * Where an event stands.
```

**With**

```ts
/** A question about a global memory, waiting for the user's answer in a temporary channel. */
export interface MemoryQuestionRow {
  file: string;
  /** The text the user is being asked about. */
  text: string;
  channelId: string;
  channelName: string;
}

/** A global memory change that spread: an approval or a deletion. Null text means the file was not there. */
export interface MemoryChangeRow {
  id: number;
  file: string;
  oldText: string | null;
  newText: string | null;
}

/**
 * Where an event stands.
```

- [ ] **Step 4: Add the tables**

In `src/store.ts`:

**Replace**

```ts
  url TEXT,
  PRIMARY KEY (event_id, rule)
);
`;
```

**With**

```ts
  url TEXT,
  PRIMARY KEY (event_id, rule)
);
CREATE TABLE IF NOT EXISTS global_memories (
  file TEXT PRIMARY KEY,
  text TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS memory_questions (
  file TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  channel_id TEXT NOT NULL UNIQUE,
  channel_name TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS memory_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file TEXT NOT NULL,
  old_text TEXT,
  new_text TEXT,
  undone INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS memory_restores (
  file TEXT PRIMARY KEY
);
`;
```

- [ ] **Step 5: Add the methods**

In `src/store.ts`:

**Replace**

```ts
  /** Withdraws a claim, when the message was definitely not sent. */
  releaseSend(eventId: string, rule: string): void {
    this.db.prepare("DELETE FROM sends WHERE event_id = ? AND rule = ?").run(eventId, rule);
  }
}
```

**With**

```ts
  /** Withdraws a claim, when the message was definitely not sent. */
  releaseSend(eventId: string, rule: string): void {
    this.db.prepare("DELETE FROM sends WHERE event_id = ? AND rule = ?").run(eventId, rule);
  }

  /** The global memories in force: file name to the text the user approved, in name order. */
  approvedMemories(): Map<string, string> {
    const rows: any[] = this.db.prepare("SELECT file, text FROM global_memories ORDER BY file").all();
    return new Map(rows.map((r) => [r.file, r.text]));
  }

  private setApprovedMemory(file: string, text: string | null): void {
    if (text === null) this.db.prepare("DELETE FROM global_memories WHERE file = ?").run(file);
    else this.db.prepare("INSERT INTO global_memories (file, text) VALUES (?, ?) ON CONFLICT(file) DO UPDATE SET text = excluded.text").run(file, text);
  }

  /** Puts a change in force and logs it for undo, all or nothing. Null text removes the memory. */
  applyMemoryChange(file: string, newText: string | null): void {
    this.db.transaction(() => {
      const oldText = this.approvedMemories().get(file) ?? null;
      this.setApprovedMemory(file, newText);
      this.db.prepare("INSERT INTO memory_changes (file, old_text, new_text) VALUES (?, ?, ?)").run(file, oldText, newText);
    })();
  }

  /** The most recent change that has not been undone. */
  lastMemoryChange(): MemoryChangeRow | undefined {
    const r: any = this.db.prepare("SELECT * FROM memory_changes WHERE undone = 0 ORDER BY id DESC LIMIT 1").get();
    return r && { id: r.id, file: r.file, oldText: r.old_text, newText: r.new_text };
  }

  /** Puts back what a change replaced and marks it undone, all or nothing. */
  undoMemoryChange(change: MemoryChangeRow): void {
    this.db.transaction(() => {
      this.setApprovedMemory(change.file, change.oldText);
      this.db.prepare("UPDATE memory_changes SET undone = 1 WHERE id = ?").run(change.id);
    })();
  }

  createMemoryQuestion(q: MemoryQuestionRow): void {
    this.db.prepare("INSERT INTO memory_questions (file, text, channel_id, channel_name) VALUES (?, ?, ?, ?)").run(q.file, q.text, q.channelId, q.channelName);
  }

  /** Open questions, in file name order. */
  memoryQuestions(): MemoryQuestionRow[] {
    const rows: any[] = this.db.prepare("SELECT * FROM memory_questions ORDER BY file").all();
    return rows.map((r) => ({ file: r.file, text: r.text, channelId: r.channel_id, channelName: r.channel_name }));
  }

  memoryQuestionByChannel(channelId: string): MemoryQuestionRow | undefined {
    return this.memoryQuestions().find((q) => q.channelId === channelId);
  }

  setMemoryQuestionText(file: string, text: string): void {
    this.db.prepare("UPDATE memory_questions SET text = ? WHERE file = ?").run(text, file);
  }

  /** Closes a question. Returns false when it was closed already: only the caller that gets true may carry out its outcome. */
  deleteMemoryQuestion(file: string): boolean {
    return this.db.prepare("DELETE FROM memory_questions WHERE file = ?").run(file).changes === 1;
  }

  /** Marks the home Clot's copy of a file to be put back to the approved text, or removed when there is none. */
  addMemoryRestore(file: string): void {
    this.db.prepare("INSERT OR IGNORE INTO memory_restores (file) VALUES (?)").run(file);
  }

  memoryRestores(): string[] {
    return this.db.prepare("SELECT file FROM memory_restores ORDER BY file").pluck().all() as string[];
  }

  clearMemoryRestores(files: string[]): void {
    const remove = this.db.prepare("DELETE FROM memory_restores WHERE file = ?");
    this.db.transaction(() => {
      for (const file of files) remove.run(file);
    })();
  }
}
```

- [ ] **Step 6: Run the tests to see them pass**

Run: `npx vitest run tests/store.test.ts`
Expected: PASS, every test in the file.

---

### Task 6: The channel name, the replies, `&memory`, and the prompts

**Files:**
- Modify: `src/chat/names.ts`, `src/events/reply.ts`, `src/commands.ts`, `src/agent/prompts.ts`
- Test: `tests/names.test.ts`, `tests/commands.test.ts`, `tests/prompts.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - from `src/chat/names.ts`: `memoryChannelName(project: string, existing: string[]): string`
  - from `src/events/reply.ts`: `MEMORY_REPLIES`, `MEMORY_RETRY` (strings)
  - from `src/commands.ts`: the `Command` member `{ kind: "memory"; undo: boolean }`
  - from `src/agent/prompts.ts`: `CLOT_SYSTEM_PROMPT` and `HOME_SYSTEM_PROMPT`, each with its own paragraph on global memories

- [ ] **Step 1: Write the failing tests**

In `tests/names.test.ts`:

**Replace**

```ts
import { askChannelName, ruleChannelName, sessionChannelName, splitMessage } from "../src/chat/names.js";
```

**With**

```ts
import { askChannelName, memoryChannelName, ruleChannelName, sessionChannelName, splitMessage } from "../src/chat/names.js";
```

**Replace**

```ts
  expect(ruleChannelName("graphite", ["graphite-rule", "graphite-rule-3"])).toBe("graphite-rule-2");
});
```

**With**

```ts
  expect(ruleChannelName("graphite", ["graphite-rule", "graphite-rule-3"])).toBe("graphite-rule-2");
});

it("names a global memory question's channel after the home Clot, with the lowest free number", () => {
  expect(memoryChannelName("home", [])).toBe("home-memory");
  expect(memoryChannelName("home", ["home-memory", "home-rule"])).toBe("home-memory-2");
});
```

In `tests/commands.test.ts`:

**Replace**

```ts
  expect(COMMAND_USAGE).toContain("`&rules undo`");
});
```

**With**

```ts
  expect(COMMAND_USAGE).toContain("`&rules undo`");
});

it("reads &memory and &memory undo, and nothing else after &memory", () => {
  expect(parseCommand("&memory")).toEqual({ kind: "memory", undo: false });
  expect(parseCommand(" &Memory Undo")).toEqual({ kind: "memory", undo: true });
  expect(parseCommand("&memory forget it")).toEqual({ kind: "invalid", name: "memory" });
  expect(COMMAND_USAGE).toContain("`&memory`, `&memory undo`");
});
```

In `tests/prompts.test.ts`:

**Replace**

```ts
    expect(HOME_SYSTEM_PROMPT).not.toContain("for this project");
  });
});
```

**With**

```ts
    expect(HOME_SYSTEM_PROMPT).not.toContain("for this project");
  });

  it("tell a project Clot to leave the global memories alone, and the home Clot how to keep them", () => {
    expect(CLOT_SYSTEM_PROMPT).toContain("Never edit, rename or remove a global-clot- file");
    expect(CLOT_SYSTEM_PROMPT).not.toContain("You also keep the user's global memories");
    expect(HOME_SYSTEM_PROMPT).toContain("You also keep the user's global memories");
    expect(HOME_SYSTEM_PROMPT).toContain("Do not add it to MEMORY.md");
    expect(HOME_SYSTEM_PROMPT).toContain("Deleting a global-clot- file removes it from every Clot at once.");
    expect(HOME_SYSTEM_PROMPT).not.toContain("Never edit, rename or remove a global-clot- file");
  });
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest run tests/names.test.ts tests/commands.test.ts tests/prompts.test.ts`
Expected: FAIL: `memoryChannelName is not a function`; `&memory` read as `{ kind: "invalid", name: "memory" }`; the prompts lack the new paragraphs.

- [ ] **Step 3: The channel name**

In `src/chat/names.ts`:

**Replace**

```ts
export function splitMessage(
```

**With**

```ts
/** The temporary channel in which the user is asked about a global memory: `home-memory`, then `-2`, `-3` while others are open. */
export function memoryChannelName(project: string, existing: string[]): string {
  return firstFree(`${slug(project)}-memory`, existing);
}

export function splitMessage(
```

- [ ] **Step 4: The replies**

In `src/events/reply.ts`:

**Replace**

```ts
export const RULE_RETRY = `I couldn't match that reply.\n\n${RULE_REPLIES}`;
```

**With**

```ts
export const RULE_RETRY = `I couldn't match that reply.\n\n${RULE_REPLIES}`;

export const MEMORY_REPLIES = [
  "Reply with one of:",
  "- `yes`, `sure`, `do that` or `yeah` to give it to every Clot",
  "- `no`, `dont` or `not at all` to decline it; the home Clot's copy is put back",
].join("\n");

export const MEMORY_RETRY = `I couldn't match that reply.\n\n${MEMORY_REPLIES}`;
```

- [ ] **Step 5: The command**

In `src/commands.ts`:

**Replace**

```ts
  | { kind: "rules"; undo: boolean }
  | { kind: "invalid"; name: string };

export const COMMAND_USAGE = "Commands: `&close`, `&close nosummary`, `&effort low|medium|high [message]`, `&rules`, `&rules undo`.";
```

**With**

```ts
  | { kind: "rules"; undo: boolean }
  | { kind: "memory"; undo: boolean }
  | { kind: "invalid"; name: string };

export const COMMAND_USAGE = "Commands: `&close`, `&close nosummary`, `&effort low|medium|high [message]`, `&rules`, `&rules undo`, `&memory`, `&memory undo`.";
```

**Replace**

```ts
  if (name === "rules") {
    if (args === "") return { kind: "rules", undo: false };
    if (args.toLowerCase() === "undo") return { kind: "rules", undo: true };
    return { kind: "invalid", name };
  }
```

**With**

```ts
  if (name === "rules" || name === "memory") {
    if (args === "") return { kind: name, undo: false };
    if (args.toLowerCase() === "undo") return { kind: name, undo: true };
    return { kind: "invalid", name };
  }
```

- [ ] **Step 6: The prompts**

In `src/agent/prompts.ts`:

**Replace**

```ts
export const CLOT_SYSTEM_PROMPT = CLOT_OPENING + SHARED_PROMPT;

/** For the home Clot, which serves what belongs to no project and has no repository of its own. */
export const HOME_SYSTEM_PROMPT = HOME_OPENING + SHARED_PROMPT;
```

**With**

```ts
const MEMORY_NOTE = `

Global memories are memory files named global-clot-<topic>.md. The user approved them through the home Clot, and they apply to every project. The daemon copies them into your memory folder and lists them in a block it keeps at the top of your MEMORY.md.
- Never edit, rename or remove a global-clot- file, never change that block, and never add index lines for them yourself. Anything you change there is put back before your next turn.
- If one seems wrong or out of date, tell the user.`;

const HOME_MEMORY_NOTE = `

You also keep the user's global memories: memory files named global-clot-<topic>.md (lowercase letters, digits and hyphens) in your memory folder. Once the user approves one, the daemon copies it into every other Clot's memory.
- Write one, in the usual memory format (front matter with name, description and type, then the text), when the user asks you to remember something for every project, or on your own when you learn something that clearly applies to all of their work: a preference, an account, a way of working. Never a fact about one project.
- Do not add it to MEMORY.md, and do not change the block the daemon keeps at the top of MEMORY.md: the daemon lists a global memory there once the user has said yes.
- The daemon asks the user before any other Clot gets a new or changed one. Say it is in force only when a note has told you the user approved it. If the user declines, the daemon puts your copy back.
- Deleting a global-clot- file removes it from every Clot at once.`;

export const CLOT_SYSTEM_PROMPT = CLOT_OPENING + SHARED_PROMPT + MEMORY_NOTE;

/** For the home Clot, which serves what belongs to no project, has no repository of its own, and keeps the global memories. */
export const HOME_SYSTEM_PROMPT = HOME_OPENING + SHARED_PROMPT + HOME_MEMORY_NOTE;
```

**Replace**

```ts
  /** What the daemon has to tell the Clot since its last turn: what became of its proposals. */
```

**With**

```ts
  /** What the daemon has to tell the Clot since its last turn: what became of its proposals, and changes to the global memories. */
```

- [ ] **Step 7: Run the tests to see them pass**

Run: `npx vitest run tests/names.test.ts tests/commands.test.ts tests/prompts.test.ts tests/agent-units.test.ts`
Expected: PASS.

Run: `npm run typecheck`
Expected: no errors. (`src/clot.ts` still compiles: until Task 8 a `&memory` command is simply not answered at once.)

---

### Task 7: The coordinator

**Files:**
- Create: `src/global-memory.ts`
- Test: `tests/global-memory.test.ts`

**Interfaces:**
- Consumes: `MemoryFolders`, `FolderState`, `FolderChange` (Task 4); `compareHome`, `MemoryAction` (Task 3); `frontMatter`, `indexLine`, `withGlobalBlock`, `BLOCK_START`, `BLOCK_END` (Task 2); the store methods of Task 5; `memoryChannelName`, `MEMORY_REPLIES`, `MEMORY_RETRY`, and `matchYesNo` from `src/events/reply.ts` (Task 6 and stage 2b); `ChatAdapter`, `InboundMessage`; `FakeChat` in tests.
- Produces, from `src/global-memory.ts`:
  - `interface GlobalMemoryDeps { store; chat; folders: MemoryFolders; home: string; clots: string[]; userId: string; max: number; say(clot, text): Promise<void>; isBusy(clot): boolean }`
  - `class GlobalMemory` with `beforeTurn(clot: string): Promise<void>`, `afterHomeTurn(): Promise<void>`, `onReply(m: InboundMessage): Promise<boolean>`, `closeOrphans(): Promise<void>`, `list(): string`, `undo(): Promise<string>`. `beforeTurn` and `afterHomeTurn` never reject.

- [ ] **Step 1: Write the failing tests**

Create `tests/global-memory.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import type { FolderChange, FolderState, MemoryFolders } from "../src/agent/memory-folder.js";
import type { InboundMessage } from "../src/chat/adapter.js";
import { FakeChat } from "../src/chat/fake.js";
import { GlobalMemory } from "../src/global-memory.js";
import { BLOCK_END, BLOCK_START } from "../src/memory-index.js";
import { Store } from "../src/store.js";

const USER = "user-1";
const DEPLOY = "global-clot-deploy-days.md";
const PET = "global-clot-pet.md";
const deployV1 = "---\nname: Deploy days\ndescription: when the user deploys\ntype: user\n---\n\nFridays only.\n";
const deployV2 = "---\nname: Deploy days\ndescription: when the user deploys\ntype: user\n---\n\nFridays and Mondays.\n";
const pet = "---\nname: Pet\ndescription: the user's pet\ntype: user\n---\n\nA ferret named Bolt.\n";
const deployLine = "- [Deploy days](global-clot-deploy-days.md) — when the user deploys";

class FakeFolders implements MemoryFolders {
  folders = new Map<string, FolderState>();
  failRead = new Set<string>();
  failWrite = new Set<string>();
  writes: { clot: string; change: FolderChange }[] = [];

  async read(clot: string): Promise<FolderState | undefined> {
    if (this.failRead.has(clot)) throw new Error("docker is not running");
    const folder = this.folders.get(clot);
    return folder && { files: new Map(folder.files), index: folder.index };
  }

  async write(clot: string, change: FolderChange): Promise<void> {
    if (this.failWrite.has(clot)) throw new Error("docker is not running");
    this.writes.push({ clot, change });
    const folder = this.folders.get(clot) ?? { files: new Map(), index: null };
    for (const [file, text] of Object.entries(change.put)) folder.files.set(file, text);
    for (const file of change.remove) folder.files.delete(file);
    if (change.index !== undefined) folder.index = change.index;
    this.folders.set(clot, folder);
  }

  /** What a Clot itself writes in its own folder. */
  put(clot: string, file: string, text: string): void {
    const folder = this.folders.get(clot) ?? { files: new Map(), index: null };
    folder.files.set(file, text);
    this.folders.set(clot, folder);
  }

  remove(clot: string, file: string): void {
    this.folders.get(clot)?.files.delete(file);
  }

  file(clot: string, file: string): string | undefined {
    return this.folders.get(clot)?.files.get(file);
  }

  index(clot: string): string | null | undefined {
    return this.folders.get(clot)?.index;
  }
}

let store: Store;
let chat: FakeChat;
let folders: FakeFolders;
let said: { clot: string; text: string }[];
let busy: Set<string>;
let memory: GlobalMemory;
let n: number;

function build(max = 3): GlobalMemory {
  return new GlobalMemory({
    store,
    chat,
    folders,
    home: "home",
    clots: ["home", "graphite", "widgets"],
    userId: USER,
    max,
    say: async (clot, text) => void said.push({ clot, text }),
    isBusy: (clot) => busy.has(clot),
  });
}

function reply(channelId: string, text: string, authorId = USER): InboundMessage {
  n += 1;
  return { id: `r${n}`, channelId, authorId, text, at: new Date(0) };
}

const questions = () => store.memoryQuestions();
const notes = (clot: string) => store.notes(clot).map((note) => note.text);

/** The home Clot writes a memory, its turn ends, and the user answers. */
async function approve(file: string, text: string): Promise<void> {
  folders.put("home", file, text);
  await memory.afterHomeTurn();
  const question = questions().find((q) => q.file === file)!;
  await memory.onReply(reply(question.channelId, "yes"));
}

beforeEach(async () => {
  store = new Store(":memory:");
  chat = new FakeChat();
  folders = new FakeFolders();
  said = [];
  busy = new Set();
  n = 0;
  const category = await chat.ensureCategory("home");
  store.upsertClot("home", category);
  store.createSession({ id: "s1", clot: "home", channelId: await chat.createChannel(category, "home-1410"), seed: null });
  folders.folders.set("home", { files: new Map(), index: null });
  memory = build();
});

describe("a new or changed global memory", () => {
  it("is asked about in a home-memory channel with its full text, and spreads nowhere yet", async () => {
    folders.put("home", DEPLOY, deployV1);
    await memory.afterHomeTurn();

    expect(questions()).toEqual([{ file: DEPLOY, text: deployV1, channelId: questions()[0].channelId, channelName: "home-memory" }]);
    const posted = chat.postsIn(questions()[0].channelId)[0];
    expect(posted).toContain("<@user-1> The home Clot wrote a new global memory, `global-clot-deploy-days.md`:");
    expect(posted).toContain("```md\n" + deployV1 + "\n```");
    expect(posted).toContain("`yes`, `sure`, `do that` or `yeah` to give it to every Clot");
    expect(store.approvedMemories().size).toBe(0);
    expect(notes("graphite")).toEqual([]);

    await memory.afterHomeTurn();
    expect(questions()).toHaveLength(1);
  });

  it("on a yes, is in force, reaches every Clot at its next turn with a note, and the channel goes", async () => {
    await approve(DEPLOY, deployV1);

    expect([...store.approvedMemories()]).toEqual([[DEPLOY, deployV1]]);
    expect(questions()).toEqual([]);
    expect(chat.deleted).toHaveLength(1);
    expect(said).toEqual([{ clot: "home", text: "Approved. Global memory Deploy days (`global-clot-deploy-days.md`) is in force for every Clot." }]);
    expect(notes("home")).toEqual(["The user approved the global memory Deploy days (global-clot-deploy-days.md). It is now in every Clot's memory."]);
    for (const clot of ["graphite", "widgets"]) expect(notes(clot)).toEqual(["A global memory was added: Deploy days (global-clot-deploy-days.md). It is listed in your MEMORY.md."]);

    await memory.beforeTurn("graphite");
    expect(folders.file("graphite", DEPLOY)).toBe(deployV1);
    expect(folders.index("graphite")).toBe(`${BLOCK_START}\n${deployLine}\n${BLOCK_END}\n`);
    expect(folders.file("widgets", DEPLOY)).toBeUndefined();
  });

  it("shows a change as the approved text and the new one", async () => {
    await approve(DEPLOY, deployV1);
    folders.put("home", DEPLOY, deployV2);
    await memory.afterHomeTurn();
    const posted = chat.postsIn(questions()[0].channelId)[0];
    expect(posted).toContain("changed the global memory `global-clot-deploy-days.md`. As it is now:");
    expect(posted.indexOf("Fridays only.")).toBeLessThan(posted.indexOf("Fridays and Mondays."));
  });

  it("breaks up a code fence in the text, so the question shows it as it is", async () => {
    folders.put("home", PET, "Run:\n```\nls\n```\n");
    await memory.afterHomeTurn();
    expect(chat.postsIn(questions()[0].channelId)[0]).toContain("Run:\n`​``\nls\n`​``\n");
  });

  it("on a no, puts the home Clot's copy back and tells it not to write it again", async () => {
    folders.put("home", DEPLOY, deployV1);
    await memory.afterHomeTurn();
    await memory.onReply(reply(questions()[0].channelId, "no"));

    expect(folders.file("home", DEPLOY)).toBeUndefined();
    expect(store.approvedMemories().size).toBe(0);
    expect(said).toEqual([{ clot: "home", text: "Declined: global memory Deploy days (`global-clot-deploy-days.md`)." }]);
    expect(notes("home")[0]).toBe("The user declined the global memory you wrote, Deploy days (global-clot-deploy-days.md). Your copy was removed. Do not write it again unless the user asks.");
    expect(notes("graphite")).toEqual([]);

    await approve(DEPLOY, deployV1);
    folders.put("home", DEPLOY, deployV2);
    await memory.afterHomeTurn();
    await memory.onReply(reply(questions()[0].channelId, "dont"));
    expect(folders.file("home", DEPLOY)).toBe(deployV1);
    expect(notes("home").at(-1)).toContain("Your copy was put back to the approved text.");
  });

  it("on a no during a home Clot turn, puts the copy back after that turn, and does not ask again", async () => {
    folders.put("home", DEPLOY, deployV1);
    await memory.afterHomeTurn();
    busy.add("home");
    await memory.onReply(reply(questions()[0].channelId, "no"));
    expect(folders.file("home", DEPLOY)).toBe(deployV1);

    busy.delete("home");
    await memory.afterHomeTurn();
    expect(folders.file("home", DEPLOY)).toBeUndefined();
    expect(questions()).toEqual([]);
  });

  it("asks about the newest text when the home Clot changes the file again before the answer", async () => {
    folders.put("home", DEPLOY, deployV1);
    await memory.afterHomeTurn();
    const channel = questions()[0].channelId;
    folders.put("home", DEPLOY, deployV2);
    await memory.afterHomeTurn();

    expect(questions()).toEqual([expect.objectContaining({ text: deployV2, channelId: channel })]);
    expect(chat.postsIn(channel).at(-1)).toContain("changed `global-clot-deploy-days.md` again. Your answer now applies to this text:");
    await memory.onReply(reply(channel, "yes"));
    expect(store.approvedMemories().get(DEPLOY)).toBe(deployV2);
  });

  it("keeps to the limit, and asks about the rest once a question closes", async () => {
    memory = build(2);
    folders.put("home", "global-clot-a.md", "a");
    folders.put("home", "global-clot-b.md", "b");
    folders.put("home", "global-clot-c.md", "c");
    await memory.afterHomeTurn();
    expect(questions().map((q) => q.file)).toEqual(["global-clot-a.md", "global-clot-b.md"]);

    await memory.onReply(reply(questions()[0].channelId, "yes"));
    await memory.afterHomeTurn();
    expect(questions().map((q) => q.file)).toEqual(["global-clot-b.md", "global-clot-c.md"]);
  });

  it("withdraws the question when the home Clot removes the file or puts it back", async () => {
    folders.put("home", DEPLOY, deployV1);
    await memory.afterHomeTurn();
    const channel = questions()[0].channelId;
    folders.remove("home", DEPLOY);
    await memory.afterHomeTurn();

    expect(questions()).toEqual([]);
    expect(chat.deleted).toEqual([channel]);
    expect(said.at(-1)!.text).toBe("Withdrawn: the question about global memory `global-clot-deploy-days.md`, which the home Clot has since removed or put back.");
    expect(store.approvedMemories().size).toBe(0);
  });

  it("is not asked about when the channel cannot be made, and is asked at the next check instead", async () => {
    folders.put("home", DEPLOY, deployV1);
    const create = chat.createChannel.bind(chat);
    chat.createChannel = async () => {
      throw new Error("Discord is down");
    };
    await memory.afterHomeTurn();
    expect(questions()).toEqual([]);

    chat.createChannel = create;
    await memory.afterHomeTurn();
    expect(questions()).toHaveLength(1);
  });

  it("stays open across a new home session and a daemon restart", async () => {
    folders.put("home", DEPLOY, deployV1);
    await memory.afterHomeTurn();
    const channel = questions()[0].channelId;
    store.createSession({ id: "s2", clot: "home", channelId: await chat.createChannel("cat-home", "home-1510"), seed: null });

    memory = build();
    await memory.closeOrphans();
    await memory.onReply(reply(channel, "yes"));
    expect(store.approvedMemories().get(DEPLOY)).toBe(deployV1);
  });

  it("is closed at startup when its channel is gone, and asked about again at the next check", async () => {
    folders.put("home", DEPLOY, deployV1);
    await memory.afterHomeTurn();
    await chat.deleteChannel(questions()[0].channelId);
    await memory.closeOrphans();
    expect(questions()).toEqual([]);
    await memory.afterHomeTurn();
    expect(questions()).toHaveLength(1);
  });
});

describe("answers", () => {
  it("repeat the question on any other reply, and ignore anyone but the user", async () => {
    folders.put("home", DEPLOY, deployV1);
    await memory.afterHomeTurn();
    const channel = questions()[0].channelId;
    expect(await memory.onReply(reply(channel, "yes", "someone-else"))).toBe(true);
    expect(await memory.onReply(reply(channel, "after"))).toBe(true);
    expect(chat.postsIn(channel).at(-1)).toContain("I couldn't match that reply.");
    expect(questions()).toHaveLength(1);
  });

  it("leave messages in other channels alone", async () => {
    expect(await memory.onReply(reply("somewhere-else", "yes"))).toBe(false);
  });

  it("stand: a second answer does nothing", async () => {
    folders.put("home", DEPLOY, deployV1);
    await memory.afterHomeTurn();
    const channel = questions()[0].channelId;
    await Promise.all([memory.onReply(reply(channel, "yes")), memory.onReply(reply(channel, "no"))]);
    expect(store.approvedMemories().get(DEPLOY)).toBe(deployV1);
    expect(said).toHaveLength(1);
  });
});

describe("a deletion", () => {
  it("is applied at once, everywhere, with notes and a line in the home channel", async () => {
    await approve(DEPLOY, deployV1);
    await memory.beforeTurn("graphite");
    folders.remove("home", DEPLOY);
    await memory.afterHomeTurn();

    expect(store.approvedMemories().size).toBe(0);
    expect(said.at(-1)!.text).toBe("Global memory removed from every Clot: Deploy days (`global-clot-deploy-days.md`). `&memory undo` brings it back.");
    expect(notes("graphite").at(-1)).toBe("The global memory Deploy days (global-clot-deploy-days.md) was removed. Stop acting on it.");

    await memory.beforeTurn("graphite");
    expect(folders.file("graphite", DEPLOY)).toBeUndefined();
    expect(folders.index("graphite")).toBe("");
  });

  it("is not taken from a missing folder: the approved files are written back into it", async () => {
    await approve(DEPLOY, deployV1);
    folders.folders.delete("home");
    await memory.afterHomeTurn();

    expect(store.approvedMemories().get(DEPLOY)).toBe(deployV1);
    expect(folders.file("home", DEPLOY)).toBe(deployV1);
    expect(folders.index("home")).toContain(deployLine);
  });
});

describe("syncing before a turn", () => {
  it("removes a global memory a project Clot wrote itself, and restores an edited block, keeping the Clot's own lines", async () => {
    await approve(DEPLOY, deployV1);
    folders.folders.set("graphite", {
      files: new Map([
        [PET, pet],
        [DEPLOY, "tampered"],
      ]),
      index: `- [Own](own.md) — mine\n${BLOCK_START}\n- [Tampered](x.md)\n${BLOCK_END}\n`,
    });
    await memory.beforeTurn("graphite");

    expect(folders.file("graphite", PET)).toBeUndefined();
    expect(folders.file("graphite", DEPLOY)).toBe(deployV1);
    expect(folders.index("graphite")).toBe(`${BLOCK_START}\n${deployLine}\n${BLOCK_END}\n- [Own](own.md) — mine\n`);
  });

  it("writes nothing when the folder is already up to date", async () => {
    await approve(DEPLOY, deployV1);
    await memory.beforeTurn("graphite");
    const writes = folders.writes.length;
    await memory.beforeTurn("graphite");
    expect(folders.writes).toHaveLength(writes);
  });

  it("leaves the home Clot's own changes alone and only keeps its block", async () => {
    await approve(DEPLOY, deployV1);
    folders.put("home", DEPLOY, deployV2);
    folders.put("home", PET, pet);
    await memory.beforeTurn("home");
    expect(folders.file("home", DEPLOY)).toBe(deployV2);
    expect(folders.file("home", PET)).toBe(pet);
    expect(folders.index("home")).toBe(`${BLOCK_START}\n${deployLine}\n${BLOCK_END}\n`);
  });

  it("never throws: a failed sync is tried again before the next turn", async () => {
    await approve(DEPLOY, deployV1);
    folders.failRead.add("graphite");
    await expect(memory.beforeTurn("graphite")).resolves.toBeUndefined();
    folders.failRead.delete("graphite");
    await memory.beforeTurn("graphite");
    expect(folders.file("graphite", DEPLOY)).toBe(deployV1);

    folders.failRead.add("home");
    await expect(memory.afterHomeTurn()).resolves.toBeUndefined();
  });
});

describe("&memory undo", () => {
  it("steps back through approvals, changes and deletions, putting the home Clot's copy back to match", async () => {
    await approve(DEPLOY, deployV1);
    await approve(DEPLOY, deployV2);
    folders.remove("home", DEPLOY);
    await memory.afterHomeTurn();

    expect(await memory.undo()).toBe("Undid the removal of global memory Deploy days (`global-clot-deploy-days.md`).");
    expect(store.approvedMemories().get(DEPLOY)).toBe(deployV2);
    expect(folders.file("home", DEPLOY)).toBe(deployV2);
    expect(notes("graphite").at(-1)).toBe("A global memory was added: Deploy days (global-clot-deploy-days.md). It is listed in your MEMORY.md.");
    expect(notes("home").at(-1)).toBe("The user undid the removal of global memory Deploy days (`global-clot-deploy-days.md`). Your copy was put back to match. Do not write it again unless the user asks.");

    expect(await memory.undo()).toBe("Undid the change to global memory Deploy days (`global-clot-deploy-days.md`).");
    expect(folders.file("home", DEPLOY)).toBe(deployV1);
    expect(await memory.undo()).toBe("Undid the addition of global memory Deploy days (`global-clot-deploy-days.md`).");
    expect(folders.file("home", DEPLOY)).toBeUndefined();
    expect(store.approvedMemories().size).toBe(0);
    expect(await memory.undo()).toBe("There is no global memory change left to undo.");

    await memory.afterHomeTurn();
    expect(questions()).toEqual([]);
    await memory.beforeTurn("graphite");
    expect(folders.file("graphite", DEPLOY)).toBeUndefined();
  });

  it("is refused while the file has an open question, and changes nothing", async () => {
    await approve(DEPLOY, deployV1);
    folders.put("home", DEPLOY, deployV2);
    await memory.afterHomeTurn();
    expect(await memory.undo()).toBe("`global-clot-deploy-days.md` has a question waiting for your answer. Answer it first, then undo.");
    expect(store.approvedMemories().get(DEPLOY)).toBe(deployV1);
    expect(folders.file("home", DEPLOY)).toBe(deployV2);
  });

  it("puts the home Clot's copy back only after a running turn", async () => {
    await approve(DEPLOY, deployV1);
    busy.add("home");
    await memory.undo();
    expect(folders.file("home", DEPLOY)).toBe(deployV1);
    busy.delete("home");
    await memory.afterHomeTurn();
    expect(folders.file("home", DEPLOY)).toBeUndefined();
    expect(questions()).toEqual([]);
  });
});

describe("&memory", () => {
  it("lists what is in force and what is waiting for an answer", async () => {
    expect(memory.list()).toBe("No global memories are in force.");
    await approve(DEPLOY, deployV1);
    folders.put("home", "global-clot-x.md", "No front matter.");
    await memory.afterHomeTurn();
    expect(memory.list()).toBe(
      [
        "Global memories in force:",
        "- Deploy days (`global-clot-deploy-days.md`): when the user deploys",
        "",
        "Waiting for your answer:",
        `- \`global-clot-x.md\` in <#${questions()[0].channelId}>`,
      ].join("\n"),
    );
  });
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest run tests/global-memory.test.ts`
Expected: FAIL, because `../src/global-memory.js` does not exist.

- [ ] **Step 3: Write the coordinator**

Create `src/global-memory.ts`:

```ts
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
      store.setMemoryQuestionText(action.file, action.text);
      await chat.post(action.channelId, `The home Clot changed \`${action.file}\` again. Your answer now applies to this text:\n\n${block(action.text)}\n\n${MEMORY_REPLIES}`).catch(() => undefined);
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
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `npx vitest run tests/global-memory.test.ts`
Expected: PASS, 25 tests.

Run: `npm run typecheck`
Expected: no errors.

---

### Task 8: The Clot: a sync before each turn, and `&memory`

**Files:**
- Modify: `src/clot.ts`
- Test: `tests/clot.test.ts`

**Interfaces:**
- Consumes: the `memory` command of Task 6.
- Produces, on `ClotDeps`:
  - `beforeTurn?: (clot: string) => Promise<void>`, awaited before each turn starts; a rejection is logged and the turn runs.
  - `memory?: { list(): string; undo(): Promise<string> }`, answering `&memory` and `&memory undo` at once.

- [ ] **Step 1: Write the failing tests**

In `tests/clot.test.ts`:

**Replace**

```ts
    expect(runner.calls[2].prompt).toBe("something unrelated");
  });
});
```

**With**

```ts
    expect(runner.calls[2].prompt).toBe("something unrelated");
  });
});

describe("Clot, global memory", () => {
  it("syncs its memory before every turn, a user's or an event's, and before the turn starts", async () => {
    const synced: { clot: string; calls: number }[] = [];
    extra = { beforeTurn: async (name) => void synced.push({ clot: name, calls: runner.calls.length }) };
    clot = build();
    await clot.init();

    await clot.onMessage(msg("one"));
    await clot.queueEvent(event("d-1"), "New issue.", false);
    await clot.onMessage(msg("two"));
    expect(synced).toEqual([
      { clot: "graphite", calls: 0 },
      { clot: "graphite", calls: 1 },
      { clot: "graphite", calls: 2 },
    ]);
  });

  it("still runs the turn when the sync fails", async () => {
    extra = {
      beforeTurn: async () => {
        throw new Error("docker is not running");
      },
    };
    clot = build();
    await clot.init();
    await clot.onMessage(msg("one"));
    expect(runner.calls).toHaveLength(1);
  });

  it("answers &memory and &memory undo at once, without the model, also while a turn runs", async () => {
    let undone = 0;
    extra = {
      memory: {
        list: () => "Global memories in force:",
        undo: async () => `Undid ${++undone}.`,
      },
    };
    clot = build();
    await clot.init();
    const channel = store.activeSession("graphite")!.channelId;

    await clot.onMessage(msg("&memory"));
    expect(chat.postsIn(channel).at(-1)).toBe("Global memories in force:");
    await clot.onMessage(msg("&memory undo"));
    expect(chat.postsIn(channel).at(-1)).toBe("Undid 1.");
    expect(runner.calls).toHaveLength(0);

    runner.script = [{ hold: true }];
    const first = clot.onMessage(msg("build the page"));
    await vi.waitFor(() => expect(runner.release).toBeDefined());
    await clot.onMessage(msg("&memory undo"));
    expect(chat.postsIn(channel).at(-1)).toBe("Undid 2.");
    expect(runner.pushes).toEqual([]);
    runner.release!();
    await first;
  });

  it("says so when there is no global memory", async () => {
    const channel = store.activeSession("graphite")!.channelId;
    await clot.onMessage(msg("&memory"));
    expect(chat.postsIn(channel).at(-1)).toBe("Global memory is not available.");
  });
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest run tests/clot.test.ts`
Expected: FAIL in three of the four new tests: no sync is recorded, and `&memory` goes to the model as a turn. The fourth, a turn that runs although its sync fails, passes already, since nothing syncs yet.

- [ ] **Step 3: The dependencies and the instant command**

In `src/clot.ts`:

**Replace**

```ts
  /** Called when a session has been replaced by a new one. */
  onSessionClosed?: (clot: string) => Promise<void>;
}

/** A command the daemon answers at once, without a turn and without the session. */
type InstantCommand = Extract<Command, { kind: "invalid" | "effort" | "rules" }>;

/** Returns the command when it is one answered at once; an `&effort` that carries a message is not. */
function instantCommand(command: Command): InstantCommand | undefined {
  return command.kind === "invalid" || command.kind === "rules" || (command.kind === "effort" && command.rest === "") ? command : undefined;
}
```

**With**

```ts
  /** Called when a session has been replaced by a new one. */
  onSessionClosed?: (clot: string) => Promise<void>;
  /** Called before each turn starts, when no turn of this Clot is running: brings its global memories up to date. */
  beforeTurn?: (clot: string) => Promise<void>;
  /** Answers `&memory` and `&memory undo`. */
  memory?: { list(): string; undo(): Promise<string> };
}

/** A command the daemon answers at once, without a turn and without the session. */
type InstantCommand = Extract<Command, { kind: "invalid" | "effort" | "rules" | "memory" }>;

/** Returns the command when it is one answered at once; an `&effort` that carries a message is not. */
function instantCommand(command: Command): InstantCommand | undefined {
  return command.kind === "invalid" || command.kind === "rules" || command.kind === "memory" || (command.kind === "effort" && command.rest === "") ? command : undefined;
}
```

- [ ] **Step 4: Answer `&memory`**

In `src/clot.ts`:

**Replace**

```ts
      await chat.post(channelId, rules === undefined ? "The rulebook is not available." : command.undo ? rules.undo(name) : rules.list(name));
    } else {
```

**With**

```ts
      await chat.post(channelId, rules === undefined ? "The rulebook is not available." : command.undo ? rules.undo(name) : rules.list(name));
    } else if (command.kind === "memory") {
      const memory = this.d.memory;
      await chat.post(channelId, memory === undefined ? "Global memory is not available." : command.undo ? await memory.undo() : memory.list());
    } else {
```

- [ ] **Step 5: Sync before the turn**

In `src/clot.ts`:

**Replace**

```ts
    const stopTyping = chat.startTyping(session.channelId);
    let result: TurnResult;
```

**With**

```ts
    const stopTyping = chat.startTyping(session.channelId);
    // Between turns, so the daemon never writes in the memory folder while the Clot may be writing there too.
    await this.d.beforeTurn?.(name).catch((error) => console.error(`[${name}] syncing global memories failed:`, error));
    let result: TurnResult;
```

- [ ] **Step 6: Run the tests to see them pass**

Run: `npx vitest run tests/clot.test.ts`
Expected: PASS, every test in the file.

---

### Task 9: Wiring, acceptance and commit

**Files:**
- Modify: `src/daemon.ts`, `.superpowers/specs/2026-10-14-clots-global-memory-design.md`, `.superpowers/specs/2026-10-10-clots-design.md`

**Interfaces:**
- Consumes: everything above.
- Produces: the running feature, and the pull request.

- [ ] **Step 1: Wire the coordinator into the daemon**

In `src/daemon.ts`:

**Replace**

```ts
import { containerName, ensureContainer, hasOwnLogin, sessionEnv } from "./agent/container.js";
```

**With**

```ts
import { containerName, ensureContainer, hasOwnLogin, sessionEnv } from "./agent/container.js";
import { DockerMemoryFolders } from "./agent/memory-folder.js";
```

**Replace**

```ts
import { inlineCommentReader } from "./events/review-comments.js";
import { SdkExplainer } from "./explainer.js";
```

**With**

```ts
import { inlineCommentReader } from "./events/review-comments.js";
import { SdkExplainer } from "./explainer.js";
import { GlobalMemory } from "./global-memory.js";
```

**Replace**

```ts
const toolDeps: ToolDeps = { rulebook, writer, proposals, store, senders: { github_comment: githubCommentSender(config.githubToken) }, say };

await chat.start((m) => {
  void (async () => {
    // A reply in a temporary channel is an answer to the daemon's question there, not a message for the Clot.
    if (await steering.onReply(m)) return;
    if (await proposals.onReply(m)) return;
```

**With**

```ts
const toolDeps: ToolDeps = { rulebook, writer, proposals, store, senders: { github_comment: githubCommentSender(config.githubToken) }, say };

const memory = new GlobalMemory({
  store,
  chat,
  // A Clot's memory folder is named after the directory its turns start in: the home Clot has no clone.
  folders: new DockerMemoryFolders((name) => (name === HOME_CLOT ? "/workspace" : "/workspace/repo")),
  home: HOME_CLOT,
  clots: names,
  userId: config.userId,
  max: config.maxProposals,
  say,
  isBusy: (name) => clots.get(name)?.isBusy() ?? false,
});

await chat.start((m) => {
  void (async () => {
    // A reply in a temporary channel is an answer to the daemon's question there, not a message for the Clot.
    if (await steering.onReply(m)) return;
    if (await proposals.onReply(m)) return;
    if (await memory.onReply(m)) return;
```

**Replace**

```ts
    // When no turn is running, a question about "the running turn" has lapsed.
    onTurnEnd: (name) => steering.lapse(name),
```

**With**

```ts
    // When no turn is running, a question about "the running turn" has lapsed. After the home Clot's
    // turns, and once at startup, its global memories are looked at.
    onTurnEnd: async (name) => {
      await steering.lapse(name);
      if (name === HOME_CLOT) await memory.afterHomeTurn();
    },
    beforeTurn: (name) => memory.beforeTurn(name),
    memory: { list: () => memory.list(), undo: () => memory.undo() },
```

**Replace**

```ts
// A proposal whose channel was removed while the daemon was down can no longer be answered.
await proposals.closeOrphans();
```

**With**

```ts
// A proposal whose channel was removed while the daemon was down can no longer be answered.
await proposals.closeOrphans();
// Nor can a question about a global memory; the home Clot's next turn asks it again.
await memory.closeOrphans();
```

Run: `npm run typecheck`
Expected: no errors.

Run: `npm test`
Expected: every test passes.

- [ ] **Step 2: Start the daemon**

The home Clot is already configured (`"home": true` in `clots.config.json`) from stage 2b. Start the daemon as a background process:

Run: `npm run daemon`
Expected: `[encryptify] ready`, `[home] ready`, then `[events] ready`. No `checking global memories failed` line.

- [ ] **Step 3: Live acceptance**

Go through these with the user. Each line is one item of section 12 of the spec. Stop at the first that fails, and fix it before going on. `ENC` below is `/home/clot/.claude/projects/-workspace-repo/memory` and `HOME` is `/home/clot/.claude/projects/-workspace/memory`.

0. **New sessions.** A session keeps the system prompt it was started with, also when resumed (section 8 of the spec), so the Clots' sessions from before this build know nothing of global memories. The user runs `&close` in the home Clot's channel and in `encryptify`'s, and removes any memory the home Clot saved about deploy days before, so the new session does not take it as remembered already.
1. **Asked.** In the home Clot's channel the user writes: "Remember for every project: I deploy on Fridays only." Expected: the home Clot writes `global-clot-…md`, and after its turn a `home-memory` channel appears with the file's full text and the accepted replies. The home Clot does not say the memory is in force.
2. **A reply that is not an answer.** Reply `maybe` in `home-memory`. Expected: the question is repeated.
3. **Yes.** Reply `yes`. Expected: `Approved. Global memory … is in force for every Clot.` in the home channel, and `home-memory` is deleted. In `encryptify`'s channel the user asks "When do I deploy?". Expected: "Fridays only", or the like. Then:
   `docker exec clot-encryptify sh -c 'ls ENC; head -5 ENC/MEMORY.md'` (with `ENC` filled in). Expected: the file, and `MEMORY.md` starting with the block.
4. **`&memory`.** In both channels. Expected: the memory listed with its description, and nothing waiting.
5. **No.** Ask the home Clot to remember for every project "I prefer tabs over spaces". Reply `no` in `home-memory`. Expected: `Declined: …`; `docker exec clot-home ls HOME` no longer shows that file; asked "what happened to the tabs memory?", the home Clot knows it was declined.
6. **A deletion and its undo.** Ask the home Clot to delete the Friday memory. Expected: `Global memory removed from every Clot: …` in the home channel at once. After `encryptify`'s next turn, its `ENC` no longer holds the file and the block is gone. Then `&memory undo` in either channel. Expected: `Undid the removal of …`; the file is back in `HOME` at once and in `ENC` after `encryptify`'s next turn.
7. **A project Clot's own changes are undone.** With the Friday memory in force:
   `docker exec clot-encryptify sh -c 'echo x > ENC/global-clot-hand.md; sed -i 2d ENC/MEMORY.md'` (the second line is the block's line for the Friday memory). Send `encryptify` any message. Expected: after that turn starts, `global-clot-hand.md` is gone and the block's line is back.
8. **A restart.** Ask the home Clot for another global memory, and leave its question open. Check that no turn is running, stop the daemon, confirm the `node` process is gone, and start it again. Expected: the `home-memory` channel is still there and `yes` still applies it.

Clean up afterwards: `&memory undo` until only what the user wants to keep is left.

- [ ] **Step 4: Mark the spec and the parent design**

In `.superpowers/specs/2026-10-14-clots-global-memory-design.md`:

**Replace**

```
Status: approved; not built yet.
```

**With**

```
Status: implemented.
```

In `.superpowers/specs/2026-10-10-clots-design.md`:

**Replace**

```
Status: approved in brainstorming. Stages 1, 2a and 2b are implemented; global
memory is next.
```

**With**

```
Status: approved in brainstorming. Stages 1, 2a and 2b and global memory are
implemented.
```

If anything was built differently from the spec or this plan, rewrite the section of each that describes it, as the design itself and with no note of the change.

- [ ] **Step 5: Commit and open the pull request**

Check that no turn is running, stop the daemon, and confirm the `node` process is gone.

Run: `npm test` and `npm run typecheck`
Expected: every test passes; no errors.

```bash
git add .superpowers src tests scripts
git status --short
```

Expected: only files this plan names, and nothing from `.env`, `data/` or `rulebook/`.

```bash
git commit -m "Global memory: shared memories through the home Clot"
git push -u origin global-memory
gh pr create --title "Global memory: shared memories through the home Clot" --body "Implements .superpowers/specs/2026-10-14-clots-global-memory-design.md by the plan in .superpowers/plans/2026-10-14-clots-global-memory.md."
```
