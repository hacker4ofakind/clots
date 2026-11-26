"use client";

import { useState } from "react";
import Image from "next/image";
import { EnvelopeSimpleIcon, PlugsIcon } from "@phosphor-icons/react";

/** A toolkit's logo, from Composio's logo service. */
export const composioLogo = (toolkit: string): string => `https://logos.composio.dev/api/${encodeURIComponent(toolkit.toLowerCase())}`;

/** Whether an address is a Gmail one: Gmail inboxes show Gmail's logo, any other inbox an envelope. */
export const isGmail = (address: string): boolean => /@(gmail|googlemail)\.com$/i.test(address);

/**
 * What a connection looks like: a Composio tool shows the toolkit's own logo, a Gmail inbox shows Gmail's, any other inbox
 * is an envelope, and the logo's absence (an unknown toolkit) falls back to a plug.
 */
export function ConnectionIcon({ kind, toolkit, address, size = 20 }: { kind: "email" | "composio"; toolkit?: string; address?: string; size?: number }) {
  const [failed, setFailed] = useState(false);
  const slug = kind === "composio" ? toolkit : address !== undefined && isGmail(address) ? "gmail" : undefined;
  if (slug === undefined) return kind === "email" ? <EnvelopeSimpleIcon size={size} aria-hidden /> : <PlugsIcon size={size} aria-hidden />;
  if (failed) return <PlugsIcon size={size} aria-hidden />;
  return <Image src={composioLogo(slug)} alt="" width={size} height={size} unoptimized className="shrink-0 rounded-sm object-contain dark:bg-primary-foreground" onError={() => setFailed(true)} />;
}
