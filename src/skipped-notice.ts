import type { SkippedAccount } from "./config.js";

/** The slice of the store this needs: the daemon's key-value state. */
export interface NoticeState {
  getState(key: string): string | undefined;
  setState(key: string, value: string): void;
}

const KEY = "skipped-entry-notices";

/** What was told, by entry: the problem as it was told. */
function told(state: NoticeState): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(state.getState(KEY) ?? "{}");
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/** The note for an entry the loader left out, in plain words. */
export function skippedEntryNote(s: { entry: string; problem: string }): string {
  const missing = [...s.problem.matchAll(/\b([A-Z][A-Z0-9_]*) is not set in \.env/g)].map((m) => m[1]!);
  const reason = missing.length > 0 ? `the key ${[...new Set(missing)].join(", ")} is missing from .env` : s.problem.replaceAll(/sources\.composio\[\d+\]\./g, "").replaceAll("(account)", "the entry");
  return `The tool ${s.entry} in clots.config.json cannot be used (${reason}), so Clots leaves it out. Everything else keeps running. Fix it or remove it under Settings, Integrations.`;
}

/**
 * Tells about the entries the loader left out, once per distinct problem: what was already told (kept in the state, so a restart does
 * not tell it again) is not repeated, a problem that changed is told again, and an entry that is fixed or gone is forgotten, so it
 * is told again if it breaks later.
 */
export async function announceSkipped(state: NoticeState, skipped: SkippedAccount[], tell: (text: string) => Promise<void>): Promise<void> {
  const before = told(state);
  const now: Record<string, string> = {};
  for (const s of skipped) {
    now[s.entry] = s.problem;
    if (before[s.entry] === s.problem) continue;
    try {
      await tell(skippedEntryNote(s));
    } catch {
      // Not told: it stays out of the record, so the next start tells it.
      delete now[s.entry];
    }
  }
  if (JSON.stringify(now) !== JSON.stringify(before)) state.setState(KEY, JSON.stringify(now));
}
