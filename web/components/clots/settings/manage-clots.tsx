"use client";

import { useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { PencilSimpleIcon, PlusIcon, TrashIcon } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api-client";
import { readableError } from "@/lib/readable-error";
import { clotLabel, STATE_TONE, STATE_WORD } from "@/lib/clots";
import { useAppState } from "../app-state";
import { ClotIcon } from "../clot-icon";
import { PageHeader } from "../field-row";
import { IconTile } from "../icon-tile";
import { ListCard, ListRow } from "../list-card";
import { StatusDot } from "../status-dot";

/** Every Clot with its icon, repository, state, Edit and Delete. Delete asks for the name typed in; the home Clot has none. */
export function ManageClots() {
  const { clots, refresh } = useAppState();
  const [target, setTarget] = useState<string>();
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const remove = async () => {
    if (!target) return;
    setBusy(true);
    setError(undefined);
    try {
      await api(`/clots/${encodeURIComponent(target)}?confirm=${encodeURIComponent(typed)}`, { method: "DELETE" });
      toast(`Deleted ${target}. Its repository clone and its chat are kept.`);
      setTarget(undefined);
      setTyped("");
      await refresh();
    } catch (e) {
      setError(readableError(e, "That Clot could not be deleted."));
    } finally {
      setBusy(false);
    }
  };

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
            <Button variant="ghost" size="icon" aria-label={`Delete ${clotLabel(clot)}`} disabled={clot.home} onClick={() => (setTarget(clot.name), setTyped(""), setError(undefined))}>
              <TrashIcon />
            </Button>
          </ListRow>
        ))}
      </ListCard>
      <Dialog open={target !== undefined} onOpenChange={(open) => !open && setTarget(undefined)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Delete {target}?</DialogTitle>
            <DialogDescription>Its container stops and it is taken out of the configuration. Its repository clone and its chat history stay, and a Clot with the same name later gets them back.</DialogDescription>
          </DialogHeader>
          <label htmlFor="confirm-name" className="text-label text-foreground-soft">
            Type {target} to confirm
          </label>
          <Input id="confirm-name" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
          {error ? (
            <p role="alert" className="text-body text-primary-ink">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setTarget(undefined)}>
              Cancel
            </Button>
            <Button variant="destructive" disabled={typed !== target || busy} onClick={() => void remove()}>
              Delete {target}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
