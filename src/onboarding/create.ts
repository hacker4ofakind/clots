import { CLOT_NAME, CLOT_NAME_RULE, sameClot, slugOf } from "../clot-name.js";
import { HOME_CLOT } from "../config.js";
import type { ConfigStore } from "../config-store.js";
import { repoSlug } from "../events/github.js";
import { isRepo } from "../github-api.js";
import { checkRepoAccess, type RepoAccess } from "./repo-access.js";

export { CLOT_NAME } from "../clot-name.js";
const RESERVED = [HOME_CLOT, "global"];

export interface ClotIconValue {
  phosphor?: string;
  color?: string;
  upload?: string;
}

export type BuildStep = "cloning" | "building" | "starting" | "done" | "failed";

export interface Validation {
  ok: boolean;
  errors: { name?: string; repo?: string };
  /** The machine account cannot reach the repository, and how to give it access. */
  invite?: { login?: string };
  accepted?: boolean;
}

/** The tools connected in New Clot's Tools step, whose entries wait for the Clot to exist. */
export interface HeldTools {
  /** The entries of these jobs, for this Clot, or why they cannot be used. Nothing is consumed yet. */
  claim(jobIds: string[], clot: string): { ok: true; entries: Record<string, unknown>[] } | { ok: false; error: string };
  /** The entries are in the configuration: the jobs are done. */
  committed(jobIds: string[]): void;
}

export interface CreatorDeps {
  config: ConfigStore;
  /** The jobs of connected services that wait for a Clot to be made. Absent when the daemon has no Composio. */
  tools?: HeldTools;
  token: () => string;
  fetchFn?: typeof fetch;
  /** Clones, builds and starts the Clot, calling `step` as it goes. Rejects with the log of what failed. */
  start: (def: { name: string; repoUrl: string }, step: (s: "cloning" | "building" | "starting") => void) => Promise<void>;
  emit: (e: { clot: string; step: BuildStep; log?: string }) => void;
  /** Called when a Clot is up: puts its onboarding checklist in its chat. */
  onReady: (name: string, repo: string) => Promise<void>;
  /**
   * Moves a running Clot to another repository: clones into a fresh workspace volume, swaps its container onto it and starts the Clot again,
   * calling `step` as it goes. Rejects with the log of what failed, leaving the Clot on its old workspace.
   */
  reclone?: (def: { name: string; repoUrl: string }, step: (s: "cloning" | "building" | "starting") => void, commit: () => Promise<void>) => Promise<void>;
  /** Why a Clot cannot be moved right now (a turn or a worker is running), or undefined when it can. */
  busy?: (name: string) => string | undefined;
}

type Building = { step: BuildStep; log?: string; repo: string; icon?: ClotIconValue; toolJobs?: string[]; tools?: Record<string, unknown>[]; kind?: "reclone" };

/** The text of a failed step, with the token taken out. */
export function scrub(log: string, secrets: string[]): string {
  let out = log;
  for (const secret of secrets.filter((s) => s.length >= 6)) out = out.split(secret).join("***");
  return out.replace(/(https:\/\/)[^@\s/]+@/g, "$1***@").slice(-4000);
}

/**
 * Creating a Clot from the UI: the name and repository are checked (free name, a valid container name, a repository the machine
 * account can reach, an invitation accepted when one is waiting), then the entry is written through the config store and the Clot is
 * cloned, built and started, with each step sent as it happens. A failure keeps its log, frees the name and can be retried.
 */
export class ClotCreator {
  /** Clots whose create is in progress or failed, with where they are. The reload handler skips them: they are started here, once. */
  readonly building = new Map<string, Building>();

  constructor(private d: CreatorDeps) {}

  async validate(o: { name: string; repo: string }): Promise<Validation & { access?: RepoAccess }> {
    const errors: Validation["errors"] = {};
    const name = o.name.trim();
    if (!CLOT_NAME.test(name)) errors.name = CLOT_NAME_RULE;
    else if (RESERVED.includes(slugOf(name))) errors.name = `${name} is the daemon's own name.`;
    // A create that failed has given its name back: only one that is still being built holds it.
    else if (this.d.config.current.clots.some((c) => sameClot(c.name, name)) || [...this.building].some(([b, state]) => state.step !== "failed" && sameClot(b, name))) errors.name = `There is a Clot named ${name} already.`;
    if (!isRepo(o.repo.trim())) errors.repo = "Write the repository as owner/name.";
    if (errors.name || errors.repo) return { ok: false, errors };
    const access = await checkRepoAccess({ token: this.d.token(), repo: o.repo.trim(), fetchFn: this.d.fetchFn });
    if (!access.ok) return { ok: false, errors: { repo: access.message }, ...(access.invite ? { invite: { login: access.login } } : {}), access };
    return { ok: true, errors: {}, accepted: access.accepted, access };
  }

