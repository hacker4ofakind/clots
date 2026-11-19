import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRunner, TurnHandle, TurnRequest, TurnResult, WorkerTurnRequest } from "../src/agent/runner.js";
import { Store, type InboxInsert } from "../src/store.js";
import { makeTools, type ToolDeps } from "../src/tools.js";
import type { TurnActivity } from "../src/types.js";
import { Workers, type WorkersDeps } from "../src/workers.js";

/** A live worker turn the test ends by hand. */
interface Live {
  req: WorkerTurnRequest;
  pushes: string[];
  acceptPushes: boolean;
  stopped: boolean;
  end(result?: Partial<TurnResult>): void;
}

class FakeRunner implements AgentRunner {
  turns: Live[] = [];
  startTurn(req: TurnRequest): TurnHandle {
    let resolve!: (r: TurnResult) => void;
    const done = new Promise<TurnResult>((r) => (resolve = r));
    const live: Live = {
      req: req as WorkerTurnRequest,
      pushes: [],
      acceptPushes: true,
      stopped: false,
      end: (result = {}) => resolve({ sessionId: "", contextPercent: 5, ok: true, responded: true, ...result }),
    };
    this.turns.push(live);
    return {
      push: (text) => {
        if (live.acceptPushes) live.pushes.push(text);
        return live.acceptPushes;
      },
      stop: () => {
        live.stopped = true;
        live.end({ ok: false });
      },
      done,
    };
  }
  /** The turns still running. */
  running(): Live[] {
    return this.turns.filter((t) => !t.stopped && !ended.has(t));
  }
}

const ended = new Set<Live>();
function finishTurn(t: Live, result: Partial<TurnResult> = {}): void {
  ended.add(t);
  t.end(result);
}

interface Timer {
  at: number;
  fn: () => void;
  every?: number;
  cancelled: boolean;
}

let store: Store;
let runner: FakeRunner;
let clock: number;
let timers: Timer[];
let said: { clot: string; text: string }[];
let toMain: { clot: string; id: string; text: string; workerId: string; outsider: boolean }[];
let enqueued: InboxInsert[];
let paused: { clot: string; resetsAt: number }[];
let activities: TurnActivity[];
let removed: string[];
let addFails: string | undefined;
let existing: Set<string>;
let prs: Map<string, { number: number; url: string; state: string }[]>;
let ids: number;
let deps: WorkersDeps;
let workers: Workers;

