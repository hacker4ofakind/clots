"use client";

import { useState } from "react";
import { toast } from "sonner";
import { EyeIcon, EyeSlashIcon } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput, InputGroupText } from "@/components/ui/input-group";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { api } from "@/lib/api-client";
import { readableReasons } from "@/lib/readable-error";
import { clotLabel } from "@/lib/clots";
import type { InboxRow } from "@/lib/integrations";
import { useAppState } from "../app-state";
import { ConnectionIcon, isGmail } from "../connection-icon";
import { FieldRow } from "../field-row";

const folders = (text: string): string[] => text.split(",").map((f) => f.trim()).filter(Boolean);

/** What the daemon refused, in words: a failed save lists its reasons under `errors`. */
const reason = (e: unknown): string => readableReasons(e, "The inbox could not be saved. Check the details and try again.");

/**
 * Adds an inbox, or edits one (`inbox` given): the address, which picks the provider's icon (Gmail or a plain envelope), the
 * password (sent to the daemon's `.env`, never shown again), the folders to watch, and whether every Clot or only one reads it.
 */
export function InboxDialog({ open, onOpenChange, inbox, onSaved }: { open: boolean; onOpenChange: (open: boolean) => void; inbox?: InboxRow; onSaved: () => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-describedby={undefined} className="max-w-md">
        <InboxForm inbox={inbox} close={() => onOpenChange(false)} onSaved={onSaved} />
      </DialogContent>
    </Dialog>
  );
}

function InboxForm({ inbox, close, onSaved }: { inbox?: InboxRow; close: () => void; onSaved: () => void }) {
  const { clots } = useAppState();
  const [address, setAddress] = useState(inbox?.address ?? "");
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [mailboxes, setMailboxes] = useState((inbox?.mailboxes ?? ["INBOX"]).join(", "));
  const [shared, setShared] = useState(inbox?.shared ?? true);
  const [clot, setClot] = useState(inbox?.clot ?? clots[0]?.name ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  const gmail = isGmail(address);
  const ready = address.includes("@") && (inbox !== undefined || password !== "") && folders(mailboxes).length > 0 && (shared || clot !== "") && !saving;

  const save = async () => {
    setSaving(true);
    setError(undefined);
    const body = { address: address.trim(), ...(password === "" ? {} : { password }), mailboxes: folders(mailboxes), ...(shared ? {} : { clot }) };
    try {
      if (inbox) await api(`/inboxes/${encodeURIComponent(inbox.account)}`, { method: "PUT", body });
      else await api("/inboxes", { method: "POST", body });
      toast(inbox ? `Saved ${inbox.address}` : `Added ${body.address}`);
      onSaved();
      close();
    } catch (e) {
      setError(reason(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (ready) void save();
      }}
      className="contents"
    >
      <DialogHeader>
        <DialogTitle>{inbox ? "Edit inbox" : "Add an inbox"}</DialogTitle>
      </DialogHeader>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="inbox-address" className="text-label text-foreground-soft">
          Address
        </Label>
        <InputGroup>
          <InputGroupAddon>
            <ConnectionIcon kind="email" address={address} size={18} />
          </InputGroupAddon>
          <InputGroupInput id="inbox-address" type="email" value={address} disabled={inbox !== undefined} onChange={(e) => setAddress(e.target.value)} placeholder="you@example.com" autoComplete="off" />
          {gmail ? (
            <InputGroupAddon align="inline-end">
              <InputGroupText>Gmail</InputGroupText>
            </InputGroupAddon>
          ) : null}
        </InputGroup>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="inbox-password" className="text-label text-foreground-soft">
          {gmail ? "App password" : "Password"}
        </Label>
        <InputGroup>
          <InputGroupInput id="inbox-password" type={show ? "text" : "password"} value={password} onChange={(e) => setPassword(e.target.value)} placeholder={inbox ? "Leave empty to keep it" : undefined} autoComplete="off" />
          <InputGroupAddon align="inline-end">
            <InputGroupButton size="icon-xs" aria-label={show ? "Hide the password" : "Show the password"} aria-pressed={show} onClick={() => setShow(!show)}>
              {show ? <EyeSlashIcon /> : <EyeIcon />}
            </InputGroupButton>
          </InputGroupAddon>
        </InputGroup>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="inbox-folders" className="text-label text-foreground-soft">
          Folders to watch
        </Label>
        <Input id="inbox-folders" value={mailboxes} onChange={(e) => setMailboxes(e.target.value)} placeholder="INBOX" autoComplete="off" />
        <p className="text-caption text-muted-foreground">Separate them with commas. In Gmail they are labels.</p>
      </div>
      <div className="flex flex-col">
        <FieldRow label="Share with every Clot" htmlFor="inbox-shared">
          <Switch id="inbox-shared" checked={shared} onCheckedChange={setShared} />
        </FieldRow>
        {shared ? null : (
          <FieldRow label="Only this Clot" htmlFor="inbox-clot">
            <Select value={clot} onValueChange={setClot}>
              <SelectTrigger id="inbox-clot" className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {clots.map((c) => (
                  <SelectItem key={c.name} value={c.name}>
                    {clotLabel(c)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FieldRow>
        )}
      </div>
      {error ? (
        <p role="alert" className="text-body text-primary-ink">
          {error}
        </p>
      ) : null}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={close}>
          Cancel
        </Button>
        <Button type="submit" disabled={!ready}>
          {saving ? <Spinner /> : null}
          {inbox ? "Save" : "Add inbox"}
        </Button>
      </DialogFooter>
    </form>
  );
}
