import type { WorkerView } from "@clots/ui-api-schemas";
import { modelLabel } from "../../models.js";
import type { Store, WorkerRow } from "../../store.js";
import { ApiError, type UiApi } from "../server.js";

/** The first line of a brief, at most 140 characters: one line of the worker card. */
const oneLine = (text: string): string => {
  const first = text.trim().split("\n")[0] ?? "";
  return first.length > 140 ? `${first.slice(0, 139)}…` : first;
};

/**
 * What the worker card shows of a worker. Its status folds the daemon's own into what the card says: waiting for a
 * place, running, its pull request opened (whatever happened to the worker after), done with no pull request, or failed.
 */
export function workerView(w: WorkerRow): WorkerView {
  const status = w.status === "queued" ? "queued" : w.status === "running" ? "running" : w.status === "failed" ? "failed" : w.prUrl !== null ? "pr-open" : "done";
  // A running worker that has opened its pull request is working on it still; the card links to it either way.
  return { id: w.id, title: w.title, brief: oneLine(w.brief), model: modelLabel(w.model, w.effort).replace(/ (low|medium|high|xhigh)$/, ""), effort: w.effort, status, ...(w.prUrl === null ? {} : { pr: w.prUrl }) };
}

export function registerWorkerRoutes(api: UiApi, d: { store: Store }): void {
  api.route("GET", "/turns/:id/workers", (req) => {
    const workers = d.store.workersOfTurn(req.params.id!);
    if (workers.length === 0) throw new ApiError(404, "There are no workers for that turn.");
    return { turnId: req.params.id!, clot: workers[0]!.clot, workers: workers.map(workerView) };
  });
}
