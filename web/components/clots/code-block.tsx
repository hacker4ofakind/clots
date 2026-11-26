import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

/** Text shown as it is, in the mono face on a muted ground: an email's body, a build log, what a setting is now. Scrolls past 18rem. */
export function CodeBlock({ className, ...props }: ComponentProps<"pre">) {
  return <pre className={cn("max-h-72 overflow-auto rounded-control bg-muted p-3 font-mono text-code whitespace-pre-wrap", className)} {...props} />;
}
