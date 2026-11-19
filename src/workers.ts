import { CONTINUE_TEXT, homeWorkerSystemPrompt, workerSystemPrompt } from "./agent/prompts.js";
import type { AgentRunner, TurnHandle, TurnResult } from "./agent/runner.js";
import { describeGate, type GateState } from "./gates.js";
import { modelLabel, WORKER_MODELS } from "./models.js";
import type { BookArgs } from "./spend.js";
import type { Store, WorkerRow } from "./store.js";
import type { Effort, TurnActivity, WorkerModel } from "./types.js";
import { FROM_MAIN, prLink, ReportBuffer, workerBranch, workerPrompt } from "./worker-turn.js";

const MINUTE = 60_000;
const PROGRESS_MS = 20 * MINUTE;
const TIME_LIMIT_MS = 90 * MINUTE;
const RETRY_MS = [1 * MINUTE, 5 * MINUTE, 15 * MINUTE];
const RESTART_PACE_MS = 30_000;
const IDLE_EXPIRY_MS = 7 * 24 * 60 * MINUTE;
const HOUR = 60 * MINUTE;
const MAX_LISTED = 20;
/** The state key that keeps the usage limit's reset, in Unix milliseconds, across a restart. */
const PAUSE_KEY = "workers-paused-until";
const MAX_BRIEF = 20_000;
const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh"];

export interface WorkersDeps {
  store: Store;
  /** The Clot's SdkRunner. */
  runnerFor(clot: string): AgentRunner;
  /** The worktree steps in a Clot's container (container.ts), injectable for tests. */
  container: {
    defaultBranch(clot: string): Promise<string>;
    addWorktree(clot: string, o: { workerId: string; branch: string | null; base: string | null }): Promise<string>;
    removeWorktree(clot: string, path: string): Promise<void>;
    worktreeExists(clot: string, path: string): Promise<boolean>;
    sessionExists(clot: string, sessionId: string): Promise<boolean>;
  };
  /** The pull requests GitHub has for a branch. Absent in tests that do not need it. */
  prsForBranch?(clot: string, branch: string, repo: string): Promise<{ number: number; url: string; state: string; isCrossRepository?: boolean }[]>;
  /** Whether the Clot is in the configuration. A queued worker of a removed Clot waits. */
  knows(clot: string): boolean;
  /** The Clot's repository as owner/name, lowercased, or null for the home Clot. */
  repoOf(clot: string): string | null;
  limit: number;
  now: () => number;
  newId: () => string;
  /** Four hex digits for a branch name. */
  random: () => string;
  /** A repeating timer; returns its cancel. */
  every(ms: number, fn: () => void): () => void;
  /** A one-off timer; returns its cancel. */
  after(ms: number, fn: () => void): () => void;
  /** Starts the Clot's drain, so a row stored for its main session runs. */
  kick(clot: string): void;
  /** Pauses the Clot until the usage limit resets, posting the notice in its channel. */
  pause(clot: string, resetsAt: number): Promise<void>;
  /** Posts in the Clot's live channel. Never throws. */
  say(clot: string, text: string): Promise<void>;
  postActivity(clot: string, activity: TurnActivity): Promise<void>;
  /** What the scarce and lead-in gates say now. Absent: no gate. */
  gate?: () => GateState;
  timeZone?: string;
  /** The spend log: books a worker turn's cost. */
  book?: (a: BookArgs) => Promise<void>;
}

/** A live turn, from the moment it takes a place. The handle is set once the worktree is ready. */
interface Slot {
  handle?: TurnHandle;
  done?: Promise<unknown>;
  place: number;
  buffer: ReportBuffer;
  lastStep: string | null;
  timedOut: boolean;
  cancel: (() => void)[];
}

/**
 * Owns every worker: its row, its worktree, its turns, the limit of live turns across the daemon,
 * and the lines it posts. The main session's tools and GitHub's pull request events call into it,
 * and what a worker reports goes back to the main session as an inbox row.
 */
