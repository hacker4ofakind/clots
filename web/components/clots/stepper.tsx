"use client";

import { CaretDownIcon, CaretUpIcon } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from "@/components/ui/input-group";

/** A whole number with a unit and two small arrows. Typing, the arrow keys and the buttons all change it, within min and max. `digits` is how many digits the field shows (3 by default). */
export function Stepper({ value, onChange, min, max, unit, id, label, digits = 3 }: { value: number; onChange: (value: number) => void; min: number; max: number; unit?: string; id?: string; label: string; digits?: number }) {
  const set = (next: number) => onChange(Math.min(max, Math.max(min, next)));
  return (
    <InputGroup className="w-auto pl-3">
      <InputGroupInput
        id={id}
        inputMode="numeric"
        aria-label={label}
        value={String(value)}
        onChange={(e) => {
          const digits = e.target.value.replace(/\D/g, "");
          if (digits !== "") set(Number(digits));
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowUp" || e.key === "ArrowDown") {
            e.preventDefault();
            set(value + (e.key === "ArrowUp" ? 1 : -1));
          }
        }}
        style={{ width: `${digits}ch` }}
        className="h-full flex-none p-0 text-right tabular-nums"
      />
      {unit ? <InputGroupText className="ml-1">{unit}</InputGroupText> : null}
      <InputGroupAddon align="inline-end" className="flex-col gap-0 py-0 pr-1">
        <Button type="button" variant="ghost" size="icon-xs" aria-label={`More ${label}`} tabIndex={-1} className="h-4 w-5 text-muted-foreground" onClick={() => set(value + 1)}>
          <CaretUpIcon />
        </Button>
        <Button type="button" variant="ghost" size="icon-xs" aria-label={`Less ${label}`} tabIndex={-1} className="h-4 w-5 text-muted-foreground" onClick={() => set(value - 1)}>
          <CaretDownIcon />
        </Button>
      </InputGroupAddon>
    </InputGroup>
  );
}