  async create(o: { name: string; repo: string; icon?: ClotIconValue; toolJobs?: string[]; tools?: Record<string, unknown>[] }): Promise<{ ok: true } | { ok: false; errors: Record<string, string> }> {
    const checked = await this.validate(o);
    if (!checked.ok) return { ok: false, errors: checked.errors as Record<string, string> };
    const name = o.name.trim();
    const repo = o.repo.trim();
    const repoUrl = `https://github.com/${repo}.git`;
    const entry = { name, repoUrl, about: `the project in the repository ${repo}`, ...(o.icon === undefined ? {} : { icon: o.icon }) };
    // The tools connected before the Clot existed: their entries name the Clot, so they are written in the same save as the Clot's own,
    // and the configuration never holds one without the other. A retry after a failed build has them from the first try.
    let tools = o.tools;
    if (tools === undefined && o.toolJobs !== undefined && o.toolJobs.length > 0) {
      if (this.d.tools === undefined) return { ok: false, errors: { toolJobs: "Connecting services is not set up." } };
      const claimed = this.d.tools.claim(o.toolJobs, name);
      if (!claimed.ok) return { ok: false, errors: { toolJobs: claimed.error } };
      tools = claimed.entries;
    }
    this.building.set(name, { step: "cloning", repo, icon: o.icon, ...(o.toolJobs === undefined ? {} : { toolJobs: o.toolJobs }), ...(tools === undefined ? {} : { tools }) });
    const sources = (this.d.config.json().sources ?? {}) as { composio?: unknown[] };
    const saved = await this.d.config.save({
      clots: [...(this.d.config.json().clots as unknown[]), entry],
      ...(tools === undefined || tools.length === 0 ? {} : { sources: { ...sources, composio: [...(sources.composio ?? []), ...tools] } }),
    });
    if (!saved.ok) {
      this.building.delete(name);
      return { ok: false, errors: saved.errors };
    }
    if (o.toolJobs !== undefined && o.toolJobs.length > 0) this.d.tools?.committed(o.toolJobs);
    void this.run(name, repoUrl, repo);
    return { ok: true };
  }

  /** Where a build is now, for a page reloaded mid-build: the step and, for a failed one, its log. Undefined when none is kept. */
  buildOf(name: string): { step: BuildStep; log?: string } | undefined {
    const state = this.building.get(name);
    return state === undefined ? undefined : { step: state.step, ...(state.log === undefined ? {} : { log: state.log }) };
  }

  /** Whether the Clot is being made or moved right now: it cannot be deleted or moved again until that ends. */
  isBuilding(name: string): boolean {
    const state = this.building.get(name);
    return state !== undefined && state.step !== "failed";
  }

  /**
   * Edit on an existing Clot: another repository. The new one is checked as a new Clot's is, then the Clot is moved in the background
   * (progress as `clot.build` events). The configuration entry changes only once the move has worked; a move that fails leaves the Clot
   * on its old workspace and its entry as it was.
   */
  async changeRepo(name: string, repoInput: string, icon?: ClotIconValue): Promise<{ ok: true; moving: boolean } | { ok: false; status: 400 | 404 | 409 | 501; errors: Record<string, string> }> {
    const entry = this.d.config.current.clots.find((c) => c.name === name);
    if (entry === undefined) return { ok: false, status: 404, errors: { clot: "No such Clot." } };
    const repo = repoInput.trim();
    if (!isRepo(repo)) return { ok: false, status: 400, errors: { repo: "Write the repository as owner/name." } };
    if (repoSlug(entry.repoUrl)?.toLowerCase() === repo.toLowerCase()) return { ok: true, moving: false };
    if (this.d.reclone === undefined) return { ok: false, status: 501, errors: { repo: "Changing the repository is not set up." } };
    if (this.isBuilding(name)) return { ok: false, status: 409, errors: { repo: `${name} is being set up already. Wait for it to finish.` } };
    const busy = this.d.busy?.(name);
    if (busy !== undefined) return { ok: false, status: 409, errors: { repo: busy } };
    const access = await checkRepoAccess({ token: this.d.token(), repo, fetchFn: this.d.fetchFn });
    if (!access.ok) return { ok: false, status: 400, errors: { repo: access.message } };
    this.building.set(name, { step: "cloning", repo, kind: "reclone", ...(icon === undefined ? {} : { icon }) });
    void this.runReclone(name, repo);
    return { ok: true, moving: true };
  }

