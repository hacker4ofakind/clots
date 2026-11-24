"use client";

import { useState } from "react";
import { toast } from "sonner";
import { PlusIcon } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api-client";
import { useIntegrations, useToolkitNames, type ToolRow } from "@/lib/integrations";
import { IntegrationDialog } from "@/components/clots/integration-dialog";
import { ToolTile } from "@/components/clots/tool-tile";

/** The tool tiles and the integration dialog on a page of their own, for the end-to-end tests (the New Clot Tools step hosts them in the app). */
export function ToolTilesHarness() {
  const { overview, reload } = useIntegrations();
  const nameOf = useToolkitNames(overview?.tools.map((t) => t.toolkit) ?? []);
  const [dialog, setDialog] = useState<{ edit?: string; resume?: string; open: boolean }>({ open: false });

  const reconnect = async (tool: ToolRow) => {
    const { jobId } = await api<{ jobId: string }>(`/integrations/tools/${encodeURIComponent(tool.id)}/reconnect`, { method: "POST", body: {} });
    setDialog({ edit: tool.id, resume: jobId, open: true });
  };

  return (
    <div className="flex flex-col gap-4 p-10">
      <h1 className="text-title">Tools</h1>
      <div className="flex flex-wrap items-start gap-2">
        {overview?.tools.map((tool) => (
          <ToolTile
            key={tool.id}
            toolkit={tool.toolkit}
            name={nameOf(tool.toolkit)}
            logo={tool.logo}
            status={tool.status}
            clot="Truecast"
            onEdit={() => setDialog({ edit: tool.id, open: true })}
            onReconnect={() => void reconnect(tool)}
            onRemove={async () => {
              await api(`/integrations/tools/${encodeURIComponent(tool.id)}`, { method: "DELETE" });
              toast(`Removed ${nameOf(tool.toolkit)}`);
              reload();
            }}
          />
        ))}
        <div className="flex w-23 flex-col items-center gap-2 text-caption font-normal text-muted-foreground">
          <Button variant="outline" aria-label="Add a tool" className="size-14 rounded-[14px] border-dashed border-input p-0 text-muted-foreground" onClick={() => setDialog({ open: true })}>
            <PlusIcon size={24} />
          </Button>
          Add
        </div>
      </div>
      <IntegrationDialog clot="Truecast" open={dialog.open} onOpenChange={(open) => setDialog((d) => ({ ...d, open }))} edit={dialog.edit} resume={dialog.resume} onAdded={() => reload()} />
    </div>
  );
}
