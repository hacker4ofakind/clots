import type { ReactNode } from "react";
import type { AskSnapshot, ClotSummary, UiPrefs } from "@clots/ui-api-schemas";
import { AppShell } from "@/components/clots/app-shell";
import { AppStateProvider } from "@/components/clots/app-state";
import { SidePaneProvider } from "@/components/clots/side-pane";
import { daemonJson } from "@/lib/daemon";
import { uiPrefs } from "@/lib/ui-prefs";

export const dynamic = "force-dynamic";

/** The lists every screen needs, fetched on the server so the first paint has them. A daemon that is down leaves them empty; the banner says so. */
async function initialData(): Promise<{ clots: ClotSummary[]; asks: AskSnapshot[]; prefs: UiPrefs | undefined }> {
  const [lists, prefs] = await Promise.all([Promise.all([daemonJson<ClotSummary[]>("/clots"), daemonJson<AskSnapshot[]>("/asks")]).catch((): [ClotSummary[], AskSnapshot[]] => [[], []]), uiPrefs()]);
  return { clots: lists[0], asks: lists[1], prefs };
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
