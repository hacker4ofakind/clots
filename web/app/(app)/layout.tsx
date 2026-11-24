import type { ReactNode } from "react";
import { uiPrefsSchema, type AskSnapshot, type ClotSummary, type UiPrefs } from "@clots/ui-api-schemas";
import { AppShell } from "@/components/clots/app-shell";
import { AppStateProvider } from "@/components/clots/app-state";
import { SidePaneProvider } from "@/components/clots/side-pane";
import { daemonJson } from "@/lib/daemon";

export const dynamic = "force-dynamic";

/** The lists every screen needs, fetched on the server so the first paint has them. A daemon that is down leaves them empty; the banner says so. */
async function initialData(): Promise<{ clots: ClotSummary[]; asks: AskSnapshot[]; prefs: UiPrefs }> {
  const [clots, asks, prefs] = await Promise.all([daemonJson<ClotSummary[]>("/clots"), daemonJson<AskSnapshot[]>("/asks"), daemonJson<UiPrefs>("/settings/ui")]).catch((): [ClotSummary[], AskSnapshot[], UiPrefs] => [[], [], uiPrefsSchema.parse({})]);
  return { clots, asks, prefs };
}

export default async function AppLayout({ children }: { children: ReactNode }) {
  const initial = await initialData();
  return (
    <AppStateProvider initial={initial}>
      <SidePaneProvider>
        <AppShell>{children}</AppShell>
      </SidePaneProvider>
    </AppStateProvider>
  );
}
