"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { TrashIcon } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { api, ApiFailure } from "@/lib/api-client";
import { ConfirmDialog } from "../confirm-dialog";
import { ConnectionIcon } from "../connection-icon";
import { PageHeader } from "../field-row";
import { ListCard, ListRow } from "../list-card";
import { Keys } from "./keys";
import { Section } from "./section";

interface Overview {
  inboxes: { account: string; address: string; clot: string | null; shared: boolean; provider: string }[];
  tools: { id: string; toolkit: string; account: string; clot: string | null; shared: boolean; audience: string }[];
}

interface Removal {
  path: string;
  what: string;
}

const titleCase = (text: string) => text.replace(/(^|_)(\w)/g, (_m, sep: string, ch: string) => (sep === "_" ? " " : "") + ch.toUpperCase());
const scope = (x: { shared: boolean; clot: string | null }) => (x.shared ? "Shared" : `${x.clot} only`);

/** Settings, Integrations: the inboxes, the connected tools and the keys. */
export function IntegrationsSettings() {
  const [overview, setOverview] = useState<Overview>();
  const [removal, setRemoval] = useState<Removal>();
  const load = useCallback(() => void api<Overview>("/integrations").then(setOverview).catch(() => undefined), []);
  useEffect(load, [load]);

  const remove = async ({ path, what }: Removal) => {
    try {
      await api(path, { method: "DELETE" });
      toast(`Removed ${what}`);
      load();
    } catch (e) {
      toast(e instanceof ApiFailure ? e.message : "The daemon cannot be reached.");
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Integrations" />
      <Section title="Inboxes">
        {overview?.inboxes.length === 0 ? <p className="text-body text-muted-foreground">No inbox is connected.</p> : null}
        {overview?.inboxes.length ? (
          <ListCard>
            {overview.inboxes.map((inbox) => (
              <ListRow key={inbox.account} className="py-2 pr-2">
                <ConnectionIcon kind="email" address={inbox.address} size={20} />
                <span className="min-w-0 flex-1 truncate text-body">{inbox.address}</span>
                <span className="w-44 text-label font-normal text-muted-foreground">
                  {inbox.provider} · {scope(inbox)}
                </span>
                <Button variant="ghost" size="icon-sm" aria-label={`Remove ${inbox.address}`} onClick={() => setRemoval({ path: `/inboxes/${encodeURIComponent(inbox.account)}`, what: inbox.address })}>
                  <TrashIcon />
                </Button>
              </ListRow>
            ))}
          </ListCard>
        ) : null}
      </Section>
      <Section title="Composio">
        {overview?.tools.length === 0 ? <p className="text-body text-muted-foreground">No tool is connected.</p> : null}
        {overview?.tools.length ? (
          <ListCard>
            {overview.tools.map((tool) => (
              <ListRow key={tool.id} className="py-2 pr-2">
                <ConnectionIcon kind="composio" toolkit={tool.toolkit} size={20} />
                <span className="min-w-0 flex-1 truncate text-body">{titleCase(tool.toolkit)}</span>
                <span className="w-44 text-label font-normal text-muted-foreground">
                  {scope(tool)} · {tool.audience}
                </span>
                <Button variant="ghost" size="icon-sm" aria-label={`Remove ${titleCase(tool.toolkit)} ${tool.account}`} onClick={() => setRemoval({ path: `/integrations/tools/${encodeURIComponent(tool.id)}`, what: `${titleCase(tool.toolkit)}: ${tool.account}` })}>
                  <TrashIcon />
                </Button>
              </ListRow>
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
    </div>
  );
}
