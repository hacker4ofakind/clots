import { cn } from "@/lib/utils";

/**
 * The Clots mark: an orange slice, tilted 6 degrees anticlockwise, its lower half in segments. It takes the brand colour,
 * and is what the favicon, the home-screen icon and the phone's tab bar show. An empty `title` makes it decoration.
 */
export function Mark({ className, title = "Clots" }: { className?: string; title?: string }) {
  return (
    <svg viewBox="0 0 48 48" {...(title ? { role: "img", "aria-label": title } : { "aria-hidden": true })} className={cn("size-6 text-brand", className)}>
      <g transform="rotate(-6 24 24)">
        <circle cx="24" cy="24" r="21" fill="none" stroke="currentColor" strokeWidth="3.5" />
        <path d="M5 24h38" stroke="currentColor" strokeWidth="2.5" />
        <path
          d="M24 25 L39.96 25.12 A16 16 0 0 1 32.95 37.26Z M24 25 L31.01 38.38 A16 16 0 0 1 16.99 38.38Z M24 25 L15.05 37.26 A16 16 0 0 1 8.04 25.12Z"
          fill="currentColor"
        />
      </g>
    </svg>
  );
}

/** The full logo: the slice with the word in its empty upper half. For 64px and larger. */
export function Logo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 200 200" role="img" aria-label="Clots" className={cn("size-32 text-brand", className)}>
      <g transform="rotate(-6 100 100)">
        <circle cx="100" cy="100" r="90" fill="none" stroke="currentColor" strokeWidth="10" />
        <circle cx="100" cy="100" r="79" fill="none" stroke="currentColor" strokeWidth="2" opacity="0.45" />
        <path d="M21 100h158" stroke="currentColor" strokeWidth="5" />
        <path
          d="M100 104 L169.83 108.88 A70 70 0 0 1 139.14 162.03Z M100 104 L130.69 166.92 A70 70 0 0 1 69.31 166.92Z M100 104 L60.86 162.03 A70 70 0 0 1 30.17 108.88Z"
          fill="currentColor"
        />
        <text x="100" y="80" textAnchor="middle" fontSize="40" fontWeight="750" className="fill-foreground font-sans">
          Clots
        </text>
      </g>
    </svg>
  );
}