export class Workers {
  private live = new Map<string, Slot>();
  private ready = false;
  private dispatching = false;
  private again = false;
  /** Unix milliseconds until which no worker turn starts: the account's usage limit. */
  private pausedUntil: number | null = null;
  private cancelWake?: () => void;
  /** After a restart, starts are spaced out until the queue has emptied once. */
  private pacing = false;
  private nextStartAt = 0;
  private paceTimer?: () => void;

  constructor(private d: WorkersDeps) {}

  /** The main session's start_session. Returns the text the tool gives back. */
  async start(clot: string, a: { title: string; brief: string; model: WorkerModel; effort: Effort; urgent: boolean; gateOk: boolean; outsider?: boolean }): Promise<string> {
    const { store } = this.d;
    const title = a.title.trim();
    if (title.length < 3 || title.length > 80) return "Refused: the title must be 3 to 80 characters.";
    if (a.brief.trim() === "" || a.brief.length > MAX_BRIEF) return `Refused: the brief must be given, and at most ${MAX_BRIEF} characters.`;
    if (!(a.model in WORKER_MODELS) || !EFFORTS.includes(a.effort)) return "Refused: the model is opus, sonnet or haiku, and the effort low, medium, high or xhigh.";
    if (a.model === "haiku" && (a.effort === "high" || a.effort === "xhigh")) return "Refused: Haiku is not run at high. Use sonnet at high.";
    if (store.listedWorkers(clot).length >= MAX_LISTED) return `Refused: ${clot} already has ${MAX_LISTED} workers listed. Stop one first.`;

    const id = this.d.newId();
    const home = this.d.repoOf(clot) === null;
    const branch = workerBranch(title, this.d.random);
    store.createWorker({ id, clot, title, brief: a.brief, model: a.model, effort: a.effort, branch, base: null, worktree: home ? `/workspace/workers/${id}` : `/workspace/worktrees/${id}`, urgent: a.urgent, gateOk: a.gateOk, outsider: a.outsider === true });
    store.queueWorker(id);
    const label = modelLabel(a.model, a.effort);
    const short = shortId(id);

    // Under a gate a worker the daemon did not mark as allowed waits in the queue until the gate lifts.
    if (this.heldByGate(store.getWorker(id)!)) {
      const why = describeGate(this.gate(), this.d.timeZone ?? "UTC", this.d.now());
      await this.d.say(clot, `Queued: ${title} (${label}). Usage is tight (${why}); it starts when that lifts.`);
      return `Queued worker ${short} on branch ${branch}: usage is tight (${why}). It starts when that lifts.`;
    }
    if (this.canStartNow()) {
      const failure = await this.begin(store.getWorker(id)!);
      if (failure !== undefined) return `Not started: ${failure}.`;
      return `Started worker ${short} on branch ${branch}. Its report reaches you as a turn of its own.`;
    }
    await this.d.say(clot, `Queued: ${title} (${label}). ${this.live.size} workers are already running; it starts when one finishes.`);
    return `Queued worker ${short} on branch ${branch}: ${this.live.size} workers are running. It starts when a place is free.`;
  }

  /** The main session's message_worker. A message from an outsider's turn marks the worker as an outsider's for good. */
  async message(clot: string, id: string, text: string, outsider = false): Promise<string> {
    const w = this.find(clot, id);
    if (typeof w === "string") return w;
    if (w.status !== "queued" && w.status !== "running" && w.status !== "idle") return `Refused: worker ${shortId(w.id)} is ${w.status}; start a new one instead.`;
    if (outsider && !w.outsider) this.d.store.setWorker(w.id, { outsider: true });
    const handle = this.live.get(w.id)?.handle;
    if (handle?.push(`${FROM_MAIN}\n${text}`)) return `Delivered to worker ${shortId(w.id)}, into its running turn.`;
    this.d.store.addWorkerMessage(w.id, text);
    if (this.d.store.getWorker(w.id)!.status === "idle") {
      this.d.store.queueWorker(w.id);
      this.dispatch();
    }
    return `Sent to worker ${shortId(w.id)}. It reads it at the start of its next turn.`;
  }

