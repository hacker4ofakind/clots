import type { Store } from "../store.js";
import type { Composio } from "./component.js";
import { LINEAR } from "./toolkits/linear.js";
import { NOTION } from "./toolkits/notion.js";

/** How a write is reversed, as stored with it: built by the table below from the write's own arguments, result and before-values, never from model text. */
export interface StoredInverse {
  slug: string;
  args: Record<string, unknown>;
  /** What undoing it does, for the reply: "archived the issue it created". */
  label: string;
  /** Read before reversing: an update is put back only if what it set is still there. `expect` maps a path in the read's answer to the value the write gave. */
  guard?: { read: { slug: string; args: Record<string, unknown> }; expect: Record<string, unknown> };
}

export interface Inverse {
  /** A read to run before the write, so that what it changes can be put back. */
  before?(args: Record<string, unknown>): { slug: string; args: Record<string, unknown> } | undefined;
  build(i: { args: Record<string, unknown>; result: unknown; before?: unknown }): StoredInverse | undefined;
}

/** The shallowest string `id` in a result, which is the ID of what a create made. */
export function findId(value: unknown): string | undefined {
  let level: unknown[] = [value];
  for (let depth = 0; depth < 4 && level.length > 0; depth++) {
    const next: unknown[] = [];
    for (const v of level) {
      if (typeof v !== "object" || v === null) continue;
      const id = (v as Record<string, unknown>).id;
      if (typeof id === "string" && id !== "") return id;
      next.push(...Object.values(v as Record<string, unknown>));
    }
    level = next;
  }
  return undefined;
}

const getPath = (value: unknown, path: string): unknown => path.split(".").reduce<unknown>((v, key) => (typeof v === "object" && v !== null ? (v as Record<string, unknown>)[key] : undefined), value);

/** Linear's update input, by field: where the issue has it, and whether it is an ID that cannot be put back to nothing. */
const LINEAR_FIELDS: Record<string, { path: string; id?: true; text?: true; noGuard?: true }> = {
  title: { path: "title", text: true },
  description: { path: "description", text: true },
  priority: { path: "priority" },
  estimate: { path: "estimate" },
  dueDate: { path: "dueDate", noGuard: true },
  stateId: { path: "state.id", id: true },
  assigneeId: { path: "assignee.id", id: true },
  projectId: { path: "project.id", id: true },
  parentId: { path: "parent.id", id: true },
  cycleId: { path: "cycle.id", id: true },
  teamId: { path: "team.id", id: true },
};

const linearIssue = (before: unknown): unknown => (before as { issue?: unknown } | undefined)?.issue;

/** The table: a slug, and how to reverse it. Anything not here has no undo. */
export const INVERSES: Record<string, Inverse> = {
  [LINEAR.createIssue]: {
    build: ({ result }) => {
      const id = findId(result);
      return id === undefined ? undefined : { slug: LINEAR.archiveIssue, args: { issue_id: id }, label: "archived the Linear issue it created" };
    },
  },
  [LINEAR.createComment]: {
    build: ({ result }) => {
      const id = findId(result);
      if (id === undefined) return undefined;
      // Linear's tools have no delete for a comment, so it is a fixed mutation, with only the ID filled in.
      return { slug: LINEAR.graphql, args: { query_or_mutation: "mutation DeleteComment($id: String!) { commentDelete(id: $id) { success } }", variables: { id } }, label: "deleted the Linear comment it made" };
    },
  },
  [LINEAR.updateIssue]: {
    before: (args) => (typeof args.issueId === "string" ? { slug: LINEAR.getIssue, args: { issue_id: args.issueId } } : undefined),
    build: ({ args, before }) => {
      const issue = linearIssue(before);
      const fields = Object.keys(args).filter((key) => key !== "issueId");
      if (issue === undefined || typeof args.issueId !== "string" || fields.length === 0 || fields.some((key) => LINEAR_FIELDS[key] === undefined)) return undefined;
      const restore: Record<string, unknown> = {};
      const expect: Record<string, unknown> = {};
      for (const key of fields) {
        const field = LINEAR_FIELDS[key];
        const was = getPath(issue, field.path);
        // What was empty cannot be set back to empty through the tool, except a description.
        if ((was === null || was === undefined) && !(key === "description")) return undefined;
        restore[key] = was ?? "";
        if (!field.noGuard) expect[field.path] = args[key];
      }
      return {
        slug: LINEAR.updateIssue,
        args: { issueId: args.issueId, ...restore },
        label: `put back ${fields.join(", ")} of the Linear issue`,
        guard: { read: { slug: LINEAR.getIssue, args: { issue_id: args.issueId } }, expect },
      };
    },
  },
  [NOTION.createPage]: {
    build: ({ result }) => {
      const id = findId(result);
      return id === undefined ? undefined : { slug: NOTION.archivePage, args: { page_id: id }, label: "archived the Notion page it created" };
    },
  },
};

export interface ComposioUndoDeps {
  composio: Composio;
  store: Store;
}

/** Answers `/composio undo`: reverses a Clot's newest write that has an inverse, one at a time per Clot. */
export class ComposioUndo {
  private chains = new Map<string, Promise<unknown>>();

  constructor(private d: ComposioUndoDeps) {}

  undo(clot: string): Promise<string> {
    const result = (this.chains.get(clot) ?? Promise.resolve()).then(() => this.undoOne(clot));
    this.chains.set(clot, result.catch(() => undefined));
    return result;
  }

  private async undoOne(clot: string): Promise<string> {
    const { store, composio } = this.d;
    const write = store.composio.latestUndoable(clot);
    // Claimed before anything is called, so two quick undos reverse it once.
    if (!write || !store.composio.claimUndo(write.id)) return "Nothing to undo.";
    const inverse = write.inverse as StoredInverse;
    const account = composio.account(write.account);
    if (!account) return `Not undone: the account ${write.account} is no longer in the configuration. It is skipped; send the command again to step further back.`;
    const again = (why: string) => {
      store.composio.releaseUndo(write.id);
      return `Not undone just now: ${why}. Nothing was changed; send the command again.`;
    };

    if (inverse.guard !== undefined) {
      const read = await composio.runChecked(account, inverse.guard.read.slug, inverse.guard.read.args);
      if (!read.ok) return read.reason === "refused" ? `Not undone: the object could not be read first (${read.error}). It is skipped; send the command again to step further back.` : again(read.error);
      const changed = Object.entries(inverse.guard.expect).filter(([path, value]) => getPath((read.data as { issue?: unknown })?.issue ?? read.data, path) !== value);
      if (changed.length > 0) return `Not put back: it changed since the Clot's write (${changed.map(([path]) => path).join(", ")}). It is skipped; send the command again to step further back.`;
    }

    const done = await composio.run(account, inverse.slug, inverse.args);
    if (done.ok) return `Undone (${write.account}): ${inverse.label}.`;
    if (done.reason === "unreachable" || done.reason === "cap") return again(done.error);
    return `Could not undo (${write.account}: ${inverse.label}): ${done.error}. It is skipped; send the command again to step further back.`;
  }
}
