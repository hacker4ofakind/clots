import type { Applied, ConfigStore } from "./config-store.js";
import type { Config, McpServer } from "./config.js";

/**
 * What each top-level key of `clots.config.json` does when it changes, and which keys cannot do it live. A key listed here applies at
 * once; a key listed in `RESTART_KEYS` (config-store.ts) is read once at startup; a key that is in neither is reported as needing a
 * restart by the store, never silently ignored. The table of why is in `.superpowers/handoffs/4a-C-daemon-notes.md`.
 */
export interface LiveTargets {
  /** The workers' limit of live turns. */
  maxWorkers(limit: number): void;
  /** The share of the context window at which a session rolls over. */
  rolloverPercent(percent: number): void;
  /** The user's zone: the gates, the spend week, the workers' wording, every Clot, the calendars and the draft notes. */
  timeZone(zone: string): void;
  /** The windows in which the Clots step back. */
  gates(gates: Config["gates"]): void;
  /** The periodic read of the claude.ai connectors. */
  sweep(sweep: Config["sweep"]): void;
  /** The weekly spend warning. */
  spend(spend: Config["spend"]): void;
  /** How long automated events are held. */
  hold(hold: Config["hold"]): void;
  /** The mail accounts: new ones connect, changed ones reconnect, removed ones disconnect. */
  email(accounts: Config["sources"]["email"]): Promise<void>;
  /** The MCP servers: new ones connect, changed ones reconnect, removed ones are closed. */
  mcpServers(next: Config["mcpServers"], prev: Config["mcpServers"]): Promise<void>;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Registers the apply handler of every key that can be applied live. `askTimeoutMinutes` and `maxProposals` are read at the moment of use. */
export function registerLiveConfig(store: Pick<ConfigStore, "onChange">, t: LiveTargets): void {
  // Read from the configuration at the moment they are used (the ask's deadline, the proposal cap): nothing to do, but the key is live.
  store.onChange(["askTimeoutMinutes", "maxProposals"], () => undefined);
  store.onChange(["maxWorkers"], (next) => t.maxWorkers(next.maxWorkers));
  store.onChange(["rolloverPercent"], (next) => t.rolloverPercent(next.rolloverPercent));
  store.onChange(["timeZone"], (next) => t.timeZone(next.timeZone));
  store.onChange(["gates"], (next) => t.gates(next.gates));
  store.onChange(["sweep"], (next) => t.sweep(next.sweep));
  store.onChange(["spend"], (next) => t.spend(next.spend));
  store.onChange(["hold"], (next) => t.hold(next.hold));
  store.onChange(["mcpServers"], (next, prev) => t.mcpServers(next.mcpServers, prev.mcpServers));
  // `sources` is shared with the Composio handler: this part is the mail accounts.
  store.onChange(["sources"], (next, prev): Applied | Promise<Applied> => {
    if (same(next.sources.email, prev.sources.email)) return;
    return t.email(next.sources.email).then(() => undefined);
  });
}

/** What changed between two lists of Clots, for the handler that starts and stops them. */
export function diffClots(prev: Config["clots"], next: Config["clots"]): { added: string[]; removed: string[]; testCommandChanged: string[]; repoChanged: string[] } {
  const before = new Map(prev.map((c) => [c.name, c]));
  const after = new Map(next.map((c) => [c.name, c]));
  const both = [...after.values()].filter((c) => before.has(c.name));
  return {
    added: [...after.keys()].filter((n) => !before.has(n)),
    removed: [...before.keys()].filter((n) => !after.has(n)),
    testCommandChanged: both.filter((c) => before.get(c.name)!.testCommand !== c.testCommand).map((c) => c.name),
    repoChanged: both.filter((c) => before.get(c.name)!.repoUrl !== c.repoUrl).map((c) => c.name),
  };
}

/** What changed between two sets of MCP servers: a server whose definition changed is reconnected. */
export function diffServers(prev: Record<string, McpServer>, next: Record<string, McpServer>): { added: string[]; removed: string[]; changed: string[] } {
  return {
    added: Object.keys(next).filter((n) => !(n in prev)),
    removed: Object.keys(prev).filter((n) => !(n in next)),
    changed: Object.keys(next).filter((n) => n in prev && !same(prev[n], next[n])),
  };
}
