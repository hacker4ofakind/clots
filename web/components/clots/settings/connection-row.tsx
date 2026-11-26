import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { ListRow } from "../list-card";

/**
 * One row of an Integrations list: an icon, what it is, where it is used (or a key's last characters), and the icon buttons
 * for it (children). Inboxes, tools and keys all look like this.
 */
export function ConnectionRow({ icon, label, mono, meta, children, ...props }: { icon: ReactNode; label: ReactNode; mono?: boolean; meta?: ReactNode; children?: ReactNode } & Omit<React.ComponentProps<"li">, "children" | "className">) {
  return (
    <ListRow className="py-2 pr-2 pl-3.5" {...props}>
      {icon}
      <span className={cn("min-w-0 flex-1 truncate", mono ? "font-mono text-code" : "text-body")}>{label}</span>
      {meta ? <span className={cn("w-42.5 shrink-0", mono ? "font-mono text-caption text-muted-foreground" : "text-label font-normal text-muted-foreground")}>{meta}</span> : null}
      {children}
    </ListRow>
  );
}