  /** The main session's stop_worker. Its branch and pull request stay. */
  async stop(clot: string, id: string): Promise<string> {
    const w = this.find(clot, id);
    if (typeof w === "string") return w;
    if (w.status === "stopped" || w.status === "closed") return `Worker ${shortId(w.id)} is already ${w.status}.`;
    // Set first: the turn's end must not overwrite it.
    this.d.store.setWorker(w.id, { status: "stopped" });
    await this.endLive(w.id);
    await this.d.container.removeWorktree(w.clot, w.worktree).catch((error) => console.error(`[${w.clot}] removing worker ${w.id}'s worktree failed:`, error));
    await this.d.say(w.clot, `Stopped: ${w.title}`);
    this.dispatch();
    return `Stopped worker ${shortId(w.id)}. Its branch${w.prUrl ? " and pull request stay" : " stays"}.`;
  }

  /** A worker's ask_main. */
  askMain(id: string, question: string): string {
    this.d.store.setWorker(id, { asked: question });
    return "Asked. End your turn now; the answer arrives as your next message.";
  }

  /** A pull request opened or closed on GitHub. Ignores one from a fork, and branches no worker has. */
  async onPullRequest(a: { repo: string; branch: string; headRepo: string; number: number; url: string; action: "opened" | "closed" | "synchronize" }): Promise<void> {
    const repo = a.repo.toLowerCase();
    if (a.headRepo.toLowerCase() !== repo) return;
    const w = this.workerOnBranch(repo, a.branch);
    if (!w) return;
    if (a.action === "opened") this.d.store.setWorker(w.id, { prNumber: a.number, prUrl: a.url, prRepo: repo });
    else if (a.action === "closed") await this.close(w, `Worker ${shortId(w.id)} "${w.title}": its pull request was merged or closed, and its worktree removed.`);
  }

  /** The account's usage limit was reached, by a worker or a main session. resetsAt is in Unix seconds. */
  onLimit(resetsAt: number): void {
    const until = resetsAt * 1000;
    if (this.pausedUntil !== null && this.pausedUntil >= until) return;
    this.pausedUntil = until;
    // Kept, so a restart before the reset still waits for it.
    this.d.store.setState(PAUSE_KEY, String(until));
    this.setWake(until);
  }

  private setWake(until: number): void {
    this.cancelWake?.();
    this.cancelWake = this.d.after(Math.max(0, until - this.d.now()), () => this.resumeAfterLimit());
  }

  /**
   * Database only, before the Clots start: their first turns can start workers. Every worker that
   * was waiting goes back in the queue: one cut off by a restart or by the usage limit, one waiting
   * to retry a turn that failed to start, one with messages. A pause still in force holds them back.
   */
  recover(): void {
    const { store } = this.d;
    const paused = Number(store.getState(PAUSE_KEY) ?? "0");
    if (paused > this.d.now()) this.pausedUntil = paused;
    for (const w of store.workersWithStatus("running")) {
      store.setWorker(w.id, { interrupted: true });
      store.queueWorker(w.id);
    }
    for (const w of store.workersWithStatus("idle")) {
      if (store.hasWorkerMessages(w.id) || w.interrupted || w.retries > 0) store.queueWorker(w.id);
    }
  }

  /** After the Clots have started: drops workers whose worktree is gone, checks GitHub, then starts the queue. */
  async startUp(): Promise<void> {
    const { store } = this.d;
    for (const w of [...store.workersWithStatus("queued"), ...store.workersWithStatus("idle")]) {
      if (!this.d.knows(w.clot) || !this.hasPlace(w)) continue;
      if (await this.d.container.worktreeExists(w.clot, w.worktree)) continue;
      store.setWorker(w.id, { status: "failed", failure: "its worktree is gone" });
      store.addNote(w.clot, `Worker ${shortId(w.id)} "${w.title}" could not be resumed: its worktree is gone. Its branch is kept.`);
    }
    await this.reconcile();
    if (this.pausedUntil !== null) this.setWake(this.pausedUntil);
    this.d.every(HOUR, () => void this.reconcile().then(() => this.expire()));
    this.ready = true;
    this.pacing = true;
    this.dispatch();
  }

