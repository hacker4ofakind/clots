"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { EyeIcon, EyeSlashIcon, KeyIcon, LockSimpleIcon, PencilSimpleIcon, PlusIcon, TrashIcon } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import { Label } from "@/components/ui/label";
import { api, ApiFailure } from "@/lib/api-client";
import { ConfirmDialog } from "../confirm-dialog";
import { ListCard, ListRow } from "../list-card";
import { Section } from "./section";

interface KeyRow {
  name: string;
  last4: string;
  protected: boolean;
}

/** The keys in .env: their names and last four characters. A value is only ever sent, never shown. */
export function Keys() {
  const [keys, setKeys] = useState<KeyRow[]>([]);
  const [editing, setEditing] = useState<{ name: string; replace: boolean }>();
  const [removing, setRemoving] = useState<string>();
  const [value, setValue] = useState("");
  const [show, setShow] = useState(false);
  const [error, setError] = useState<string>();

  const load = useCallback(() => void api<KeyRow[]>("/keys").then(setKeys).catch(() => undefined), []);
  useEffect(load, [load]);

  const open = (next: { name: string; replace: boolean }) => (setEditing(next), setValue(""), setShow(false), setError(undefined));
  const save = async () => {
    if (!editing) return;
    setError(undefined);
    try {
      await api(`/keys/${encodeURIComponent(editing.name)}`, { method: "PUT", body: { value } });
      toast(`Saved ${editing.name}`);
      setEditing(undefined);
      load();
    } catch (e) {
      setError(e instanceof ApiFailure ? e.message : "The daemon cannot be reached.");
    }
  };
  const remove = async (name: string) => {
    try {
      await api(`/keys/${encodeURIComponent(name)}`, { method: "DELETE" });
      toast(`Removed ${name}`);
      load();
    } catch (e) {
      toast(e instanceof ApiFailure ? e.message : "The daemon cannot be reached.");
    }
  };

  return (
    <>
      <Section
        title="Keys"
        action={
          <Button variant="ghost" size="sm" onClick={() => open({ name: "", replace: false })}>
            <PlusIcon /> Add key
          </Button>
        }
      >
        {keys.length > 0 ? (
          <ListCard>
            {keys.map((key) => (
              <ListRow key={key.name} className="py-2 pr-2" data-key={key.name}>
                <KeyIcon size={20} aria-hidden />
                <span className="min-w-0 flex-1 truncate font-mono text-code">{key.name}</span>
                <span className="w-44 font-mono text-caption text-muted-foreground">•••• {key.last4}</span>
                {key.protected ? (
                  <LockSimpleIcon size={18} aria-label="The daemon's own key" className="mx-2 text-muted-foreground" />
                ) : (
                  <>
                    <Button variant="ghost" size="icon-sm" aria-label={`Replace ${key.name}`} onClick={() => open({ name: key.name, replace: true })}>
                      <PencilSimpleIcon />
                    </Button>
                    <Button variant="ghost" size="icon-sm" aria-label={`Remove ${key.name}`} onClick={() => setRemoving(key.name)}>
                      <TrashIcon />
                    </Button>
                  </>
                )}
              </ListRow>
            ))}
          </ListCard>
        ) : (
          <p className="text-body text-muted-foreground">No key is stored.</p>
        )}
      </Section>
      <Dialog open={editing !== undefined} onOpenChange={(next) => !next && setEditing(undefined)}>
        <DialogContent className="max-w-md">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
            className="contents"
          >
            <DialogHeader>
              <DialogTitle>{editing?.replace ? `Replace ${editing.name}` : "Add a key"}</DialogTitle>
            </DialogHeader>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="key-name" className="text-label text-foreground-soft">
                Name
              </Label>
              <Input id="key-name" placeholder="NAME_OF_KEY" value={editing?.name ?? ""} disabled={editing?.replace} onChange={(e) => editing && setEditing({ ...editing, name: e.target.value.toUpperCase() })} className="font-mono text-code md:text-code" autoComplete="off" />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="key-value" className="text-label text-foreground-soft">
                Value
              </Label>
              <InputGroup>
                <InputGroupInput id="key-value" type={show ? "text" : "password"} value={value} onChange={(e) => setValue(e.target.value)} className="font-mono text-code md:text-code" autoComplete="off" />
                <InputGroupAddon align="inline-end">
                  <InputGroupButton size="icon-xs" aria-label={show ? "Hide the value" : "Show the value"} onClick={() => setShow(!show)}>
                    {show ? <EyeSlashIcon /> : <EyeIcon />}
                  </InputGroupButton>
                </InputGroupAddon>
              </InputGroup>
            </div>
            {error ? (
              <p role="alert" className="text-body text-primary-ink">
                {error}
              </p>
            ) : null}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setEditing(undefined)}>
                Cancel
              </Button>
              <Button type="submit" disabled={(editing?.name ?? "") === "" || value === ""}>
                Save
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <ConfirmDialog open={removing !== undefined} onOpenChange={(next) => !next && setRemoving(undefined)} title={`Remove ${removing ?? ""}?`} description="Anything that uses this key stops working until you add it again." confirmLabel="Remove" onConfirm={() => removing && void remove(removing)} />
    </>
  );
}
