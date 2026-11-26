"use client";

import type { ReactNode } from "react";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  /** Shown instead of the label (the label is then its accessible name), as the theme's Monitor, Sun and Moon are. */
  icon?: ReactNode;
}

/**
 * A single choice among a few, as one bordered group: the chosen one sits on `muted-strong`. Icon options show only their icon,
 * the others their text. Built on the ToggleGroup, so arrow keys move through it and it reads as a radio group to a screen reader.
 */
export function Segmented<T extends string>({ value, onValueChange, options, label }: { value: T; onValueChange: (value: T) => void; options: SegmentedOption<T>[]; label: string }) {
  return (
    <ToggleGroup type="single" value={value} onValueChange={(next) => next && onValueChange(next as T)} aria-label={label} spacing={0.5} className="rounded-control border border-input bg-card p-0.5">
      {options.map((option) => (
        <ToggleGroupItem
          key={option.value}
          value={option.value}
          aria-label={option.icon ? option.label : undefined}
          className="h-7.5 min-w-8.5 rounded-sm px-2.5 text-label font-medium text-muted-foreground data-[state=on]:bg-muted-strong data-[state=on]:text-foreground"
        >
          {option.icon ?? option.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
