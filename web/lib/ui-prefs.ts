import "server-only";
import { cache } from "react";
import { uiPrefsSchema, type UiPrefs } from "@clots/ui-api-schemas";
import { daemon } from "@/lib/daemon";

/**
 * The preferences the daemon keeps for the UI (theme, content width, pane widths), read once per request however many layouts ask. Undefined
 * when the daemon cannot be reached or answers badly: a page then shows what the browser last knew instead of guessing the defaults.
 */
export const uiPrefs = cache(async (): Promise<UiPrefs | undefined> => {
  try {
    const res = await daemon("/settings/ui", { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return undefined;
    return uiPrefsSchema.parse(await res.json());
  } catch {
    return undefined;
  }
});