  /** One line per listed worker, for the main session's prompt. */
  lines(clot: string): string[] {
    return this.d.store
      .listedWorkers(clot)
      .map((w) => `- ${shortId(w.id)} "${w.title}": ${w.status}, ${modelLabel(w.model, w.effort)}, branch ${w.branch ?? "none"}, pull request ${w.prUrl ?? "none yet"}`);
  }

  private gate(): GateState {
    return this.d.gate?.() ?? { holds: null };
  }

  /** A gate holds, and the worker may not start under it. A follow-up to a worker that already has a place is never held. */
  private heldByGate(w: WorkerRow): boolean {
    return this.gate().holds !== null && !w.gateOk && !this.hasPlace(w);
  }

  /** The gate has lifted, or the queue may have changed: look at the queue again. */
  wake(): void {
    this.dispatch();
  }

  private canStartNow(): boolean {
    return this.ready && !this.paused() && this.live.size < this.d.limit && !this.pacing;
  }

  /** Whether the account's usage limit is in force for the workers. */
  isPaused(): boolean {
    return this.paused();
  }

  private paused(): boolean {
    return this.pausedUntil !== null && this.pausedUntil > this.d.now();
  }

  /** A worker of this Clot by its ID or the first 8 characters of it. */
  private find(clot: string, id: string): WorkerRow | string {
    const key = id.trim().toLowerCase();
    const matches = this.d.store.workersOf(clot).filter((w) => w.id === key || (key.length >= 8 && w.id.startsWith(key)));
    return matches.length === 1 ? matches[0] : `No worker ${id} here.`;
  }

  private workerOnBranch(repo: string, branch: string): WorkerRow | undefined {
    for (const w of this.d.store.workersOnBranch(branch)) {
      if (w.status === "closed") continue;
      if (this.d.repoOf(w.clot) === repo || (this.d.repoOf(w.clot) === null && (w.prRepo === null || w.prRepo === repo))) return w;
    }
    return undefined;
  }

  /** Whether the worker's place was made: a worktree is made with its first turn. */
  private hasPlace(w: WorkerRow): boolean {
    return w.base !== null || w.started || w.turnSeq > 0;
  }

  /** Starts the queued workers that fit. Only one dispatch runs at a time; a call made meanwhile runs it again. */
  private dispatch(): void {
    if (!this.ready) return;
    if (this.dispatching) {
      this.again = true;
      return;
    }
    this.dispatching = true;
    try {
      do {
        this.again = false;
        if (this.paused()) break;
        const queue = this.d.store.queuedWorkers().filter((w) => this.d.knows(w.clot) && !this.live.has(w.id) && !this.heldByGate(w));
        if (queue.length === 0) this.pacing = false;
        for (const w of queue) {
          if (this.live.size >= this.d.limit) break;
          if (this.pacing) {
            const wait = this.nextStartAt - this.d.now();
            if (wait > 0) {
              this.paceTimer?.();
              this.paceTimer = this.d.after(wait, () => this.dispatch());
              break;
            }
            this.nextStartAt = this.d.now() + RESTART_PACE_MS;
          }
          void this.begin(w);
        }
      } while (this.again);
    } finally {
      this.dispatching = false;
    }
  }

