import type { ReactNode } from "react";
import { Label } from "@/components/ui/label";

/** A setting: its label and help on the left, its control on the right. */
export function FieldRow({ label, help, error, htmlFor, children }: { label: string; help?: string; error?: string; htmlFor?: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-8 py-3">
      <div className="min-w-0">
        <Label htmlFor={htmlFor} className="text-body font-medium">
          {label}
        </Label>
        {help ? <p className="text-label font-normal text-muted-foreground">{help}</p> : null}
        {error ? (
          <p role="alert" className="text-caption text-primary-ink">
            {error}
          </p>
        ) : null}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

/** A page's title, with what sits at its right (a Save or New button). */
export function PageHeader({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <h1 className="text-title">{title}</h1>
      {children}
    </div>
  );
}
