"use client";

import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { PlusIcon } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { api, ApiFailure } from "@/lib/api-client";
import { useIntegrations, useToolkitNames, type Job, type ToolRow } from "@/lib/integrations";
import { IntegrationDialog, type AddedInfo } from "./integration-dialog";
import { sameName, type HeldTool } from "./new-clot-state";
import { useAppState } from "./app-state";
import { ToolTile } from "./tool-tile";

interface DialogState {
  open: boolean;
  edit?: string;
  resume?: string;
  retool?: HeldTool;
}

/**
 * The Tools step: the accounts shared with every Clot first (nothing to change here: Settings manages them), then the tools this
 * Clot has. For a Clot that does not exist yet those are connections the daemon holds until Create (`held`); for one being edited
 * they are the Clot's own entries. Add a tool opens the integration dialog for the Clot.
 */
export function ToolsStep({ name, exists, held, onHeld, problem }: { name: string; exists: boolean; held: HeldTool[]; onHeld: (next: HeldTool[] | ((prev: HeldTool[]) => HeldTool[])) => void; problem?: string }) {
  const { overview, reload } = useIntegrations();
  const { subscribe } = useAppState();
  const [dialog, setDialog] = useState<DialogState>({ open: false });

  const shared = useMemo(() => (overview?.tools ?? []).filter((t) => t.shared), [overview]);
  const own = useMemo(() => (overview?.tools ?? []).filter((t) => !t.shared && t.clot !== null && sameName(t.clot, name)), [overview, name]);
  const nameOf = useToolkitNames([...shared, ...own].map((t) => t.toolkit));

  // A held connection that fails when it is run again (Edit settings) is marked, since Create would refuse it.
  useEffect(
    () =>
      subscribe((event) => {
        if (event.type !== "integration.status") return;
        const data = event.data as { jobId?: string; state?: string };
        if (data.state !== "failed" && data.state !== "active") return;
        onHeld((list) => (list.some((h) => h.jobId === data.jobId) ? list.map((h) => (h.jobId === data.jobId ? { ...h, state: data.state as HeldTool["state"] } : h)) : list));
      }),
    [subscribe, onHeld],
  );

  const added = async (jobId: string, info?: AddedInfo) => {
    if (exists) return reload();
    // A tool made shared with every Clot in the dialog is written at once and shows in the shared list; the others are held.
    const job = await api<Job & { held?: boolean }>(`/integrations/jobs/${jobId}`).catch(() => undefined);
    if (job?.held !== true || info === undefined) return reload();
    const toolkit = info.toolkit ?? { slug: job.toolkit, name: job.name ?? job.toolkit, auth: "oauth" as const };
    onHeld((list) => [...list.filter((h) => h.jobId !== jobId), { jobId, toolkit, options: info.options, state: "active" }]);
  };

  const reconnect = async (tool: ToolRow) => {
    try {
      const { jobId } = await api<{ jobId: string }>(`/integrations/tools/${encodeURIComponent(tool.id)}/reconnect`, { method: "POST", body: {} });
      setDialog({ open: true, edit: tool.id, resume: jobId });
    } catch (e) {
      toast(e instanceof ApiFailure ? e.message : "That tool could not be reconnected.");
    }
  };

  const remove = async (tool: ToolRow) => {
    try {
      await api(`/integrations/tools/${encodeURIComponent(tool.id)}`, { method: "DELETE" });
      toast(`Removed ${nameOf(tool.toolkit)}`);
      reload();
    } catch (e) {
      toast(e instanceof ApiFailure ? e.message : "That tool could not be removed.");
    }
  };

  const dropHeld = async (tool: HeldTool) => {
    onHeld((list) => list.filter((h) => h.jobId !== tool.jobId));
    await api(`/integrations/jobs/${tool.jobId}/abandon`, { method: "POST", body: {} }).catch(() => undefined);
    toast(`Removed ${tool.toolkit.name}`);
  };

  return (
    <div className="flex flex-1 flex-col gap-4">
      <div>
        <h2 className="text-section">Tools</h2>
        <p className="text-label font-normal text-muted-foreground">Connected through Composio. Shared ones are already here.</p>
      </div>
      <div className="flex flex-wrap items-start gap-2" aria-busy={overview === undefined}>
        {overview === undefined
          ? [0, 1, 2].map((i) => (
              <div key={i} className="flex w-23 flex-col items-center gap-2">
                <Skeleton className="size-14 rounded-[14px]" />
                <Skeleton className="h-3 w-12" />
              </div>
            ))
          : null}
        {shared.map((tool) => (
          <ToolTile key={tool.id} toolkit={tool.toolkit} name={nameOf(tool.toolkit)} logo={tool.logo} status={tool.status} clot={name} />
        ))}
        {own.map((tool) => (
          <ToolTile
            key={tool.id}
            toolkit={tool.toolkit}
            name={nameOf(tool.toolkit)}
            logo={tool.logo}
            status={tool.status}
            clot={name}
            onEdit={() => setDialog({ open: true, edit: tool.id })}
            onReconnect={() => void reconnect(tool)}
            onRemove={() => remove(tool)}
          />
        ))}
        {held.map((tool) => (
          <ToolTile key={tool.jobId} toolkit={tool.toolkit.slug} name={tool.toolkit.name} logo={tool.toolkit.logo} status={tool.state === "failed" ? "failed" : "active"} clot={name} onEdit={() => setDialog({ open: true, retool: tool })} onRemove={() => dropHeld(tool)} />
        ))}
        <div className="flex w-23 flex-col items-center gap-2 text-caption font-normal text-muted-foreground">
          <Button variant="outline" aria-label="Add a tool" className="size-14 rounded-[14px] border-dashed border-input p-0 text-muted-foreground" onClick={() => setDialog({ open: true })}>
            <PlusIcon size={24} />
          </Button>
          Add
        </div>
      </div>
      {problem ? (
        <p role="alert" className="text-body text-primary-ink">
          {problem}
        </p>
      ) : null}
      <IntegrationDialog
        clot={name}
        open={dialog.open}
        onOpenChange={(open) => setDialog((d) => ({ ...d, open }))}
        edit={dialog.edit}
        resume={dialog.resume}
        retool={dialog.retool}
        added={held.map((h) => h.toolkit.slug)}
        onAdded={(jobId, info) => void added(jobId, info)}
      />
    </div>
  );
}
