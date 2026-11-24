import type { ReactNode } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const tile = cva("flex shrink-0 items-center justify-center", {
  variants: {
    size: { xs: "size-[18px] rounded-sm", logo: "size-9 rounded-[9px]", tool: "size-14 rounded-[14px]", sm: "size-8 rounded-[9px]", md: "size-10 rounded-[11px]", phone: "size-11 rounded-card", lg: "size-16 rounded-2xl", xl: "size-20 rounded-[20px]" },
    tone: { muted: "bg-muted", soft: "bg-primary-soft text-primary-ink", plain: "border border-input bg-card" },
  },
  defaultVariants: { size: "md", tone: "muted" },
});

/** The square a Clot's icon (or a tool's logo) sits on. */
export function IconTile({ size, tone, className, children }: VariantProps<typeof tile> & { className?: string; children: ReactNode }) {
  return <span className={cn(tile({ size, tone }), className)}>{children}</span>;
}
