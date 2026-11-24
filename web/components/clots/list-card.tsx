import type { ComponentProps, ReactNode } from "react";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/** A card whose rows are divided by hairlines: Manage Clots and the Integrations lists. */
export function ListCard({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <Card size="flush" className={cn("gap-0 py-0", className)}>
      <ul className="flex flex-col">{children}</ul>
    </Card>
  );
}

/** One row of a ListCard. */
export function ListRow({ className, ...props }: ComponentProps<"li">) {
  return <li className={cn("flex items-center gap-3 px-4 py-3 not-first:border-t", className)} {...props} />;
}
