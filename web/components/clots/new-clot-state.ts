import type { ClotIcon } from "@clots/ui-api-schemas";
import type { Toolkit, ToolOptions } from "@/lib/integrations";

export type Step = "details" | "tools" | "create";
export const STEPS: readonly Step[] = ["details", "tools", "create"];

export type BuildStep = "cloning" | "building" | "starting" | "done" | "failed";
export interface Build {
  step: BuildStep;
  log?: string;
}

/** What a Clot has when it was made without choosing an icon: the same everywhere (the rail, the phone's list, Settings, the picker). */
export const DEFAULT_ICON = { phosphor: "Sliders", color: "red" } satisfies ClotIcon;

/** The icon as one address parameter: "Sliders.ink", or "upload.<id>". */
export function iconToParam(icon: ClotIcon): string {
  return "upload" in icon ? `upload.${icon.upload}` : `${icon.phosphor}.${icon.color}`;
}

export function iconFromParam(value: string | null): ClotIcon | undefined {
  if (value === null) return undefined;
  const [head, tail] = value.split(".");
  if (!head || !tail) return undefined;
  if (head === "upload") return /^[a-f0-9]{16}$/.test(tail) ? { upload: tail } : undefined;
  return /^[A-Z][A-Za-z0-9]{0,40}$/.test(head) && /^[a-z]{2,10}$/.test(tail) ? { phosphor: head, color: tail } : undefined;
}

/** A tool connected in the Tools step for a Clot that does not exist yet: the daemon holds it under this job until Create. */
export interface HeldTool {
  jobId: string;
  toolkit: Toolkit;
  options: ToolOptions;
  /** "failed" when a second run of the job (Edit settings) did not work: Create would refuse it. */
  state: "active" | "failed";
}

const STORE = "clots:new:tools";

/** The held tools remembered across a reload (the address only carries the jobs). Storage may be blocked, so it is never relied on. */
export function rememberHeld(tools: HeldTool[]): void {
  try {
    sessionStorage.setItem(STORE, JSON.stringify(tools.map(({ jobId, toolkit, options }) => ({ jobId, toolkit, options }))));
  } catch {
    // The tiles then come back from the daemon's job, with the default options.
  }
}

export function recalledHeld(): Pick<HeldTool, "jobId" | "toolkit" | "options">[] {
  try {
    const list = JSON.parse(sessionStorage.getItem(STORE) ?? "[]") as unknown;
    return Array.isArray(list) ? (list as Pick<HeldTool, "jobId" | "toolkit" | "options">[]) : [];
  } catch {
    return [];
  }
}

/** Whether two Clot names are the same Clot (the daemon compares them in lower case). */
export const sameName = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
