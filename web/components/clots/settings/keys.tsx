"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { EyeIcon, EyeSlashIcon, KeyIcon, PencilSimpleIcon, PlusIcon, TrashIcon } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/api-client";
import { readableError } from "@/lib/readable-error";
import { useAppState } from "../app-state";
import { ConfirmDialog } from "../confirm-dialog";
import { ListCard } from "../list-card";
import { ConnectionRow } from "./connection-row";
import { Section } from "./section";

interface KeyRow {
  name: string;
  last4: string;
  protected: boolean;
}

/** The daemon's own keys cannot be changed from here: the buttons say so. */
const OWN_KEY = "This key is the daemon's own. Change it in the .env file.";

/**
 * The keys in .env: their names and last four characters, each with Replace and Remove. A value is only ever sent, never shown. The
 * list loads again when `version` changes (a tool was added or removed, which writes or drops its key) and when the daemon says
 * its configuration changed.
 */
export function Keys({ version }: { version?: unknown }) {
  const { subscribe } = useAppState();
  const [keys, setKeys] = useState<KeyRow[]>([]);
  const [editing, setEditing] = useState<{ name: string; replace: boolean }>();
  const [removing, setRemoving] = useState<string>();
  const [value, setValue] = useState("");
  const [show, setShow] = useState(false);
  const [error, setError] = useState<string>();

  const load = useCallback(() => void api<KeyRow[]>("/keys").then(setKeys).catch(() => undefined), []);
  useEffect(load, [load, version]);
  useEffect(() => subscribe((event) => event.type === "config.changed" && load()), [subscribe, load]);

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
      setError(readableError(e, "That key could not be saved."));
    }
  };
  const remove = async (name: string) => {
    try {
      await api(`/keys/${encodeURIComponent(name)}`, { method: "DELETE" });
      toast(`Removed ${name}`);
      load();
    } catch (e) {
      toast(readableError(e, "That key could not be removed."));
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
              <ConnectionRow key={key.name} data-key={key.name} icon={<KeyIcon size={20} aria-hidden />} label={key.name} mono meta={`•••• ${key.last4}`}>
                <Button variant="ghost" size="icon-sm" aria-label={`Replace ${key.name}`} title={key.protected ? OWN_KEY : undefined} disabled={key.protected} onClick={() => open({ name: key.name, replace: true })}>
                  <PencilSimpleIcon />
                </Button>
                <Button variant="ghost" size="icon-sm" aria-label={`Remove ${key.name}`} title={key.protected ? OWN_KEY : undefined} disabled={key.protected} onClick={() => setRemoving(key.name)}>
                  <TrashIcon />
                </Button>
              </ConnectionRow>
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
