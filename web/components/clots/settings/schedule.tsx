"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ArrowCounterClockwiseIcon, FloppyDiskIcon } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { api, ApiFailure } from "@/lib/api-client";
import { readableError } from "@/lib/readable-error";
import { savedText } from "@/lib/setting-labels";
import { useUnsavedGuard } from "@/lib/use-unsaved-guard";
import { useAppState } from "../app-state";
import { ConfirmDialog } from "../confirm-dialog";
import { FieldRow, PageHeader } from "../field-row";
import { Stepper } from "../stepper";
import { ListCard, ListRow } from "../list-card";
import { Section } from "./section";

interface Row {
  day: "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";
  on: boolean;
  from: string;
  to: string;
}
interface Schedule {
  timeZone: string;
  scarce: Row[];
  leadIn: Row[];
  leadInPercent: number;
  error?: string;
}

const DAY_NAMES: Record<Row["day"], string> = { mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday", fri: "Friday", sat: "Saturday", sun: "Sunday" };
const SHORT: Record<Row["day"], string> = { mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun" };

/** The daemon's own defaults, for Restore defaults: weekdays only. */
const defaults = (from: string, to: string): Row[] => (Object.keys(DAY_NAMES) as Row["day"][]).map((day) => ({ day, on: !["sat", "sun"].includes(day), from, to }));
const SCARCE_DEFAULT = defaults("15:00", "18:00");
const LEAD_IN_DEFAULT = defaults("10:00", "15:00");
const DEFAULT_PERCENT = 50;

/** One gate's windows: a row per weekday with a switch and a from and a to time. */
function Windows({ gate, rows, errors, onChange }: { gate: "scarce" | "leadIn"; rows: Row[]; errors: Record<string, string>; onChange: (rows: Row[]) => void }) {
  const change = (day: Row["day"], patch: Partial<Row>) => onChange(rows.map((r) => (r.day === day ? { ...r, ...patch } : r)));
  return (
    <ListCard>
      {rows.map((r) => {
        const error = errors[`${gate}.${r.day}`];
        return (
          <ListRow key={r.day} className="flex-col items-stretch gap-1 px-3.5 py-2">
            <div className="flex items-center gap-3.5">
              <span className="w-11 text-ui font-[550]">{SHORT[r.day]}</span>
              <Switch aria-label={`${DAY_NAMES[r.day]} ${gate === "scarce" ? "scarce hours" : "lead-in hours"}`} checked={r.on} onCheckedChange={(on) => change(r.day, { on })} />
              {r.on ? (
                <>
                  <Input type="time" aria-label={`${DAY_NAMES[r.day]} from`} value={r.from} aria-invalid={error !== undefined} onChange={(e) => change(r.day, { from: e.target.value })} className="w-28 font-mono text-code md:text-code" />
                  <span className="text-label font-normal text-muted-foreground">to</span>
                  <Input type="time" aria-label={`${DAY_NAMES[r.day]} to`} value={r.to} aria-invalid={error !== undefined} onChange={(e) => change(r.day, { to: e.target.value })} className="w-28 font-mono text-code md:text-code" />
                </>
              ) : (
                <span className="text-label font-normal text-muted-foreground">Not active</span>
              )}
            </div>
            {error ? (
              <p role="alert" className="pl-14.5 text-caption text-primary-ink">
                {error}
              </p>
            ) : null}
          </ListRow>
        );
      })}
    </ListCard>
  );
}

/** Settings, Schedule: the scarce hours and the lead-in hours, each by weekday, and the usage share that makes the lead-in hold. */
export function ScheduleSettings() {
  const { connection, subscribe } = useAppState();
  const [saved, setSaved] = useState<Schedule>();
  const [form, setForm] = useState<Schedule>();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void api<Schedule>("/settings/schedule").then((g) => (setSaved(g), setForm(g))).catch(() => undefined);
  }, []);

  const dirty = form !== undefined && saved !== undefined && JSON.stringify({ ...form, error: undefined }) !== JSON.stringify({ ...saved, error: undefined });
  const dirtyNow = useRef(false);
  useEffect(
    () =>
      subscribe((e) => {
        if (e.type !== "config.changed" || !(e.data as { fromFile?: boolean } | undefined)?.fromFile) return;
        void api<Schedule>("/settings/schedule")
          .then((g) => {
            setSaved(g);
            if (!dirtyNow.current) setForm(g);
          })
          .catch(() => undefined);
      }),
    [subscribe],
  );
  dirtyNow.current = dirty;
  const leave = useUnsavedGuard(dirty);

  if (!form) return <PageHeader title="Schedule" />;

  const save = async () => {
    setSaving(true);
    setErrors({});
    try {
      const { error: _e, timeZone: _z, ...patch } = form;
      const res = await api<Schedule & { applied: string[]; needsRestart: string[] }>("/settings/schedule", { method: "PUT", body: patch });
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
      <PageHeader title="Schedule">
        <Button type="submit" disabled={saving || connection === "down"}>
          <FloppyDiskIcon /> Save
        </Button>
      </PageHeader>
      {saved?.error ? (
        <p role="alert" className="rounded-card bg-primary-soft px-4 py-3 text-body text-primary-ink">
          clots.config.json was edited by hand and could not be used, so the last good settings stay in force: {saved.error}
        </p>
      ) : null}
      <p className="text-label font-normal text-muted-foreground">Times are in your time zone, {form.timeZone}.</p>
      <Section
        title="Scarce hours"
        action={
          <Button type="button" variant="ghost" size="sm" onClick={() => setForm({ ...form, scarce: SCARCE_DEFAULT })}>
            <ArrowCounterClockwiseIcon /> Restore defaults
          </Button>
        }
      >
        <p className="text-label font-normal text-muted-foreground">Clots only act on your messages and urgent events in these hours. Default: weekdays, 15:00 to 18:00.</p>
        <Windows gate="scarce" rows={form.scarce} errors={errors} onChange={(scarce) => setForm({ ...form, scarce })} />
      </Section>
      <Section
        title="Lead-in hours"
        action={
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setForm({ ...form, leadIn: LEAD_IN_DEFAULT, leadInPercent: DEFAULT_PERCENT })}
          >
            <ArrowCounterClockwiseIcon /> Restore defaults
          </Button>
        }
      >
        <p className="text-label font-normal text-muted-foreground">Before scarce hours, Clots hold back the same way once usage is high. Default: weekdays, 10:00 to 15:00.</p>
        <Windows gate="leadIn" rows={form.leadIn} errors={errors} onChange={(leadIn) => setForm({ ...form, leadIn })} />
        <FieldRow label="Hold when usage reaches" help="The five-hour usage limit, as a share. Default: 50 %" htmlFor="lead-in-percent" error={errors.leadInPercent}>
          <Stepper id="lead-in-percent" label="Hold when usage reaches" value={form.leadInPercent} min={1} max={100} unit="%" onChange={(v) => setForm({ ...form, leadInPercent: v })} />
        </FieldRow>
      </Section>
      <ConfirmDialog open={leave.pending} onOpenChange={(open) => !open && leave.cancel()} title="Leave without saving?" description="Your changes to these settings will be lost." confirmLabel="Discard changes" cancelLabel="Keep editing" onConfirm={leave.proceed} />
    </form>
  );
}
