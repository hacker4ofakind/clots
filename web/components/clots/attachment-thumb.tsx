import Image from "next/image";
import { cn } from "@/lib/utils";

/**
 * A picture the user attached, in a box of a fixed shape from the start, so nothing jumps when it arrives. The sources are the app's own
 * (a data URL not yet sent, or the daemon's image route), so the optimiser has nothing to do with them.
 */
export function AttachmentThumb({ src, sizes, fit = "contain", className }: { src: string; sizes: string; fit?: "contain" | "cover"; className?: string }) {
  return (
    <span className={cn("relative block overflow-hidden rounded-control bg-background", className)}>
      <Image src={src} alt="Attached" fill sizes={sizes} unoptimized className={fit === "cover" ? "object-cover" : "object-contain"} />
    </span>
  );
}