  /**
   * Runs one turn of a worker. Takes its place before the first await, so that nothing can start
   * the same worker twice or go over the limit. Returns why it could not start, if it could not.
   */
  private async begin(w: WorkerRow): Promise<string | undefined> {
    const { store } = this.d;
    const used = new Set([...this.live.values()].map((s) => s.place));
    let place = 0;
    while (used.has(place)) place += 1;
    const slot: Slot = { place, buffer: new ReportBuffer(), lastStep: w.lastStep, timedOut: false, cancel: [] };
    this.live.set(w.id, slot);
    store.setWorker(w.id, { status: "running" });

    // A stop or a closed pull request can come during any await below. They set the status first,
    // so it is checked after each: the turn does not start, and a worktree made meanwhile goes.
    const cancelled = async (made: boolean): Promise<boolean> => {
      if (store.getWorker(w.id)!.status === "running") return false;
      this.live.delete(w.id);
      if (made) await this.d.container.removeWorktree(w.clot, w.worktree).catch((error) => console.error(`[${w.clot}] removing worker ${w.id}'s worktree failed:`, error));
      this.dispatch();
      return true;
    };

    let worker = w;
    try {
      if (!this.hasPlace(w)) {
        const home = this.d.repoOf(w.clot) === null;
        const base = home ? null : await this.d.container.defaultBranch(w.clot);
        if (await cancelled(false)) return undefined;
        await this.d.container.addWorktree(w.clot, { workerId: w.id, branch: w.branch, base });
        store.setWorker(w.id, { base });
        if (await cancelled(true)) return undefined;
        worker = store.getWorker(w.id)!;
        await this.d.say(w.clot, `Started: ${w.title} (${modelLabel(w.model, w.effort)})`);
      } else if (await this.closedOnGithub(w)) {
        return "its pull request was merged or closed";
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (await cancelled(false)) return undefined;
      this.live.delete(w.id);
      store.setWorker(w.id, { status: "failed", failure: reason });
      await this.d.say(w.clot, `Worker failed: ${w.title}`);
      this.dispatch();
      return reason;
    }
    if (await cancelled(false)) return undefined;

    const first = worker.turnSeq === 0 && !worker.started;
    const resume = worker.started || (await this.d.container.sessionExists(w.clot, w.id).catch(() => false));
    if (await cancelled(false)) return undefined;
    const messages = store.takeWorkerMessages(w.id);
    const seq = worker.turnSeq + 1;
    store.setWorker(w.id, { asked: null, interrupted: false, turnSeq: seq, idleSince: null });
    const repo = this.d.repoOf(w.clot);
    const branch = worker.branch ?? "";
    slot.handle = this.d.runnerFor(w.clot).startTurn({
      role: "worker",
      ...(resume ? { resume: w.id } : { newSessionId: w.id }),
      prompt: workerPrompt({ interrupted: worker.interrupted, brief: first ? worker.brief : undefined, messages, continueText: CONTINUE_TEXT }),
      effort: worker.effort,
      model: WORKER_MODELS[worker.model],
      cwd: worker.worktree,
      systemPrompt: repo === null ? homeWorkerSystemPrompt(w.clot, branch) : workerSystemPrompt(w.clot, branch),
      guard: { branch: worker.branch, base: worker.base, repo },
      workerTools: { askMain: async ({ question }) => this.askMain(w.id, question) },
      env: { PORT: String(4100 + 10 * place) },
      onText: (text) => slot.buffer.onText(text),
      onStep: (step) => {
        slot.buffer.onStep();
        slot.lastStep = step;
        store.setWorker(w.id, { lastStep: step });
      },
    });
    slot.cancel.push(
      this.d.every(PROGRESS_MS, () => {
        if (this.live.get(w.id) !== slot) return;
        const step = slot.lastStep ?? slot.buffer.lastLine();
        void this.d.say(w.clot, `Still on it: ${w.title}. Latest: ${step || "starting"}`);
      }),
      this.d.after(TIME_LIMIT_MS, () => {
        slot.timedOut = true;
        slot.handle?.stop();
      }),
    );
    slot.done = slot.handle.done.then(
      (result) => this.finish(w.id, seq, slot, result, messages),
      (error) => console.error(`[${w.clot}] worker ${w.id}:`, error),
    );
    return undefined;
  }

  /** Writes what a turn's end means, in one transaction with the row for the main session, then starts the next worker. */
  private async finish(id: string, seq: number, slot: Slot, result: TurnResult, messages: string[]): Promise<void> {
    const { store } = this.d;
    for (const cancel of slot.cancel) cancel();
    this.live.delete(id);
    const w = store.getWorker(id)!;
    // Booked first: the turn cost what it cost whatever became of the worker.
    await this.d.book?.({ clot: w.clot, who: `worker:${id}`, sessionId: id, total: result.totalCostUsd }).catch((error) => console.error(`[${w.clot}] booking worker ${id}'s cost failed:`, error));
    try {
      if (w.status !== "running") return;
      const started = w.started || result.responded === true || result.ok;
      const name = `"${w.title}"`;
      const rowId = `worker:${id}:${seq}`;

      if (result.limit) {
        store.setWorker(id, { status: "idle", interrupted: true, started, idleSince: this.d.now() });
        const first = this.pausedUntil === null || !this.paused();
        this.onLimit(result.limit.resetsAt);
        if (first) await this.d.pause(w.clot, result.limit.resetsAt);
        return;
      }

      if (!result.ok && !slot.timedOut && !result.responded) {
        // Nothing came back: Docker, the container or the spawn. Tried again later, with what it was to read.
        for (const message of messages) store.addWorkerMessage(id, message);
        const retries = w.retries + 1;
        if (retries <= RETRY_MS.length) {
          // The turn did not happen: the next one is the same turn again, with the same brief.
          store.setWorker(id, { status: "idle", interrupted: w.interrupted, retries, started, turnSeq: seq - 1 });
          this.d.after(RETRY_MS[retries - 1], () => {
            if (store.getWorker(id)?.status !== "idle") return;
            store.queueWorker(id);
            this.dispatch();
          });
          return;
        }
        this.toMainAndSet(w, rowId, `[Worker ${shortId(id)}, ${name}, failed: its session could not be started.]`, { status: "failed", failure: "its session could not be started", retries });
        await this.d.say(w.clot, `Worker failed: ${w.title}`);
        return;
      }

      if (slot.timedOut || !result.ok) {
        const reason = slot.timedOut ? "ran past 90 minutes" : "its session ended with an error";
        this.toMainAndSet(w, rowId, `[Worker ${shortId(id)}, ${name}, failed: ${reason}.]`, { status: "idle", started, retries: 0, idleSince: this.d.now() });
        await this.d.say(w.clot, `Worker failed: ${w.title}`);
        return;
      }

      const report = slot.buffer.report();
      // The link is a hint until GitHub confirms it: it gives a home worker the repository to ask
      // about, so a missed webhook is still caught by the hourly check.
      const link = w.prUrl === null ? prLink(report) : undefined;
      const parsed = link === undefined ? undefined : /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)$/.exec(link);
      const fromLink = parsed ? { prUrl: link, prRepo: w.prRepo ?? parsed[1].toLowerCase(), prNumber: Number(parsed[2]) } : {};
      const change = { status: "idle" as const, started, retries: 0, idleSince: this.d.now(), ...fromLink };
      if (w.asked !== null) {
        const under = report.trim() === "" ? "" : `\n\n[What it wrote after asking:]\n${report}`;
        this.toMainAndSet(w, rowId, `[Question from worker ${shortId(id)}, ${name}. Answer it with message_worker, or ask the user.]\n${w.asked}${under}`, change);
        return;
      }
      this.toMainAndSet(w, rowId, `[Report from worker ${shortId(id)}, ${name}. Written by your worker, not by the user.]\n${report}`, change);
      await this.d.say(w.clot, `Finished: ${w.title}`);
      if (result.activity && result.activity.files.length + result.activity.commands.length > 0) await this.d.postActivity(w.clot, result.activity).catch(() => undefined);
    } finally {
      const now = store.getWorker(id)!;
      if (now.status === "idle" && store.hasWorkerMessages(id) && now.retries === 0) store.queueWorker(id);
      this.dispatch();
    }
  }