  private async runReclone(name: string, repo: string): Promise<void> {
    const state = this.building.get(name)!;
    const set = (step: BuildStep, log?: string) => {
      this.building.set(name, { ...this.building.get(name)!, step, ...(log === undefined ? {} : { log }) });
      this.d.emit({ clot: name, step, ...(log === undefined ? {} : { log }) });
    };
    set("cloning");
    try {
      // The entry is saved by `commit`, which the move calls once the Clot runs on its new workspace: a save that fails undoes the move.
      const commit = async () => {
        const entry = this.d.config.current.clots.find((c) => c.name === name)!;
        const currentAbout = `the project in the repository ${repoSlug(entry.repoUrl)}`;
        const clots = (this.d.config.json().clots as { name: string; about?: string }[]).map((c) =>
          c.name !== name ? c : { ...c, repoUrl: `https://github.com/${repo}.git`, ...(c.about === currentAbout ? { about: `the project in the repository ${repo}` } : {}), ...(state.icon === undefined ? {} : { icon: state.icon }) },
        );
        const saved = await this.d.config.save({ clots });
        if (!saved.ok) throw new Error(`its entry could not be saved: ${Object.values(saved.errors)[0]}`);
      };
      await this.d.reclone!({ name, repoUrl: `https://github.com/${repo}.git` }, (s) => set(s), commit);
      set("done");
      this.building.delete(name);
    } catch (error) {
      set("failed", scrub(error instanceof Error ? error.message : String(error), [this.d.token()]));
    }
  }

  /** Tries a failed create, or a failed move to another repository, again. */
  async retry(name: string): Promise<boolean> {
    const state = this.building.get(name);
    if (!state || state.step !== "failed") return false;
    this.building.delete(name);
    if (state.kind === "reclone") return (await this.changeRepo(name, state.repo, state.icon)).ok;
    const result = await this.create({ name, repo: state.repo, icon: state.icon, ...(state.tools === undefined ? {} : { tools: state.tools }), ...(state.toolJobs === undefined ? {} : { toolJobs: state.toolJobs }) });
    return result.ok;
  }

  private async run(name: string, repoUrl: string, repo: string): Promise<void> {
    const set = (step: BuildStep, log?: string) => {
      const state = this.building.get(name);
      if (state) this.building.set(name, { ...state, step, ...(log === undefined ? {} : { log }) });
      this.d.emit({ clot: name, step, ...(log === undefined ? {} : { log }) });
    };
    set("cloning");
    try {
      await this.d.start({ name, repoUrl }, (s) => set(s));
      set("done");
      this.building.delete(name);
      await this.d.onReady(name, repo).catch(() => undefined);
    } catch (error) {
      const log = scrub(error instanceof Error ? error.message : String(error), [this.d.token()]);
      // The name is free again: the entry goes, and a retry writes it anew. The tools bound to it go in the same save, since an entry
      // naming a Clot that is not there would not load; the retry has their entries from the failed build's record.
      const current = this.d.config.json().clots as { name: string }[];
      const sources = (this.d.config.json().sources ?? {}) as { composio?: { clot?: string }[] };
      const kept = (sources.composio ?? []).filter((e) => e.clot !== name);
      const dropTools = kept.length !== (sources.composio ?? []).length;
      await this.d.config.save({ clots: current.filter((c) => c.name !== name), ...(dropTools ? { sources: { ...sources, composio: kept } } : {}) }).catch(() => undefined);
      set("failed", log);
    }
  }
}

/**
 * The Clot's first message: one line, and the data the chat draws its setup checklist from. The checklist is a card that keeps
 * its steps up to date. The webhook's secret is never in the message (it would sit in the chat history and in a push preview):
 * the card asks the daemon for it when the user copies it.
 */
export function onboardingMessage(o: { name: string; repo: string; webhookUrl: string }): { text: string; data: { repo: string; webhookUrl: string } } {
  return { text: `${o.name} is ready. Three steps finish its setup.`, data: { repo: o.repo, webhookUrl: o.webhookUrl } };
}
