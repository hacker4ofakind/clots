"use client";

import { useState } from "react";
import { toast } from "sonner";
import { ArrowsClockwiseIcon, PencilSimpleIcon, PlusIcon, TrashIcon } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { api, ApiFailure } from "@/lib/api-client";
import { scopeLabel, useIntegrations, useToolkitNames, type InboxRow, type ToolRow } from "@/lib/integrations";
import { ConfirmDialog } from "../confirm-dialog";
import { ConnectionIcon } from "../connection-icon";
import { PageHeader } from "../field-row";
import { IntegrationDialog } from "../integration-dialog";
import { ListCard } from "../list-card";
import { ConnectionRow } from "./connection-row";
import { InboxDialog } from "./inbox-dialog";
import { Keys } from "./keys";
import { Section } from "./section";

interface Removal {
  path: string;
  what: string;
}

const failure = (e: unknown) => (e instanceof ApiFailure ? e.message : "The daemon cannot be reached.");

/** The words under a tool's name: where it is used and who can see it, or what is wrong with it. */
function toolMeta(tool: ToolRow): string {
  if (tool.restartNeeded) return "Restart the daemon to finish";
  if (tool.status === "failed") return "Sign in again";
  if (tool.status === "waiting") return "Waiting for sign-in";
  return `${scopeLabel(tool)} · ${tool.audience}`;
}

/** Settings, Integrations: the inboxes, the Composio tools and the keys. */
export function IntegrationsSettings() {
  const { overview, reload } = useIntegrations();
  const nameOf = useToolkitNames(overview?.tools.map((t) => t.toolkit) ?? []);
  const [removal, setRemoval] = useState<Removal>();
  // What a dialog was opened for stays while it closes, so its exit animation shows the same content.
  const [inbox, setInbox] = useState<{ edit?: InboxRow; open: boolean }>({ open: false });
  const [tool, setTool] = useState<{ edit?: string; resume?: string; open: boolean }>({ open: false });

  const remove = async ({ path, what }: Removal) => {
    try {
      await api(path, { method: "DELETE" });
      toast(`Removed ${what}`);
    } catch (e) {
      toast(failure(e));
    }
    reload();
  };

  // Reconnecting deletes the connection and makes a new link: the dialog picks the job up at its connect step.
  const reconnect = async (row: ToolRow) => {
    try {
      const { jobId } = await api<{ jobId: string }>(`/integrations/tools/${encodeURIComponent(row.id)}/reconnect`, { method: "POST", body: {} });
      setTool({ edit: row.id, resume: jobId, open: true });
    } catch (e) {
      toast(failure(e));
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Integrations" />
      <Section
        title="Inboxes"
        action={
          <Button variant="ghost" size="sm" onClick={() => setInbox({ open: true })}>
            <PlusIcon /> Add inbox
          </Button>
        }
      >
        {overview?.inboxes.length === 0 ? <p className="text-body text-muted-foreground">No inbox is connected.</p> : null}
        {overview?.inboxes.length ? (
          <ListCard>
            {overview.inboxes.map((row) => (
              <ConnectionRow key={row.account} icon={<ConnectionIcon kind="email" address={row.address} size={20} />} label={row.address} meta={[row.provider === "Gmail" ? "Gmail" : undefined, scopeLabel(row)].filter(Boolean).join(" · ")}>
                <Button variant="ghost" size="icon-sm" aria-label={`Edit ${row.address}`} onClick={() => setInbox({ edit: row, open: true })}>
                  <PencilSimpleIcon />
                </Button>
                <Button variant="ghost" size="icon-sm" aria-label={`Remove ${row.address}`} onClick={() => setRemoval({ path: `/inboxes/${encodeURIComponent(row.account)}`, what: row.address })}>
                  <TrashIcon />
                </Button>
              </ConnectionRow>
            ))}
          </ListCard>
        ) : null}
      </Section>
      <Section
        title="Composio"
        action={
          <Button variant="ghost" size="sm" onClick={() => setTool({ open: true })}>
            <PlusIcon /> Add a tool
          </Button>
        }
      >
        {overview?.tools.length === 0 ? <p className="text-body text-muted-foreground">No tool is connected.</p> : null}
        {overview?.tools.length ? (
          <ListCard>
            {overview.tools.map((row) => (
              <ConnectionRow key={row.id} icon={<ConnectionIcon kind="composio" toolkit={row.toolkit} size={20} />} label={overview.tools.filter((t) => t.toolkit === row.toolkit).length > 1 ? `${nameOf(row.toolkit)} (${row.account})` : nameOf(row.toolkit)} meta={toolMeta(row)}>
                {row.status === "failed" ? (
                  <Button variant="ghost" size="icon-sm" aria-label={`Reconnect ${nameOf(row.toolkit)}`} onClick={() => void reconnect(row)}>
                    <ArrowsClockwiseIcon />
                  </Button>
                ) : null}
                <Button variant="ghost" size="icon-sm" aria-label={`Edit ${nameOf(row.toolkit)}`} onClick={() => setTool({ edit: row.id, open: true })}>
                  <PencilSimpleIcon />
                </Button>
                <Button variant="ghost" size="icon-sm" aria-label={`Remove ${nameOf(row.toolkit)}`} onClick={() => setRemoval({ path: `/integrations/tools/${encodeURIComponent(row.id)}`, what: nameOf(row.toolkit) })}>
                  <TrashIcon />
                </Button>
              </ConnectionRow>
            ))}
          </ListCard>
        ) : null}
      </Section>
      <Keys />
      <ConfirmDialog
        open={removal !== undefined}
        onOpenChange={(open) => !open && setRemoval(undefined)}
        title={`Remove ${removal?.what ?? ""}?`}
        description="The Clots stop using it. You can connect it again later."
        confirmLabel="Remove"
        onConfirm={() => removal && void remove(removal)}
      />
      <InboxDialog open={inbox.open} onOpenChange={(open) => setInbox((s) => ({ ...s, open }))} inbox={inbox.edit} onSaved={reload} />
      <IntegrationDialog open={tool.open} onOpenChange={(open) => setTool((s) => ({ ...s, open }))} edit={tool.edit} resume={tool.resume} onAdded={reload} />
    </div>
  );
}
