import type { Effort, WorkerModel } from "./types.js";

export const OPUS = "claude-opus-5-5";
export const SONNET = "claude-sonnet-5-5";
export const HAIKU = "claude-haiku-5-5";

/** The model a worker is started with, by the name the main session gives it. */
export const WORKER_MODELS: Record<WorkerModel, string> = { opus: OPUS, sonnet: SONNET, haiku: HAIKU };

const NAMES: Record<WorkerModel, string> = { opus: "Opus 5.5", sonnet: "Sonnet 5.5", haiku: "Haiku 5.5" };

/** How a worker's model is shown to the user: "Sonnet 5.5 high". */
export function modelLabel(model: WorkerModel, effort: Effort): string {
  return `${NAMES[model]} ${effort}`;
}

/** One step cheaper, for a worker's model and effort while usage is tight. Haiku stays as it is. */
export const CHEAPER_WORKERS: [string, string][] = [
  ["Opus xhigh", "Opus high"],
  ["Opus high", "Opus medium"],
  ["Opus medium", "Sonnet high"],
  ["Sonnet high", "Sonnet medium"],
];
