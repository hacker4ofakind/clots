import type { ReactNode } from "react";
import { XIcon } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { DialogClose, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

/**
 * What every step of the integration dialog shares: the title (with the toolkit's logo once one is chosen), a close button
 * that the working and connect steps leave out, the body, and the footer's Back and Done. `header` sits under the title (the
 * pick step's search field).
 */
export function StepFrame({ title, logo, closable = false, header, footer, children }: { title: string; logo?: ReactNode; closable?: boolean; header?: ReactNode; footer?: ReactNode; children: ReactNode }) {
  return (
    <>
      <div className={cn("flex shrink-0 flex-col px-5.5 pt-5", header ? "gap-3.5 pb-3.5" : "pb-1.5")}>
        <div className="flex items-center justify-between">
          <DialogTitle className="flex items-center gap-2.5">
            {logo}
            {title}
          </DialogTitle>
          {closable ? (
            <DialogClose asChild>
              <Button variant="ghost" size="icon-sm" aria-label="Close">
                <XIcon />
              </Button>
            </DialogClose>
          ) : null}
        </div>
        {header}
      </div>
      <div className="flex min-h-0 flex-1 flex-col px-5.5 py-1.5">{children}</div>
      {footer ? <div className="flex shrink-0 items-center justify-between px-5.5 pt-3.5 pb-5">{footer}</div> : null}
    </>
  );
}
