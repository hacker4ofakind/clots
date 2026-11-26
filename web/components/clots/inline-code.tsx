import { Fragment } from "react";
import { cn } from "@/lib/utils";

/**
 * Plain text from the daemon, with `backticked` parts set in the mono face. For the lines that are not Markdown (notes, activity lines,
 * an ask's outcome and errors), where the daemon still writes a file name or a command between backticks. An unmatched backtick stays as it is.
 */
export function InlineCode({ text, className }: { text: string; className?: string }) {
  const parts = text.split(/`([^`\n]+)`/);
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <code key={i} className={cn("rounded-sm bg-muted px-1 py-0.5 font-mono text-code", className)}>
            {part}
          </code>
        ) : (
          <Fragment key={i}>{part}</Fragment>
        ),
      )}
    </>
  );
}
