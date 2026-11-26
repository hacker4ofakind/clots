"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { FloppyDiskIcon, MonitorIcon, MoonIcon, SunIcon } from "@phosphor-icons/react";
import { CONTENT_WIDTHS, THEMES } from "@clots/ui-api-schemas";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api, ApiFailure } from "@/lib/api-client";
import { readableError } from "@/lib/readable-error";
import { savedText } from "@/lib/setting-labels";
import { useUnsavedGuard } from "@/lib/use-unsaved-guard";
import { useAppState } from "../app-state";
import { ConfirmDialog } from "../confirm-dialog";
import { FieldRow, PageHeader } from "../field-row";
import { Segmented } from "../segmented";
import { Stepper } from "../stepper";
import { TimeInput } from "../time-input";

interface General {
  timeZone: string;
  rolloverPercent: number;
  maxWorkers: number;
  maxProposals: number;
  askTimeoutMinutes: number;
  publicUrl: string;
  error?: string;
}

const THEME_OPTIONS = [
  { value: "system", label: "System", icon: <MonitorIcon /> },
  { value: "light", label: "Light", icon: <SunIcon /> },
  { value: "dark", label: "Dark", icon: <MoonIcon /> },
] as const satisfies readonly { value: (typeof THEMES)[number]; label: string; icon: React.ReactNode }[];

const WIDTH_OPTIONS = CONTENT_WIDTHS.map((value) => ({ value, label: value[0]!.toUpperCase() + value.slice(1) }));

/** Settings, General. Theme and content width are the UI's own and apply at once; the rest save with the Save button and apply as the daemon says. */
export function GeneralSettings() {
  const { prefs, updatePrefs, connection, subscribe } = useAppState();
  const [saved, setSaved] = useState<General>();
  const [form, setForm] = useState<General>();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const zones = useMemo(() => (typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : ["UTC"]), []);

  useEffect(() => {
    void api<General>("/settings/general").then((g) => (setSaved(g), setForm(g))).catch(() => undefined);
  }, []);

  const dirty = form !== undefined && saved !== undefined && JSON.stringify({ ...form, error: undefined }) !== JSON.stringify({ ...saved, error: undefined });
  // A hand edit of the file was picked up (or refused): the page shows what is in force now, unless there are edits of its own to keep.
  const dirtyNow = useRef(false);
  useEffect(
    () =>
      subscribe((e) => {
        if (e.type !== "config.changed" || !(e.data as { fromFile?: boolean } | undefined)?.fromFile) return;
        void api<General>("/settings/general")
          .then((g) => {
            setSaved(g);
            if (!dirtyNow.current) setForm(g);
          })
          .catch(() => undefined);
      }),
    [subscribe],
  );
  dirtyNow.current = dirty;
  // Leaving with unsaved edits asks first.
  const leave = useUnsavedGuard(dirty);

  if (!form) return <PageHeader title="General" />;
  const set = <K extends keyof General>(key: K, value: General[K]) => setForm({ ...form, [key]: value });

  const save = async () => {
    setSaving(true);
    setErrors({});
    try {
      const { error: _e, ...patch } = form;
      const res = await api<General & { applied: string[]; needsRestart: string[] }>("/settings/general", { method: "PUT", body: patch });
      setSaved(res);
      setForm(res);
      toast(savedText(res.needsRestart));
    } catch (error) {
      if (error instanceof ApiFailure && error.status === 400) setErrors((error.body as { errors?: Record<string, string> }).errors ?? {});
      else toast(readableError(error, "Could not save. Try again."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
      className="flex flex-col gap-4"
    >
      <PageHeader title="General">
        <Button type="submit" disabled={saving || connection === "down"}>
          <FloppyDiskIcon /> Save
        </Button>
      </PageHeader>
      {saved?.error ? (
        <p role="alert" className="rounded-card bg-primary-soft px-4 py-3 text-body text-primary-ink">
          clots.config.json was edited by hand and could not be used, so the last good settings stay in force: {saved.error}
        </p>
      ) : null}
      <div>
        <FieldRow label="Time zone" htmlFor="tz" error={errors.timeZone}>
          <Select value={form.timeZone} onValueChange={(v) => set("timeZone", v)}>
            <SelectTrigger id="tz" className="w-55">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="max-h-72">
              {(zones.includes(form.timeZone) ? zones : [form.timeZone, ...zones]).map((z) => (
                <SelectItem key={z} value={z}>
                  {z}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FieldRow>
        <FieldRow label="Theme">
          <Segmented label="Theme" value={prefs.theme} options={[...THEME_OPTIONS]} onValueChange={(theme) => void updatePrefs({ theme })} />
        </FieldRow>
        <FieldRow label="Content width" help="For chats and setup screens">
          <Segmented label="Content width" value={prefs.contentWidth} options={WIDTH_OPTIONS} onValueChange={(contentWidth) => void updatePrefs({ contentWidth })} />
        </FieldRow>
        <FieldRow label="Start a new session at" help="How full a Clot's context gets before it sums up and starts fresh" htmlFor="rollover" error={errors.rolloverPercent}>
          <Stepper id="rollover" label="Start a new session at" value={form.rolloverPercent} min={1} max={100} unit="%" onChange={(v) => set("rolloverPercent", v)} />
        </FieldRow>
        <FieldRow label="Workers at once" help="Per machine, across all Clots" htmlFor="workers" error={errors.maxWorkers}>
          <Stepper id="workers" label="Workers at once" value={form.maxWorkers} min={1} max={20} onChange={(v) => set("maxWorkers", v)} />
        </FieldRow>
        <FieldRow label="Open rule asks per Clot" help="Past this, a Clot suggests the rule in its reply instead" htmlFor="proposals" error={errors.maxProposals}>
          <Stepper id="proposals" label="Open rule asks per Clot" value={form.maxProposals} min={1} max={50} onChange={(v) => set("maxProposals", v)} />
        </FieldRow>
        <FieldRow label="Ask timeout" help="An unanswered ask is blocked after this" htmlFor="timeout" error={errors.askTimeoutMinutes}>
          <TimeInput id="timeout" label="Ask timeout" value={form.askTimeoutMinutes} onChange={(m) => set("askTimeoutMinutes", m)} />
        </FieldRow>
        <FieldRow label="Public URL" htmlFor="url" error={errors.publicUrl}>
          <Input id="url" value={form.publicUrl} onChange={(e) => set("publicUrl", e.target.value)} className="w-75 text-label font-normal md:text-label" />
        </FieldRow>
      </div>
      <ConfirmDialog open={leave.pending} onOpenChange={(open) => !open && leave.cancel()} title="Leave without saving?" description="Your changes to these settings will be lost." confirmLabel="Discard changes" cancelLabel="Keep editing" onConfirm={leave.proceed} />
    </form>
  );
}
