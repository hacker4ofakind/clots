import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";

/** The only keys the web app takes from the daemon's `.env`. Everything else in that file (the Claude, GitHub and Composio credentials) stays out of this process. */
export const ROOT_ENV_KEYS = ["CLOTS_UI_SECRET", "CLOTS_DAEMON_URL", "CLOTS_UI_DEV_OWNER", "CLOTS_UI_DEV_HOST", "CLOTS_UI_DEV_ORIGINS", "NEXT_DIST_DIR"];

/**
 * Copies the web app's own settings from the repository's `.env` into the environment, so one file serves the daemon and the web app.
 * A value already in the environment (the service's `data/web.env`, a shell variable) wins. A missing or unreadable file changes nothing.
 */
export function loadRootEnv(file: string, env: Record<string, string | undefined> = process.env): void {
  let parsed: Record<string, string>;
  try {
    parsed = parseEnv(readFileSync(file, "utf8")) as Record<string, string>;
  } catch {
    return;
  }
  for (const key of ROOT_ENV_KEYS) {
    const value = parsed[key];
    if (value !== undefined && env[key] === undefined) env[key] = value;
  }
}
