import { CLOT_NAME, CLOT_NAME_RULE, sameClot, slugOf } from "../clot-name.js";
import { HOME_CLOT } from "../config.js";
import type { ConfigStore } from "../config-store.js";
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

export interface CreatorDeps {
  config: ConfigStore;
  token: () => string;
  fetchFn?: typeof fetch;
  /** Clones, builds and starts the Clot, calling `step` as it goes. Rejects with the log of what failed. */
  start: (def: { name: string; repoUrl: string }, step: (s: "cloning" | "building" | "starting") => void) => Promise<void>;
  emit: (e: { clot: string; step: BuildStep; log?: string }) => void;
  /** Called when a Clot is up: puts its onboarding checklist in its chat. */
  onReady: (name: string, repo: string) => Promise<void>;
}

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
  readonly building = new Map<string, { step: BuildStep; log?: string; repo: string; icon?: ClotIconValue }>();

  constructor(private d: CreatorDeps) {}

  async validate(o: { name: string; repo: string }): Promise<Validation & { access?: RepoAccess }> {
    const errors: Validation["errors"] = {};
    const name = o.name.trim();
    if (!CLOT_NAME.test(name)) errors.name = CLOT_NAME_RULE;
    else if (RESERVED.includes(slugOf(name))) errors.name = `${name} is the daemon's own name.`;
    else if (this.d.config.current.clots.some((c) => sameClot(c.name, name)) || [...this.building.keys()].some((b) => sameClot(b, name))) errors.name = `There is a Clot named ${name} already.`;
    if (!isRepo(o.repo.trim())) errors.repo = "Write the repository as owner/name.";
    if (errors.name || errors.repo) return { ok: false, errors };
    const access = await checkRepoAccess({ token: this.d.token(), repo: o.repo.trim(), fetchFn: this.d.fetchFn });
    if (!access.ok) return { ok: false, errors: { repo: access.message }, ...(access.invite ? { invite: { login: access.login } } : {}), access };
    return { ok: true, errors: {}, accepted: access.accepted, access };
  }

  async create(o: { name: string; repo: string; icon?: ClotIconValue }): Promise<{ ok: true } | { ok: false; errors: Record<string, string> }> {
    const checked = await this.validate(o);
    if (!checked.ok) return { ok: false, errors: checked.errors as Record<string, string> };
    const name = o.name.trim();
    const repo = o.repo.trim();
    const repoUrl = `https://github.com/${repo}.git`;
    const entry = { name, repoUrl, about: `the project in the repository ${repo}`, ...(o.icon === undefined ? {} : { icon: o.icon }) };
    this.building.set(name, { step: "cloning", repo, icon: o.icon });
    const saved = await this.d.config.save({ clots: [...(this.d.config.json().clots as unknown[]), entry] });
    if (!saved.ok) {
      this.building.delete(name);
      return { ok: false, errors: saved.errors };
    }
    void this.run(name, repoUrl, repo);
    return { ok: true };
  }

  /** Tries a failed create again. */
  async retry(name: string): Promise<boolean> {
    const state = this.building.get(name);
    if (!state || state.step !== "failed") return false;
    this.building.delete(name);
    const result = await this.create({ name, repo: state.repo, icon: state.icon });
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
      // The name is free again: the entry goes, and a retry writes it anew.
      const current = this.d.config.json().clots as { name: string }[];
      await this.d.config.save({ clots: current.filter((c) => c.name !== name) }).catch(() => undefined);
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
