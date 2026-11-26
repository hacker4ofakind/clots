"use client";

import { useRef, useState, type KeyboardEvent } from "react";
import { InputGroup, InputGroupInput } from "@/components/ui/input-group";
import { cn } from "@/lib/utils";

/** Minutes split into the two fields of a duration. */
export const splitMinutes = (total: number): { hours: number; minutes: number } => ({ hours: Math.floor(total / 60), minutes: total % 60 });

/** Two typed fields to minutes: more than 59 minutes roll into hours. */
export const joinMinutes = (hours: number, minutes: number): number => hours * 60 + minutes;

/**
 * A duration as "0 h 15 m": two number fields of up to two digits with their units fixed between them, sharing one border and one
 * focus ring. Arrow keys step by 1 (Shift by 10); right at a field's end moves to the other field; Backspace in an empty minutes
 * field goes back to hours; minutes above 59 roll into hours when the field is left. The value is in minutes.
 */
export function TimeInput({ value, onChange, label, id, disabled }: { value: number; onChange: (minutes: number) => void; label: string; id?: string; disabled?: boolean }) {
  const { hours, minutes } = splitMinutes(value);
  const [draft, setDraft] = useState<{ h?: string; m?: string }>({});
  const hRef = useRef<HTMLInputElement>(null);
  const mRef = useRef<HTMLInputElement>(null);

  const commit = (h: number, m: number) => onChange(Math.max(0, joinMinutes(h, m)));
  const digits = (text: string) => text.replace(/\D/g, "").slice(0, 2);

  const step = (which: "h" | "m", e: KeyboardEvent<HTMLInputElement>) => {
    const by = e.shiftKey ? 10 : 1;
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      const sign = e.key === "ArrowUp" ? 1 : -1;
      if (which === "h") commit(Math.min(99, Math.max(0, hours + sign * by)), minutes);
      else commit(hours, Math.max(0, minutes + sign * by));
      setDraft({});
    } else if (e.key === "ArrowRight" && which === "h" && e.currentTarget.selectionStart === e.currentTarget.value.length) {
      e.preventDefault();
      mRef.current?.focus();
      mRef.current?.select();
    } else if (e.key === "ArrowLeft" && which === "m" && e.currentTarget.selectionStart === 0) {
      e.preventDefault();
      hRef.current?.focus();
    } else if (e.key === "Backspace" && which === "m" && e.currentTarget.value === "") {
      e.preventDefault();
      hRef.current?.focus();
    }
  };

  const field = (which: "h" | "m", n: number, ref: typeof hRef, unit: string) => (
    <>
      <InputGroupInput
        ref={ref}
        id={which === "h" ? id : undefined}
        inputMode="numeric"
        aria-label={`${label}, ${which === "h" ? "hours" : "minutes"}`}
        disabled={disabled}
        value={draft[which] ?? String(n)}
        onFocus={(e) => e.currentTarget.select()}
        onKeyDown={(e) => step(which, e)}
        onChange={(e) => {
          const text = digits(e.target.value);
          setDraft({ ...draft, [which]: text });
          const typed = Number(text || "0");
          if (which === "h") commit(typed, minutes);
          else commit(hours, typed);
          if (which === "h" && text.length === 2) mRef.current?.focus();
        }}
        onBlur={() => {
          // Minutes above 59 roll into hours.
          commit(hours, minutes);
          setDraft({});
        }}
        className="h-full w-4.5 flex-none p-0 text-right text-body tabular-nums"
      />
      <span className="mr-1 text-body text-muted-foreground" aria-hidden>
        {unit}
      </span>
    </>
  );

  return (
    <InputGroup role="group" aria-label={label} className={cn("w-auto gap-1 px-3", disabled && "opacity-50")}>
      {field("h", hours, hRef, "h")}
      {field("m", minutes, mRef, "m")}
    </InputGroup>
  );
}
