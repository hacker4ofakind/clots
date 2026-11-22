import type { DaemonTools } from "./tools.js";

/** A daemon tool's rating on the four axes (spec section 7). */
export interface Axes {
  /** Undoing it is free. */
  reversible: boolean;
  /** It reaches another person. */
  visibleToOthers: boolean;
  /** Dollars at stake. */
  priceAtStake: number;
  /** It accepts terms or makes a promise in the user's name. */
  commitsUser: boolean;
}

/** High on any one axis: the call becomes an ask instead of being carried out. */
export function isHigh(a: Axes): boolean {
  return !a.reversible || a.visibleToOthers || a.priceAtStake >= 5 || a.commitsUser;
}

const LOW: Axes = { reversible: true, visibleToOthers: false, priceAtStake: 0, commitsUser: false };
/** Lets the Clot, or a person, send to other people: a standing rule, an email, a merge. */
const REACHES_OTHERS: Axes = { reversible: false, visibleToOthers: true, priceAtStake: 0, commitsUser: false };

export type RatedTool = Exclude<keyof DaemonTools, "emailAccounts">;

/**
 * Every daemon tool's rating, in code: the model cannot argue an action down. A tool added without
 * a rating does not compile. A standing rule is rated for its set and remove actions; sending under
 * one the user approved is low.
 */
export const TOOL_AXES: Record<RatedTool, Axes> = {
  show: LOW,
  prefilter: LOW,
  guidance: LOW,
  standing: REACHES_OTHERS,
  send: LOW,
  routing: LOW,
  routeCorrect: LOW,
  emailDraft: LOW,
  emailSend: REACHES_OTHERS,
  calendarList: LOW,
  calendarWrite: LOW,
  calendarRemove: LOW,
  composioFind: LOW,
  // Rates each call itself, in code (see src/composio/rating.ts): a write that reaches people or moves money becomes an ask there, not here.
  composioRun: LOW,
  // The two that only read, and the two that rate nothing themselves: a draft's reads are counted like composio_run's, and a set recipe is a rulebook edit.
  composioToolkit: LOW,
  composioSamples: LOW,
  composioCheckEntry: LOW,
  composioRecipeTry: LOW,
  composioRecipe: LOW,
  mcpList: LOW,
  watchTry: LOW,
  watch: LOW,
  webhook: LOW,
  startSession: LOW,
  messageWorker: LOW,
  stopWorker: LOW,
  mergePullRequest: REACHES_OTHERS,
  // Each decides in code: a plain tunable is saved, any other key and every restart is put to the user.
  configGet: LOW,
  configSet: LOW,
  daemonRestart: LOW,
  handToHome: LOW,
  askChoice: LOW,
};
