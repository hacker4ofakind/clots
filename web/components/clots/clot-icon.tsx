"use client";

import { Suspense, lazy, useMemo, type ComponentType } from "react";
import Image from "next/image";
import type { IconProps } from "@phosphor-icons/react";
import { CubeIcon, HouseIcon } from "@phosphor-icons/react";
import type { ClotIcon as ClotIconValue } from "@clots/ui-api-schemas";
import { cn } from "@/lib/utils";

/** The colours the picker offers, "red" being the brand's Rose. A Clot saved with "green" before keeps it. */
export const ICON_COLORS = ["ink", "red", "orange", "amber", "teal", "blue", "violet", "pink"] as const;
export type IconColor = (typeof ICON_COLORS)[number];

const KNOWN_COLORS: readonly string[] = [...ICON_COLORS, "green"];

/** A saved colour as one the tokens have; anything else is the brand red. */
export const iconColorName = (color: string): string => (KNOWN_COLORS.includes(color) ? color : "red");

const colorVar = (color: string): string => (color === "currentColor" ? "currentColor" : `var(--icon-${iconColorName(color)})`);

/** Phosphor icons loaded by name, one at a time: the library has about 1,500, and the app uses the ones a Clot picks. */
const loaded = new Map<string, ComponentType<IconProps>>();
function phosphorByName(name: string): ComponentType<IconProps> | undefined {
  if (!/^[A-Z][A-Za-z0-9]{0,40}$/.test(name)) return undefined;
  let icon = loaded.get(name);
  if (!icon) {
    icon = lazy(() => import(`@phosphor-icons/react/dist/csr/${name}`).then((m: Record<string, ComponentType<IconProps>>) => ({ default: m[name] ?? HouseIcon }))) as unknown as ComponentType<IconProps>;
    loaded.set(name, icon);
  }
  return icon;
}

/** A Phosphor icon by its component name ("GithubLogo"), loaded when first shown; an unknown name draws nothing. */
export function NamedIcon({ name, size = 16, className }: { name: string; size?: number; className?: string }) {
  const Named = useMemo(() => phosphorByName(name), [name]);
  if (!Named) return null;
  return (
    <Suspense fallback={<span style={{ width: size, height: size }} className="inline-block" aria-hidden />}>
      <Named size={size} className={className} aria-hidden />
    </Suspense>
  );
}

/**
 * A Clot's icon. A Phosphor icon is drawn in its colour, bold when its Clot is the active item; an uploaded image is
 * shown as it is, or as the daemon made its active variant (its two colours swapped, or inverted).
 */
export function ClotIcon({ icon, home, active = false, size = 24, tile, label }: { icon: ClotIconValue | undefined; home?: boolean; active?: boolean; size?: number; tile?: number; label?: string }) {
  const Named = useMemo(() => (icon && "phosphor" in icon ? phosphorByName(icon.phosphor) : undefined), [icon]);
  if (icon && "upload" in icon) {
    return <Image src={`/api/d/clots/icons/${encodeURIComponent(icon.upload)}${active ? "?variant=active" : ""}`} alt={label ?? ""} width={tile ?? size + 8} height={tile ?? size + 8} unoptimized className="rounded-tile-sm object-contain" style={{ width: tile ?? size + 8, height: tile ?? size + 8, maxWidth: "none" }} />;
  }
  const color = icon && "phosphor" in icon ? colorVar(icon.color) : "currentColor";
  const weight = active ? "bold" : "regular";
  const fallback = home ? <HouseIcon size={size} weight={weight} color={color} aria-hidden /> : <CubeIcon size={size} weight={weight} color={color} aria-hidden />;
  if (Named) {
    return (
      <Suspense fallback={<span style={{ width: size, height: size }} className="inline-block" aria-hidden />}>
        <Named size={size} weight={weight} color={color} aria-hidden aria-label={label} />
      </Suspense>
    );
  }
  return fallback;
}
