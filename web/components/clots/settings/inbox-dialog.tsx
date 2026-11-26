"use client";

import { useState } from "react";
import { toast } from "sonner";
import { CaretDownIcon, CaretRightIcon, EyeIcon, EyeSlashIcon } from "@phosphor-icons/react";
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
const portOf = (text: string): number | undefined => (/^\d{1,5}$/.test(text) && Number(text) >= 1 && Number(text) <= 65535 ? Number(text) : undefined);

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
  const [imapHost, setImapHost] = useState(inbox?.imap?.host ?? "");
  const [imapPort, setImapPort] = useState(String(inbox?.imap?.port ?? 993));
  const [smtpHost, setSmtpHost] = useState(inbox?.smtp?.host ?? "");
  const [smtpPort, setSmtpPort] = useState(String(inbox?.smtp?.port ?? 465));
  const [others, setOthers] = useState((inbox?.addresses ?? []).join(", "));
  const [tell, setTell] = useState(inbox?.tellAddress ?? true);
  // The extra options start open for an inbox that uses any of them, and open when the daemon says a server is missing.
  const [more, setMore] = useState(inbox !== undefined && (!isGmail(inbox.address) || (inbox.addresses ?? []).length > 0 || inbox.tellAddress === false));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  const gmail = isGmail(address);
  const servers = !gmail && imapHost.trim() !== "" && smtpHost.trim() !== "";
  const portsOk = !servers || (portOf(imapPort) !== undefined && portOf(smtpPort) !== undefined);
  const ready = address.includes("@") && (inbox !== undefined || password !== "") && folders(mailboxes).length > 0 && (shared || clot !== "") && portsOk && !saving;

  const save = async () => {
    setSaving(true);
    setError(undefined);
    const extra = folders(others);
    const body = {
      address: address.trim(),
      ...(password === "" ? {} : { password }),
      mailboxes: folders(mailboxes),
      ...(shared ? {} : { clot }),
      ...(servers ? { imap: { host: imapHost.trim(), port: portOf(imapPort) }, smtp: { host: smtpHost.trim(), port: portOf(smtpPort) } } : {}),
      // An edit says what the lists are now (an empty one clears it); a new inbox only says what it was given.
      ...(inbox !== undefined || extra.length > 0 ? { addresses: extra } : {}),
      ...(inbox !== undefined || !tell ? { tellAddress: tell } : {}),
    };
    try {
      if (inbox) await api(`/inboxes/${encodeURIComponent(inbox.account)}`, { method: "PUT", body });
      else await api("/inboxes", { method: "POST", body });
      toast(inbox ? `Saved ${inbox.address}` : `Added ${body.address}`);
      onSaved();
      close();
    } catch (e) {
      setError(reason(e));
      if (!gmail) setMore(true);
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
      <Button type="button" variant="ghost" size="sm" className="self-start" aria-expanded={more} aria-controls="inbox-more" onClick={() => setMore(!more)}>
        {more ? <CaretDownIcon /> : <CaretRightIcon />} More options
      </Button>
      {more ? (
        <div id="inbox-more" className="flex flex-col gap-3 border-l-2 pl-3">
          {gmail ? null : (
            <>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="inbox-imap-host" className="text-label text-foreground-soft">
                  Incoming mail server
                </Label>
                <div className="flex gap-2">
                  <Input id="inbox-imap-host" value={imapHost} onChange={(e) => setImapHost(e.target.value)} placeholder="imap.example.com" autoComplete="off" spellCheck={false} />
                  <Input aria-label="Incoming mail server port" inputMode="numeric" value={imapPort} onChange={(e) => setImapPort(e.target.value.replace(/\D/g, "").slice(0, 5))} className="w-21 font-mono text-code md:text-code" />
                </div>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="inbox-smtp-host" className="text-label text-foreground-soft">
                  Outgoing mail server
                </Label>
                <div className="flex gap-2">
                  <Input id="inbox-smtp-host" value={smtpHost} onChange={(e) => setSmtpHost(e.target.value)} placeholder="smtp.example.com" autoComplete="off" spellCheck={false} />
                  <Input aria-label="Outgoing mail server port" inputMode="numeric" value={smtpPort} onChange={(e) => setSmtpPort(e.target.value.replace(/\D/g, "").slice(0, 5))} className="w-21 font-mono text-code md:text-code" />
                </div>
                {portsOk ? <p className="text-caption text-muted-foreground">Leave both empty for a well-known provider.</p> : <p role="alert" className="text-caption text-primary-ink">A port is a number from 1 to 65535.</p>}
              </div>
            </>
          )}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="inbox-others" className="text-label text-foreground-soft">
              Other addresses
            </Label>
            <Input id="inbox-others" value={others} onChange={(e) => setOthers(e.target.value)} placeholder="support@example.com" autoComplete="off" spellCheck={false} />
            <p className="text-caption text-muted-foreground">Addresses that arrive in this inbox. Separate them with commas.</p>
          </div>
          <FieldRow label="Tell the Clots the address" help="Off: they only see the inbox’s name" htmlFor="inbox-tell">
            <Switch id="inbox-tell" checked={tell} onCheckedChange={setTell} />
          </FieldRow>
        </div>
      ) : null}
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
