/**
 * What the daemon's configuration keys are called to a person: the General settings page's own labels for the ones it shows, and
 * plain names for the rest. A toast about a key that needs a restart uses these, never the key.
 */
const LABELS: Record<string, string> = {
  timeZone: "Time zone",
  rolloverPercent: "Start a new session at",
  maxWorkers: "Workers at once",
  maxProposals: "Open rule asks per Clot",
  askTimeoutMinutes: "Ask timeout",
  // The old name of askTimeoutMinutes, which a file written before the rename still has.
  choiceTimeoutMinutes: "Ask timeout",
  publicUrl: "Public URL",
  intake: "The intake port",
  image: "The Clot image",
  ui: "The UI owner",
  rulebookDir: "The rulebook folder",
  home: "The Home Clot",
  hold: "The wait for events",
  sweep: "Looking through the connectors",
  spend: "The spending warning",
  gates: "The schedule",
  clots: "The Clots list",
  sources: "The connected tools",
};

export const settingLabel = (key: string): string => LABELS[key] ?? "A setting";

/** "Ask timeout takes effect after a restart." for the keys that need one (each label once, in the order given). */
export function restartText(keys: string[]): string {
  const labels = [...new Set(keys.map(settingLabel))];
  return `${labels.join(", ")} ${labels.length === 1 ? "takes" : "take"} effect after a restart.`;
}

/** The toast after a save from General: plain "Saved", or which settings only take effect after a restart. */
export const savedText = (needsRestart: string[]): string => (needsRestart.length === 0 ? "Saved" : `Saved. ${restartText(needsRestart)}`);
