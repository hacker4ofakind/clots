import type { ReactNode } from "react";

/** A titled block of a settings page, with an action (an Add button) at the right of its heading. */
export function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2.5">
      <div className="flex items-center justify-between">
        <h2 className="text-section">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}
