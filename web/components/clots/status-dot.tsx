import { cn } from "@/lib/utils";

const TONES = {
  highlight: "bg-highlight",
  calling: "bg-calling",
  muted: "bg-input",
  primary: "bg-primary",
} as const;

/** A small coloured dot: the state of a Clot, the "something is waiting" mark. */
export function StatusDot({ tone, className }: { tone: keyof typeof TONES; className?: string }) {
  return <span aria-hidden className={cn("inline-block size-1.75 shrink-0 rounded-full", TONES[tone], className)} />;
}
