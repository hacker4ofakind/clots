import type { ComponentType, ReactNode } from "react";
import type { IconProps } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";

/** The classes the buttons of these pages add: a little wider than the default, and the phone's taller touch size. */
export const statusButtonClass = "px-3.5 max-md:h-11 max-md:px-4";

/**
 * A page of its own that says one thing: a tile icon, a heading, a line of text and the way out (the actions: one primary
 * button, and at most one quiet one). Framed, it stands on the page container's card inside the app's background, like every
 * screen but with no rail, so it also works where the app's shell cannot load; unframed, it fills the page container of a
 * shell that is already there. `reference` is a short code to quote when reporting a problem. Used for 404, errors, access
 * refusals and the setup page, so keep it free of providers and client code.
 */
export function StatusPage({ icon: Icon, title, children, actions, reference, framed = true }: { icon: ComponentType<IconProps>; title: string; children: ReactNode; actions?: ReactNode; reference?: string; framed?: boolean }) {
  const panel = (
    <div data-slot="status-panel" className={cn("flex flex-1 flex-col items-center justify-center gap-3.5 px-7 pb-20 text-center md:px-10", framed ? "bg-card md:rounded-panel md:border" : "h-full")}>
      <span data-slot="status-tile" className="flex size-16 shrink-0 items-center justify-center rounded-[18px] bg-muted text-foreground-soft">
        <Icon size={32} aria-hidden />
      </span>
      <h1 data-slot="status-title" className="text-balance text-title-mobile md:text-title">
        {title}
      </h1>
      <p data-slot="status-text" className="max-w-sm text-balance text-chat text-muted-foreground">
        {children}
      </p>
      {actions ? (
        <div data-slot="status-actions" className="mt-1.5 flex flex-wrap items-center justify-center gap-2.5">
          {actions}
        </div>
      ) : null}
      {reference ? (
        <p data-slot="status-reference" className="text-caption text-muted-foreground">
          Reference <span className="font-mono">{reference}</span>
        </p>
      ) : null}
    </div>
  );
  return framed ? (
    <main data-slot="status-page" className="flex min-h-dvh bg-background md:p-2.5">
      {panel}
    </main>
  ) : (
    panel
  );
}
