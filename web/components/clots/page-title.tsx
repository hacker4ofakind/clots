import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** A page's title: 30px with the phone's top room under the status bar, 26px with the page padding on a desktop. */
export function PageTitle({ children, className }: { children: ReactNode; className?: string }) {
  return <h1 className={cn("px-5 pb-3 pt-[max(calc(env(safe-area-inset-top)+12px),62px)] text-title-mobile leading-normal md:p-10 md:text-title", className)}>{children}</h1>;
}
