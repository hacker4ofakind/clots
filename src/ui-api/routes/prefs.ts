import { uiPrefsPatchSchema, uiPrefsSchema, type UiPrefs } from "@clots/ui-api-schemas";
import type { Store } from "../../store.js";
import { parseBody, type UiApi } from "../server.js";

const KEY = "ui";

/** The UI's preferences, with the defaults for what was never set. */
export function readPrefs(store: Store): UiPrefs {
  const stored = store.conversation.pref(KEY);
  const parsed = uiPrefsSchema.safeParse(stored ?? {});
  return parsed.success ? parsed.data : uiPrefsSchema.parse({});
}

export function registerPrefsRoutes(api: UiApi, d: { store: Store; emit: (data: UiPrefs) => void }): void {
  api.route("GET", "/settings/ui", () => readPrefs(d.store));

  // A patch: the side pane's width of one Clot changes without touching the rest.
  api.route("PUT", "/settings/ui", (req) => {
    const patch = parseBody(uiPrefsPatchSchema, req.body);
    const before = readPrefs(d.store);
    const next: UiPrefs = { ...before, ...patch, paneWidths: { ...before.paneWidths, ...(patch.paneWidths ?? {}) } };
    d.store.conversation.setPref(KEY, next);
    d.emit(next);
    return next;
  });
}
