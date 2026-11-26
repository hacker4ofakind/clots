import type { Applied } from "../config-store.js";
import type { Config } from "../config.js";
import { isBuiltinToolkit } from "../events/kinds.js";
import type { Composio } from "../composio/component.js";

export interface SourcesApplyDeps {
  /** The Composio component, or undefined when the daemon has no Composio key. */
  composio: Pick<Composio, "setAccounts"> | undefined;
  /** The entries the loader left out as unusable, `<toolkit>:<account>`. */
  skipped: () => string[];
  /** What else follows the list of Composio toolkits: the rulebook's reserved names, recipes that changed. Called with the new accounts. */
  onToolkits?: (accounts: Config["sources"]["composio"], change: { added: string[]; removed: string[]; changed: string[] }) => void;
  /** Built-in tools that were added or changed since the daemon started: their own handlers (enrichers, calendar feeds) still need a restart. */
  restartNeeded: Set<string>;
  /** The mail accounts are applied live by their own handler (`registerLiveConfig`): a change to them is not a restart. */
  emailLive?: boolean;
  log?: (text: string) => void;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const toolkitOf = (id: string) => id.split(":")[0]!;

/**
 * What a change to `sources` reaches live. A generic Composio toolkit is applied at once: the component takes the new account list, brings
 * each new account up (webhook path, connection, triggers) and takes a removed one's triggers away. What cannot be applied live is answered
 * as such, so the dialog and the settings page say "Restart the daemon to finish" only when it is true: a built-in toolkit (its enricher,
 * sender and calendar feed are set up once at startup) (the mail accounts apply live through their own handler when `emailLive` is set).
 */
export function sourcesApplier(d: SourcesApplyDeps): (next: Config, prev: Config) => Applied {
  return (next, prev): Applied => {
    let restart = d.emailLive !== true && !same(next.sources.email, prev.sources.email);
    if (d.composio === undefined) return { restart: restart || !same(next.sources.composio, prev.sources.composio) };
    const change = d.composio.setAccounts(next.sources.composio, d.skipped());
    d.onToolkits?.(next.sources.composio, change);
    for (const id of [...change.added, ...change.changed]) {
      if (!isBuiltinToolkit(toolkitOf(id))) continue;
      d.restartNeeded.add(id);
      restart = true;
    }
    for (const id of change.removed) {
      d.restartNeeded.delete(id);
      if (isBuiltinToolkit(toolkitOf(id))) restart = true;
    }
    if (change.added.length + change.removed.length + change.changed.length > 0) d.log?.(`[integrations] Composio accounts: +${change.added.length} -${change.removed.length} ~${change.changed.length}${restart ? " (a restart finishes the built-in ones)" : ""}`);
    return { restart };
  };
}
