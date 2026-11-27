"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api-client";
import { readableError } from "@/lib/readable-error";
import { useAppState } from "./app-state";

/** The delete step for a Clot, shared by Settings > Manage Clots and the rail's menu: the name typed in to confirm. `target` is the Clot's name, or undefined when closed. */
export function DeleteClotDialog({ target, onClose }: { target: string | undefined; onClose: () => void }) {
  const { refresh } = useAppState();
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  // The typed name and the error belong to one opening; a new target starts clean.
  const [seen, setSeen] = useState(target);
  if (seen !== target) {
    setSeen(target);
    setTyped("");
    setError(undefined);
  }

  const remove = async () => {
    if (!target) return;
    setBusy(true);
    setError(undefined);
    try {
      await api(`/clots/${encodeURIComponent(target)}?confirm=${encodeURIComponent(typed)}`, { method: "DELETE" });
      toast(`Deleted ${target}. Its repository clone and its chat are kept.`);
      onClose();
      setTyped("");
      await refresh();
    } catch (e) {
      setError(readableError(e, "That Clot could not be deleted."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={target !== undefined} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Delete {target}?</DialogTitle>
          <DialogDescription>Its container stops and it is taken out of the configuration. Its repository clone and its chat history stay, and a Clot with the same name later gets them back.</DialogDescription>
        </DialogHeader>
        <label htmlFor="confirm-name" className="text-label text-foreground-soft">
          Type <code className="rounded-sm bg-muted px-1.5 py-0.5 font-mono text-foreground">{target}</code> to confirm
        </label>
        <Input id="confirm-name" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
        {error ? (
          <p role="alert" className="text-body text-primary-ink">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button data-primary variant="destructive" disabled={typed !== target || busy} onClick={() => void remove()}>
            Delete {target}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