  /** The worker's new state and the main session's row, written together, then the main session is woken. */
  private toMainAndSet(w: WorkerRow, rowId: string, text: string, change: Parameters<Store["setWorker"]>[1]): void {
    const { store } = this.d;
    const session = store.activeSession(w.clot);
    store.inTransaction(() => {
      store.setWorker(w.id, change);
      if (session) store.enqueue({ id: rowId, clot: w.clot, channelId: session.channelId, text, receivedAt: this.d.now(), kind: "worker", workerId: w.id, outsider: store.getWorker(w.id)!.outsider });
    });
    this.d.kick(w.clot);
  }

  /** Stops the worker's live turn, if it has one, and waits for its end. */
  private async endLive(id: string): Promise<void> {
    const slot = this.live.get(id);
    if (!slot) return;
    slot.handle?.stop();
    await slot.done;
  }

  private async close(w: WorkerRow, note: string): Promise<void> {
    this.d.store.setWorker(w.id, { status: "closed" });
    await this.endLive(w.id);
    await this.d.container.removeWorktree(w.clot, w.worktree).catch((error) => console.error(`[${w.clot}] removing worker ${w.id}'s worktree failed:`, error));
    this.d.store.addNote(w.clot, note);
    this.dispatch();
  }

  /** The usage limit has reset: every worker it cut off carries on. */
  private resumeAfterLimit(): void {
    this.pausedUntil = null;
    this.d.store.setState(PAUSE_KEY, "0");
    for (const w of this.d.store.workersWithStatus("idle")) if (w.interrupted) this.d.store.queueWorker(w.id);
    this.dispatch();
  }