/** Moves the fake clock on, firing the timers that fall due in order. */
async function advance(ms: number): Promise<void> {
  const until = clock + ms;
  for (;;) {
    const due = timers.filter((t) => !t.cancelled && t.at <= until).sort((a, b) => a.at - b.at)[0];
    if (!due) break;
    clock = due.at;
    if (due.every) due.at += due.every;
    else due.cancelled = true;
    due.fn();
    await settle();
  }
  clock = until;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function build(overrides: Partial<WorkersDeps> = {}): Workers {
  deps = {
    store,
    runnerFor: () => runner,
    container: {
      defaultBranch: async () => "main",
      addWorktree: async (_clot, o) => {
        if (addFails) throw new Error(addFails);
        const path = o.base === null ? `/workspace/workers/${o.workerId}` : `/workspace/worktrees/${o.workerId}`;
        existing.add(path);
        return path;
      },
      removeWorktree: async (_clot, path) => {
        removed.push(path);
        existing.delete(path);
      },
      worktreeExists: async (_clot, path) => existing.has(path),
      sessionExists: async () => false,
    },
    prsForBranch: async (_clot, branch) => prs.get(branch) ?? [],
    knows: (clot) => clot === "graphite" || clot === "shop" || clot === "home",
    repoOf: (clot) => (clot === "home" ? null : clot === "shop" ? "o/shop" : "o/r"),
    limit: 3,
    now: () => clock,
    newId: () => `${String(++ids).padStart(8, "0")}-0000-0000-0000-000000000000`,
    random: () => "1a2b",
    every: (ms, fn) => {
      const timer: Timer = { at: clock + ms, fn, every: ms, cancelled: false };
      timers.push(timer);
      return () => void (timer.cancelled = true);
    },
    after: (ms, fn) => {
      const timer: Timer = { at: clock + ms, fn, cancelled: false };
      timers.push(timer);
      return () => void (timer.cancelled = true);
    },
    // The rows the workers stored for the main session, as the kicked drain would take them.
    kick: (clot) => {
      for (const row of enqueued.filter((r) => r.clot === clot && !toMain.some((t) => t.id === r.id))) {
        toMain.push({ clot, id: row.id, text: row.text, workerId: row.workerId!, outsider: row.outsider === true });
      }
    },
    pause: async (clot, resetsAt) => void paused.push({ clot, resetsAt }),
    say: async (clot, text) => void said.push({ clot, text }),
    postActivity: async (_clot, activity) => void activities.push(activity),
    ...overrides,
  };
  return new Workers(deps);
}

const fix = { title: "Fix X", brief: "Fix X in a.ts. Done when npm test passes.", model: "sonnet" as const, effort: "high" as const, urgent: false, gateOk: true };
const lines = (clot = "graphite") => said.filter((s) => s.clot === clot).map((s) => s.text);

beforeEach(async () => {
  store = new Store(":memory:");
  enqueued = [];
  const enqueue = store.enqueue.bind(store);
  store.enqueue = (row) => (enqueued.push(row), enqueue(row));
  for (const name of ["graphite", "shop", "home"]) {
    store.upsertClot(name, `cat-${name}`);
    store.createSession({ id: `s-${name}`, clot: name, channelId: `ch-${name}`, seed: null });
  }
  runner = new FakeRunner();
  ended.clear();
  clock = 1_000_000;
  timers = [];
  said = [];
  toMain = [];
  paused = [];
  activities = [];
  removed = [];
  addFails = undefined;
  existing = new Set();
  prs = new Map();
  ids = 0;
  workers = build();
  workers.recover();
  await workers.startUp();
  // Nothing was queued, so nothing is paced.
});

describe("Workers", () => {
  it("makes the worktree and starts a turn with the brief, on Sonnet 5.5 high", async () => {
    const reply = await workers.start("graphite", fix);
    expect(reply).toContain("Started worker 00000001 on branch clot/fix-x-1a2b");
    expect(runner.turns).toHaveLength(1);
    expect(runner.turns[0].req).toMatchObject({ role: "worker", model: "claude-sonnet-5-5", effort: "high", cwd: "/workspace/worktrees/00000001-0000-0000-0000-000000000000", prompt: fix.brief, guard: { branch: "clot/fix-x-1a2b", base: "main", repo: "o/r" }, env: { PORT: "4100" } });
    expect(runner.turns[0].req.systemPrompt).toContain("You are a worker for the Clot graphite");
    expect(lines()).toEqual(["Started: Fix X (Sonnet 5.5 high)"]);
    expect(workers.lines("graphite")).toEqual(['- 00000001 "Fix X": running, Sonnet 5.5 high, branch clot/fix-x-1a2b, pull request none yet']);
  });

  it("queues beyond the limit, and starts the next when a turn ends, urgent first", async () => {
    for (const title of ["One", "Two", "Three"]) await workers.start("graphite", { ...fix, title });
    expect(await workers.start("graphite", { ...fix, title: "Four" })).toContain("Queued");
    await workers.start("shop", { ...fix, title: "Five", urgent: true });
    expect(runner.turns).toHaveLength(3);
    expect(lines()).toContain("Queued: Four (Sonnet 5.5 high). 3 workers are already running; it starts when one finishes.");

    finishTurn(runner.turns[0]);
    await settle();
    expect(runner.turns).toHaveLength(4);
    expect(runner.turns[3].req.guard.repo).toBe("o/shop");
  });

  it("never runs more turns than the limit when two end together", async () => {
    for (const title of ["One", "Two", "Three", "Four", "Five", "Six"]) await workers.start("graphite", { ...fix, title });
    expect(runner.turns).toHaveLength(3);
    finishTurn(runner.turns[0]);
    finishTurn(runner.turns[1]);
    await settle();
    await settle();
    expect(runner.turns).toHaveLength(5);
    expect(runner.running()).toHaveLength(3);
    expect(runner.turns.slice(3).map((t) => t.req.prompt)).toEqual([fix.brief, fix.brief]);
  });

  it("posts the latest step every 20 minutes while a turn runs, and nothing after it ends", async () => {
    await workers.start("graphite", fix);
    runner.turns[0].req.onStep("npm test");
    await advance(20 * 60_000);
    expect(lines().at(-1)).toBe("Still on it: Fix X. Latest: npm test");
    finishTurn(runner.turns[0]);
    await settle();
    const count = lines().length;
    await advance(40 * 60_000);
    expect(lines().filter((l) => l.startsWith("Still on it"))).toHaveLength(1);
    expect(lines()).toHaveLength(count);
  });

  it("reports only what was written after the last step, and stores the pull request it names", async () => {
    await workers.start("graphite", fix);
    const t = runner.turns[0];
    t.req.onText("Looking at a.ts.");
    t.req.onStep("Edit");
    t.req.onText("Changed\n- a.ts\nPull request\nhttps://github.com/o/r/pull/9");
    finishTurn(t, { activity: { files: [{ path: "a.ts", added: 1, removed: 0 }], commands: [] } });
    await settle();
    expect(toMain).toHaveLength(1);
    expect(toMain[0].text).toBe('[Report from worker 00000001, "Fix X". Written by your worker, not by the user.]\nChanged\n- a.ts\nPull request\nhttps://github.com/o/r/pull/9');
    expect(toMain[0].id).toBe("worker:00000001-0000-0000-0000-000000000000:1");
    expect(store.nextPending("graphite")).toMatchObject({ kind: "worker", workerId: "00000001-0000-0000-0000-000000000000" });
    expect(lines().at(-1)).toBe("Finished: Fix X");
    expect(activities).toHaveLength(1);
    expect(store.getWorker("00000001-0000-0000-0000-000000000000")).toMatchObject({ status: "idle", prUrl: "https://github.com/o/r/pull/9", started: true });
  });

  it("sends a question instead of a report after ask_main, and a later message starts a turn with it", async () => {
    await workers.start("graphite", fix);
    const t = runner.turns[0];
    expect(await t.req.workerTools.askMain({ question: "Keep the old API?" })).toContain("End your turn now");
    finishTurn(t);
    await settle();
    expect(toMain[0].text).toBe('[Question from worker 00000001, "Fix X". Answer it with message_worker, or ask the user.]\nKeep the old API?');
    expect(lines()).not.toContain("Finished: Fix X");

    expect(await workers.message("graphite", "00000001", "Yes, keep it.")).toContain("Sent");
    await settle();
    expect(runner.turns).toHaveLength(2);
    expect(runner.turns[1].req).toMatchObject({ prompt: "[From the main session]\nYes, keep it.", resume: "00000001-0000-0000-0000-000000000000" });
  });

  it("pushes a message into a live turn, and stores it when the push is refused", async () => {
    await workers.start("graphite", fix);
    const t = runner.turns[0];
    await workers.message("graphite", "00000001", "Also b.ts.");
    expect(t.pushes).toEqual(["[From the main session]\nAlso b.ts."]);
    t.acceptPushes = false;
    await workers.message("graphite", "00000001", "And c.ts.");
    finishTurn(t);
    await settle();
    expect(runner.turns).toHaveLength(2);
    expect(runner.turns[1].req.prompt).toBe("[From the main session]\nAnd c.ts.");
  });

  it("puts a message to a queued worker in its first prompt, after the brief", async () => {
    for (const title of ["One", "Two", "Three", "Four"]) await workers.start("graphite", { ...fix, title });
    await workers.message("graphite", "00000004", "Use the new client.");
    finishTurn(runner.turns[0]);
    await settle();
    expect(runner.turns[3].req.prompt).toBe(`${fix.brief}\n\n[From the main session]\nUse the new client.`);
  });

  it("stops a live turn, removes the worktree, and sends nothing to the main session", async () => {
    await workers.start("graphite", fix);
    expect(await workers.stop("graphite", "00000001")).toContain("Stopped worker 00000001");
    expect(runner.turns[0].stopped).toBe(true);
    await settle();
    expect(lines().at(-1)).toBe("Stopped: Fix X");
    expect(removed).toEqual(["/workspace/worktrees/00000001-0000-0000-0000-000000000000"]);
    expect(toMain).toEqual([]);
    expect(store.getWorker("00000001-0000-0000-0000-000000000000")!.status).toBe("stopped");
    expect(await workers.message("graphite", "00000001", "x")).toContain("Refused");
  });

  it("answers an id of another Clot's worker as unknown", async () => {
    await workers.start("shop", fix);
    expect(await workers.message("graphite", "00000001", "x")).toBe("No worker 00000001 here.");
    expect(await workers.stop("graphite", "00000001")).toBe("No worker 00000001 here.");
  });

  it("pauses every worker start on the usage limit, posts the notice once, and wakes the cut-off workers", async () => {
    await workers.start("graphite", fix);
    await workers.start("shop", { ...fix, title: "Fix Y" });
    const resetsAt = Math.floor(clock / 1000) + 3600;
    finishTurn(runner.turns[0], { ok: false, limit: { resetsAt } });
    finishTurn(runner.turns[1], { ok: false, limit: { resetsAt } });
    await settle();
    expect(paused).toEqual([{ clot: "graphite", resetsAt }]);
    expect(lines()).not.toContain("Finished: Fix X");
    expect(toMain).toEqual([]);
    expect(store.getWorker("00000001-0000-0000-0000-000000000000")).toMatchObject({ status: "idle", interrupted: true });

    expect(await workers.start("graphite", { ...fix, title: "Fix Z" })).toContain("Queued");
    expect(runner.turns).toHaveLength(2);

    await advance(3600 * 1000);
    expect(runner.turns).toHaveLength(5);
    const resumed = runner.turns.slice(2).find((t) => t.req.resume === "00000001-0000-0000-0000-000000000000")!;
    expect(resumed.req.prompt.startsWith("[Your previous turn was cut off")).toBe(true);
    expect(resumed.req.prompt.endsWith("(The usage limit has reset. Continue where you left off.)")).toBe(true);
  });

  it("queues instead of starting while a main session's limit holds", async () => {
    workers.onLimit(Math.floor(clock / 1000) + 600);
    expect(await workers.start("graphite", fix)).toContain("Queued");
    expect(runner.turns).toHaveLength(0);
    await advance(600 * 1000);
    expect(runner.turns).toHaveLength(1);
  });

  it("retries a turn that failed before any model response after 1, 5 and 15 minutes, then gives up", async () => {
    await workers.start("graphite", fix);
    for (const wait of [1, 5, 15]) {
      finishTurn(runner.turns.at(-1)!, { ok: false, responded: false });
      await settle();
      const count = runner.turns.length;
      await advance(wait * 60_000 - 1);
      expect(runner.turns).toHaveLength(count);
      await advance(1);
      expect(runner.turns).toHaveLength(count + 1);
    }
    expect(runner.turns.at(-1)!.req.prompt).toBe(fix.brief);
    finishTurn(runner.turns.at(-1)!, { ok: false, responded: false });
    await settle();
    expect(store.getWorker("00000001-0000-0000-0000-000000000000")!.status).toBe("failed");
    expect(lines().at(-1)).toBe("Worker failed: Fix X");
    expect(toMain[0].text).toContain("failed: its session could not be started");
  });

  it("stops a turn still live at 90 minutes and reports it as a failure, leaving the worker idle", async () => {
    await workers.start("graphite", fix);
    await advance(90 * 60_000);
    await settle();
    expect(runner.turns[0].stopped).toBe(true);
    expect(lines().filter((l) => l.startsWith("Still on it"))).toHaveLength(4);
    expect(lines().at(-1)).toBe("Worker failed: Fix X");
    expect(toMain[0].text).toBe('[Worker 00000001, "Fix X", failed: ran past 90 minutes.]');
    expect(store.getWorker("00000001-0000-0000-0000-000000000000")!.status).toBe("idle");
  });

  it("reports a session that ended with an error", async () => {
    await workers.start("graphite", fix);
    finishTurn(runner.turns[0], { ok: false, responded: true });
    await settle();
    expect(toMain[0].text).toBe('[Worker 00000001, "Fix X", failed: its session ended with an error.]');
  });

  it("marks failed a worker whose worktree could not be made", async () => {
    addFails = "fatal: a branch named 'clot/fix-x-1a2b' already exists";
    expect(await workers.start("graphite", fix)).toBe("Not started: fatal: a branch named 'clot/fix-x-1a2b' already exists.");
    expect(lines()).toEqual(["Worker failed: Fix X"]);
    expect(store.getWorker("00000001-0000-0000-0000-000000000000")!.status).toBe("failed");
  });

  it("refuses Haiku at high, a bad title and a twenty-first listed worker", async () => {
    expect(await workers.start("graphite", { ...fix, model: "haiku", effort: "high" })).toBe("Refused: Haiku is not run at high. Use sonnet at high.");
    expect(await workers.start("graphite", { ...fix, title: "X" })).toContain("Refused");
    for (let i = 0; i < 20; i += 1) await workers.start("graphite", { ...fix, title: `Task ${i}` });
    expect(await workers.start("graphite", { ...fix, title: "One more" })).toBe("Refused: graphite already has 20 workers listed. Stop one first.");
  });

  it("closes a worker when its pull request closes, once, and ignores a fork's", async () => {
    await workers.start("graphite", fix);
    finishTurn(runner.turns[0]);
    await settle();
    const pr = { repo: "O/R", branch: "clot/fix-x-1a2b", number: 9, url: "https://github.com/o/r/pull/9" };
    await workers.onPullRequest({ ...pr, headRepo: "o/r", action: "opened" });
    expect(store.getWorker("00000001-0000-0000-0000-000000000000")).toMatchObject({ prNumber: 9, prUrl: pr.url });

    await workers.onPullRequest({ ...pr, headRepo: "fork/r", action: "closed" });
    expect(store.getWorker("00000001-0000-0000-0000-000000000000")!.status).toBe("idle");
    // New commits never close it.
    await workers.onPullRequest({ ...pr, headRepo: "o/r", action: "synchronize" });
    expect(store.getWorker("00000001-0000-0000-0000-000000000000")!.status).toBe("idle");

    await workers.onPullRequest({ ...pr, headRepo: "o/r", action: "closed" });
    await workers.onPullRequest({ ...pr, headRepo: "o/r", action: "closed" });
    expect(store.getWorker("00000001-0000-0000-0000-000000000000")!.status).toBe("closed");
    expect(removed).toHaveLength(1);
    expect(store.notes("graphite").map((n) => n.text)).toEqual(['Worker 00000001 "Fix X": its pull request was merged or closed, and its worktree removed.']);
    expect(workers.lines("graphite")).toEqual([]);
  });

  it("stops a live turn when its pull request closes, and the turn's end leaves it closed", async () => {
    await workers.start("graphite", fix);
    await workers.onPullRequest({ repo: "o/r", branch: "clot/fix-x-1a2b", headRepo: "o/r", number: 9, url: "u", action: "closed" });
    expect(runner.turns[0].stopped).toBe(true);
    await settle();
    expect(store.getWorker("00000001-0000-0000-0000-000000000000")!.status).toBe("closed");
    expect(toMain).toEqual([]);
  });

  it("gives a home Clot worker a plain directory and its own prompt", async () => {
    await workers.start("home", { ...fix, title: "Add editorconfig" });
    expect(runner.turns[0].req).toMatchObject({ cwd: "/workspace/workers/00000001-0000-0000-0000-000000000000", guard: { branch: "clot/add-editorconfig-1a2b", base: null, repo: null } });
    expect(runner.turns[0].req.systemPrompt).toContain("The current directory is empty.");
  });
});

describe("Workers after a restart", () => {
  it("queues a running worker as cut off, marks failed one whose worktree is gone, and spaces the starts", async () => {
    await workers.start("graphite", fix);
    await workers.start("graphite", { ...fix, title: "Fix Y" });
    await workers.start("graphite", { ...fix, title: "Fix Z" });
    existing.delete("/workspace/worktrees/00000002-0000-0000-0000-000000000000");

    // The daemon stops: a fresh Workers on the same database.
    runner = new FakeRunner();
    timers = [];
    said = [];
    const again = build();
    again.recover();
    expect(store.getWorker("00000001-0000-0000-0000-000000000000")).toMatchObject({ status: "queued", interrupted: true });
    await again.startUp();
    await settle();
    expect(store.getWorker("00000002-0000-0000-0000-000000000000")).toMatchObject({ status: "failed", failure: "its worktree is gone" });
    expect(runner.turns).toHaveLength(1);
    expect(runner.turns[0].req.prompt.startsWith("[Your previous turn was cut off")).toBe(true);
    expect(said).toEqual([]);
    await advance(30_000);
    await settle();
    expect(runner.turns).toHaveLength(2);
  });

  it("does not take a worker a Clot's backlog turn started before startUp for a cut-off one", async () => {
    store = new Store(":memory:");
    store.upsertClot("graphite", "cat");
    store.createSession({ id: "s", clot: "graphite", channelId: "ch", seed: null });
    runner = new FakeRunner();
    const fresh = build();
    fresh.recover();
    expect(await fresh.start("graphite", fix)).toContain("Queued");
    await fresh.startUp();
    await settle();
    expect(runner.turns).toHaveLength(1);
    expect(runner.turns[0].req.prompt).toBe(fix.brief);
  });

  it("closes a listed worker whose pull request GitHub says was merged", async () => {
    await workers.start("graphite", fix);
    finishTurn(runner.turns[0]);
    await settle();
    prs.set("clot/fix-x-1a2b", [{ number: 9, url: "u", state: "MERGED" }]);
    await workers.message("graphite", "00000001", "One more thing.");
    await settle();
    expect(store.getWorker("00000001-0000-0000-0000-000000000000")!.status).toBe("closed");
    expect(runner.turns).toHaveLength(1);
  });

  /** Stops this daemon's Workers and starts a fresh one on the same database, as a restart does. */
  async function restart(): Promise<Workers> {
    runner = new FakeRunner();
    timers = [];
    const again = build();
    again.recover();
    await again.startUp();
    await settle();
    return again;
  }

  it("keeps a worker the usage limit cut off waiting for the reset across a restart, then resumes it", async () => {
    await workers.start("graphite", fix);
    const resetsAt = Math.floor(clock / 1000) + 3600;
    finishTurn(runner.turns[0], { ok: false, limit: { resetsAt } });
    await settle();

    await restart();
    expect(runner.turns).toHaveLength(0);
    await advance(3600 * 1000);
    await settle();
    expect(runner.turns).toHaveLength(1);
    expect(runner.turns[0].req.prompt.startsWith("[Your previous turn was cut off")).toBe(true);
  });

  it("retries after a restart a worker that was waiting to retry a turn that failed to start", async () => {
    await workers.start("graphite", fix);
    finishTurn(runner.turns[0], { ok: false, responded: false });
    await settle();
    expect(store.getWorker("00000001-0000-0000-0000-000000000000")).toMatchObject({ status: "idle", retries: 1, interrupted: false });

    await restart();
    expect(runner.turns).toHaveLength(1);
    expect(runner.turns[0].req.prompt).toBe(fix.brief);
  });
});

describe("Workers cancelled while a turn is being prepared", () => {
  /** A promise the test resolves by hand. */
  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => (resolve = r));
    return { promise, resolve };
  }

  it("does not start a stopped worker's turn when its session check resolves", async () => {
    await workers.start("graphite", fix);
    finishTurn(runner.turns[0]);
    await settle();
    const probe = deferred<boolean>();
    workers = build({ container: { ...deps.container, sessionExists: () => probe.promise } });
    workers.recover();
    await workers.startUp();
    store.setWorker("00000001-0000-0000-0000-000000000000", { started: false });
    await workers.message("graphite", "00000001", "Carry on.");
    await settle();
    expect(await workers.stop("graphite", "00000001")).toContain("Stopped");
    probe.resolve(false);
    await settle();
    expect(runner.turns).toHaveLength(1);
    expect(store.getWorker("00000001-0000-0000-0000-000000000000")!.status).toBe("stopped");
  });

  it("removes a worktree made after the worker was stopped, and posts no Started line", async () => {
    const made = deferred<void>();
    workers = build({
      container: {
        ...deps.container,
        addWorktree: async (_clot, o) => {
          await made.promise;
          existing.add(`/workspace/worktrees/${o.workerId}`);
          return `/workspace/worktrees/${o.workerId}`;
        },
      },
    });
    workers.recover();
    await workers.startUp();
    const starting = workers.start("graphite", fix);
    await settle();
    await workers.stop("graphite", "00000001");
    made.resolve();
    await starting;
    await settle();
    expect(runner.turns).toHaveLength(0);
    expect(existing.has("/workspace/worktrees/00000001-0000-0000-0000-000000000000")).toBe(false);
    expect(lines()).toEqual(["Stopped: Fix X"]);
  });

  it("does not start a turn for a worker whose pull request closed while it was being prepared", async () => {
    await workers.start("graphite", fix);
    finishTurn(runner.turns[0]);
    await settle();
    const probe = deferred<boolean>();
    workers = build({ container: { ...deps.container, sessionExists: () => probe.promise } });
    workers.recover();
    await workers.startUp();
    store.setWorker("00000001-0000-0000-0000-000000000000", { started: false });
    await workers.message("graphite", "00000001", "Carry on.");
    await settle();
    await workers.onPullRequest({ repo: "o/r", branch: "clot/fix-x-1a2b", headRepo: "o/r", number: 9, url: "u", action: "closed" });
    probe.resolve(false);
    await settle();
    expect(runner.turns).toHaveLength(1);
    expect(store.getWorker("00000001-0000-0000-0000-000000000000")!.status).toBe("closed");
  });
});

