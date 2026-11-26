"use client";

import { useState } from "react";
import Image from "next/image";
import { IconTile } from "./icon-tile";
import { logoUrl } from "@/lib/integrations";

const SIZES = { sm: { tile: "sm", image: 18 }, logo: { tile: "logo", image: 20 }, tool: { tile: "tool", image: 28 } } as const;

/** The logo itself, or the toolkit's first letter when it does not load. */
export function LogoImage({ toolkit, name, logo, size }: { toolkit: string; name: string; logo?: string; size: number }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <span aria-hidden className="font-extrabold">
        {name.charAt(0).toUpperCase()}
      </span>
    );
  }
  return <Image src={logoUrl(toolkit, logo)} alt="" width={size} height={size} unoptimized className="object-contain" onError={() => setFailed(true)} />;
}

/**
 * A toolkit's logo on a bordered tile: the pick grid's rows (`logo`), the dialog's title (`sm`) and the tool tiles (`tool`).
 * A logo that does not load shows the toolkit's first letter instead. In the dark theme the tile stays light, since many logos are black.
 */
export function ToolLogo({ toolkit, name, logo, size = "logo" }: { toolkit: string; name: string; logo?: string; size?: keyof typeof SIZES }) {
  const { tile, image } = SIZES[size];
  return (
    <IconTile size={tile} tone="plain" className="dark:bg-primary-foreground">
      <LogoImage toolkit={toolkit} name={name} logo={logo} size={image} />
    </IconTile>
  );
}
