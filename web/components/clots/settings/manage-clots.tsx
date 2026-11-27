"use client";

import { useState } from "react";
import Link from "next/link";
import { PencilSimpleIcon, PlusIcon, TrashIcon } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { clotLabel, STATE_TONE, STATE_WORD } from "@/lib/clots";
import { useAppState } from "../app-state";
import { ClotIcon } from "../clot-icon";
import { DeleteClotDialog } from "../delete-clot-dialog";
import { PageHeader } from "../field-row";
import { IconTile } from "../icon-tile";
import { ListCard, ListRow } from "../list-card";
import { StatusDot } from "../status-dot";

/** Every Clot with its icon, repository, state, Edit and Delete. Delete asks for the name typed in; the home Clot has none. */
export function ManageClots() {
  const { clots } = useAppState();
  const [target, setTarget] = useState<string>();
  return (
    <>
      <PageHeader title="Manage Clots">
        <Button asChild variant="outline">
          <Link href="/new">
            <PlusIcon /> New Clot
          </Link>
        </Button>
      </PageHeader>
      <ListCard>
        {clots.map((clot) => (
          <ListRow key={clot.name} className="gap-3.5 py-3">
            <IconTile>
              <ClotIcon icon={clot.icon} home={clot.home} size={22} />
            </IconTile>
            <div className="min-w-0 flex-1">
              <p className="truncate text-chat font-semibold">{clotLabel(clot)}</p>
              {clot.home || clot.repository === null ? (
                <p className="truncate text-label font-normal text-muted-foreground">No repository · takes what belongs to no project</p>
              ) : (
                <p className="truncate font-mono text-caption text-muted-foreground">{clot.repository}</p>
              )}
            </div>
            <span className="flex w-27 items-center gap-1.5 text-label font-normal text-muted-foreground">
              <StatusDot tone={STATE_TONE[clot.state]} />
              {STATE_WORD[clot.state]}
            </span>
            <Button asChild variant="ghost" size="icon" aria-label={`Edit ${clotLabel(clot)}`}>
              <Link href={`/new?edit=${encodeURIComponent(clot.name)}`}>
                <PencilSimpleIcon />
              </Link>
            </Button>
            <Button variant="ghost" size="icon" aria-label={`Delete ${clotLabel(clot)}`} disabled={clot.home} onClick={() => setTarget(clot.name)}>
              <TrashIcon />
            </Button>
          </ListRow>
        ))}
      </ListCard>
      <DeleteClotDialog target={target} onClose={() => setTarget(undefined)} />
    </>
  );
}