describe("Workers checking GitHub", () => {
  it("ignores a newer closed pull request from a fork while the worker's own is open", async () => {
    await workers.start("graphite", fix);
    finishTurn(runner.turns[0]);
    await settle();
    prs.set("clot/fix-x-1a2b", [
      { number: 9, url: "https://github.com/o/r/pull/9", state: "OPEN", isCrossRepository: false },
      { number: 12, url: "https://github.com/o/r/pull/12", state: "CLOSED", isCrossRepository: true },
    ] as never);
    await advance(60 * 60_000);
    expect(store.getWorker("00000001-0000-0000-0000-000000000000")).toMatchObject({ status: "idle", prNumber: 9 });
    expect(removed).toEqual([]);
  });

  it("finds a home worker's merged pull request from its report's link when the opened webhook was missed", async () => {
    await workers.start("home", { ...fix, title: "Add editorconfig" });
    runner.turns[0].req.onText("Pull request\nhttps://github.com/Someone/Tools/pull/4");
    finishTurn(runner.turns[0]);
    await settle();
    expect(store.getWorker("00000001-0000-0000-0000-000000000000")).toMatchObject({ prRepo: "someone/tools", prNumber: 4 });

    const asked: string[] = [];
    prs.set("clot/add-editorconfig-1a2b", [{ number: 4, url: "https://github.com/Someone/Tools/pull/4", state: "MERGED", isCrossRepository: false }] as never);
    deps.prsForBranch = async (_clot, branch, repo) => (asked.push(repo), prs.get(branch) ?? []);
    await advance(60 * 60_000);
    expect(asked).toEqual(["someone/tools"]);
    expect(store.getWorker("00000001-0000-0000-0000-000000000000")!.status).toBe("closed");
  });
});