  /** Asks GitHub about a worker's pull request. True when it was merged or closed, and the worker has been closed. */
  private async closedOnGithub(w: WorkerRow): Promise<boolean> {
    const repo = this.d.repoOf(w.clot) ?? w.prRepo;
    if (!this.d.prsForBranch || w.branch === null || repo === null) return false;
    const found = await this.d.prsForBranch(w.clot, w.branch, repo).catch(() => undefined);
    // A fork's branch can have the same name: only the repository's own pull requests count,
    // and the one the worker is known to have comes first.
    const own = (found ?? []).filter((pr) => pr.isCrossRepository !== true).sort((a, b) => b.number - a.number);
    const pr = own.find((p) => p.number === w.prNumber) ?? own[0];
    if (!pr) return false;
    if (pr.state === "OPEN") {
      if (w.prNumber !== pr.number) this.d.store.setWorker(w.id, { prNumber: pr.number, prUrl: pr.url, prRepo: repo });
      return false;
    }
    if (this.live.get(w.id)?.handle === undefined) this.live.delete(w.id);
    await this.close(w, `Worker ${shortId(w.id)} "${w.title}": its pull request was merged or closed, and its worktree removed.`);
    return true;
  }

  /** A missed webhook is not sent again, so GitHub is asked about every listed worker's pull request. */
  private async reconcile(): Promise<void> {
    for (const w of this.listedEverywhere()) {
      if (this.live.has(w.id)) continue;
      await this.closedOnGithub(w).catch((error) => console.error(`[${w.clot}] checking worker ${w.id}'s pull request failed:`, error));
    }
  }

  /** A worker idle for a week with no pull request is closed. */
  private async expire(): Promise<void> {
    for (const w of this.d.store.workersWithStatus("idle")) {
      if (w.prUrl !== null || w.idleSince === null || this.d.now() - w.idleSince < IDLE_EXPIRY_MS) continue;
      await this.close(w, `Worker ${shortId(w.id)} "${w.title}" was idle for 7 days with no pull request, so it was closed and its worktree removed.`);
    }
  }

  private listedEverywhere(): WorkerRow[] {
    const { store } = this.d;
    return [...store.workersWithStatus("queued"), ...store.workersWithStatus("idle"), ...store.workersWithStatus("running")];
  }
}

/** How a worker is named to the main session and the user: the first 8 characters of its ID. */
export function shortId(id: string): string {
  return id.slice(0, 8);
}