describe("the main session's worker tools", () => {
  const toolDeps = (): ToolDeps => ({
    rulebook: { file: () => ({ prefilters: [], triage: [], standing: [], routing: [], watches: [], webhooks: [] }) as never, standingFor: () => [] },
    writer: { apply: () => ({ ok: true }) as never, wasUndone: () => false },
    asks: { rule: async () => "" },
    store,
    senders: {},
    say: async () => undefined,
    handOver: async () => "",
    workers,
  });

  it("starts a worker as urgent from an urgent event's turn only", async () => {
    store.insertEvent({ id: "e1", source: "github", account: "github", kind: "issue_opened", place: "o/r", actor: "a", title: "t", body: "", url: "", ref: "1", subject: "issue:1", automated: false, outsider: false, receivedAt: 0 });
    store.recordTriage("e1", "x", true);
    const spy = vi.spyOn(workers, "start");
    await makeTools(toolDeps(), { clot: "graphite", kind: "event", event: store.getEvent("e1")!, outsider: false }).startSession({ title: "Fix X", brief: "b", model: "sonnet", effort: "high" });
    await makeTools(toolDeps(), { clot: "graphite", kind: "chat", outsider: false }).startSession({ title: "Fix Y", brief: "b", model: "sonnet", effort: "high" });
    expect(spy.mock.calls.map((c) => c[1].urgent)).toEqual([true, false]);
  });

  it("marks a worker an outsider's turn started, and its report's turn puts a rule edit to the user", async () => {
    const opened: string[] = [];
    const deps: ToolDeps = { ...toolDeps(), asks: { rule: async (_clot, _scope, edit) => (opened.push(edit.op), "FILED") } };
    await makeTools(deps, { clot: "graphite", kind: "event", outsider: true }).startSession({ title: "Fix X", brief: "b", model: "sonnet", effort: "high" });
    const id = "00000001-0000-0000-0000-000000000000";
    expect(store.getWorker(id)!.outsider).toBe(true);
    const t = runner.turns.at(-1)!;
    t.req.onText("Changed\n- a.ts");
    finishTurn(t);
    await settle();
    expect(toMain).toHaveLength(1);
    expect(toMain[0].outsider).toBe(true);
    const reply = await makeTools(deps, { clot: "graphite", kind: "worker", outsider: toMain[0].outsider }).prefilter({ action: "add", file: "own", rule: { actor: "x" } });
    expect(reply).toContain("outsider");
    expect(opened).toEqual(["add_prefilter"]);
  });

  it("marks a worker an outsider's turn messages, for good", async () => {
    await makeTools(toolDeps(), { clot: "graphite", kind: "chat", outsider: false }).startSession({ title: "Fix X", brief: "b", model: "sonnet", effort: "high" });
    const id = "00000001-0000-0000-0000-000000000000";
    expect(store.getWorker(id)!.outsider).toBe(false);
    await makeTools(toolDeps(), { clot: "graphite", kind: "event", outsider: true }).messageWorker({ id: id.slice(0, 8), text: "also this" });
    expect(store.getWorker(id)!.outsider).toBe(true);
  });

  it("lets calendar_write run in a worker's turn", async () => {
    const tools = makeTools({ ...toolDeps(), calendar: { accounts: [{ account: "me", shared: true, icalUrl: "u", script: { url: "s", secret: "x" }, leadMinutes: [], pollMinutes: 5 }], timeZone: "UTC", now: () => 0, list: async () => [], call: async () => ({ ok: true, event: { uid: "u1", title: "x", start: "2026-10-16T00:00:00.000Z", end: "2026-10-17T00:00:00.000Z", allDay: true, location: "", description: "", guests: 0, repeats: false } }) as never } }, { clot: "graphite", kind: "worker", outsider: false });
    expect(await tools.calendarWrite!({ action: "create", title: "x", start: "2026-10-16", end: "2026-10-17", allDay: true })).toContain("Added");
  });
});

describe("workers under a gate", () => {
  const SCARCE = { holds: "scarce" as const, until: 1_000_000 + 3_600_000 };
  let gate: { holds: null | "scarce" | "leadIn"; until?: number; percent?: number };
  const FREE = { holds: null } as const;
  let titles = 0;
  const start = (kind: "chat" | "event" | "worker", o: { urgent?: boolean } = {}) => {
    if (o.urgent) {
      store.insertEvent({ id: "u1", source: "github", account: "github", kind: "issue_opened", place: "o/r", actor: "a", title: "t", body: "", url: "", ref: "1", subject: "issue:1", automated: false, outsider: false, receivedAt: 0 });
      store.recordTriage("u1", "x", true);
    }
    return makeTools(
      { rulebook: { file: () => ({}) as never, standingFor: () => [] }, writer: { apply: () => ({ ok: true }) as never, wasUndone: () => false }, asks: { rule: async () => "" }, store, senders: {}, say: async () => undefined, handOver: async () => "", workers },
      { clot: "graphite", kind, ...(o.urgent ? { event: store.getEvent("u1")! } : {}), outsider: false },
    ).startSession({ title: `Fix ${String.fromCharCode(65 + titles++)}`, brief: "b", model: "sonnet", effort: "high" });
  };

  beforeEach(async () => {
    titles = 0;
    gate = SCARCE;
    workers = build({ gate: () => gate, timeZone: "UTC" });
    workers.recover();
    await workers.startUp();
  });

  it("starts a worker asked for in a chat turn, and one from an urgent event's turn", async () => {
    expect(await start("chat")).toContain("Started worker");
    expect(await start("event", { urgent: true })).toContain("Started worker");
    expect(runner.turns).toHaveLength(2);
  });

  it("queues a worker asked for in any other turn, with the tight-usage message, and starts it when the gate lifts", async () => {
    const reply = await start("worker");
    expect(reply).toContain("Queued worker");
    expect(reply).toMatch(/usage is tight \(scarce mode until \d\d:\d\d\)/);
    expect(lines().at(-1)).toMatch(/^Queued: Fix [A-Z] \(Sonnet 5\.5 high\)\. Usage is tight \(scarce mode until \d\d:\d\d\); it starts when that lifts\.$/);
    expect(runner.turns).toHaveLength(0);
    expect(store.queuedWorkers()[0].gateOk).toBe(false);
    gate = FREE;
    workers.wake();
    await settle();
    expect(runner.turns).toHaveLength(1);
  });

  it("does not let a held worker block a later worker that may start", async () => {
    await start("worker");
    await start("chat");
    expect(runner.turns).toHaveLength(1);
    expect(store.queuedWorkers()).toHaveLength(1);
  });

  it("lets a follow-up to a worker that already has a place run", async () => {
    await start("chat");
    const id = "00000001-0000-0000-0000-000000000000";
    finishTurn(runner.turns[0]);
    await settle();
    expect(store.getWorker(id)!.status).toBe("idle");
    gate = SCARCE;
    await workers.message("graphite", id.slice(0, 8), "more please");
    await settle();
    expect(runner.turns).toHaveLength(2);
  });

  it("keeps whether a worker may start across a restart, and a held worker does not hold up one that may start", async () => {
    await start("worker");
    const id = store.queuedWorkers()[0].id;
    expect(store.getWorker(id)!.gateOk).toBe(false);
    const restarted = build({ gate: () => gate, timeZone: "UTC" });
    restarted.recover();
    await restarted.startUp();
    expect(runner.turns).toHaveLength(0);
    expect(store.getWorker(id)!.status).toBe("queued");
    // Pacing has cleared: nothing that may start is queued, so a worker started now begins at once.
    expect(await restarted.start("graphite", { ...fix, title: "Fix later", gateOk: true })).toContain("Started worker");
  });
});

describe("worker spend", () => {
  it("books each worker turn's running total under the worker's session", async () => {
    const booked: unknown[] = [];
    workers = build({ book: async (a) => void booked.push(a) });
    workers.recover();
    await workers.startUp();
    await workers.start("graphite", fix);
    const id = "00000001-0000-0000-0000-000000000000";
    const t = runner.turns.at(-1)!;
    t.req.onText("Changed\n- a.ts");
    finishTurn(t, { totalCostUsd: 0.42 });
    await settle();
    expect(booked).toEqual([{ clot: "graphite", who: `worker:${id}`, sessionId: id, total: 0.42 }]);
  });
});
