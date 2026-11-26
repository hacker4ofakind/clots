"use client";

import { useCallback, useEffect, useState } from "react";
import { composioLogo } from "@/components/clots/connection-icon";
import { api } from "@/lib/api-client";
import { labelOfName } from "@/lib/clots";
import { useAppState } from "@/components/clots/app-state";

export type Audience = "private" | "team" | "public";

/** One toolkit in Composio's list. `webhooks` says whether it can push events (the polling time is then not needed); absent means unknown. */
export interface Toolkit {
  slug: string;
  name: string;
  logo?: string;
  description?: string;
  auth: "oauth" | "key" | "none";
  webhooks?: boolean;
}

/** A connected Composio tool. The options the configurer was given are returned when the daemon knows them. */
export interface ToolRow {
  id: string;
  toolkit: string;
  account: string;
  clot: string | null;
  shared: boolean;
  audience: Audience;
  logo?: string;
  status?: "active" | "waiting" | "failed" | "unknown";
  restartNeeded?: boolean;
  selfIsUser?: boolean;
  events?: boolean;
  pollMinutes?: number;
  leadTimes?: string[];
  checkoutCompleted?: boolean;
}

export interface InboxRow {
  account: string;
  address: string;
  clot: string | null;
  shared: boolean;
  provider: string;
  mailboxes?: string[];
  imap?: { host: string; port: number };
  smtp?: { host: string; port: number };
  /** Other addresses delivered into the inbox. */
  addresses?: string[];
  /** Whether the Clots are told the address. */
  tellAddress?: boolean;
}

export interface Overview {
  inboxes: InboxRow[];
  tools: ToolRow[];
}

export type JobState = "working" | "oauth" | "key" | "active" | "failed";

/** One connection attempt of one toolkit, as the daemon reports it (and as the `integration.status` event carries it). */
export interface Job {
  jobId: string;
  toolkit: string;
  name?: string;
  clot?: string | null;
  state: JobState;
  link?: string;
  instructions?: string;
  keyName?: string;
  error?: string;
  oauthReadyAt?: number;
  /** The tool is saved, but only a restart of the daemon finishes wiring it. */
  needsRestart?: boolean;
}

/** What the options step collects. */
export interface ToolOptions {
  audience: Audience;
  selfIsUser: boolean;
  /** Shared with every Clot; off means only the Clot the dialog was opened for. */
  shared: boolean;
  events: boolean;
  pollMinutes: number;
  /** Google Calendar: how long before an event each reminder comes, as written ("24h, 1h"). */
  leadTimes: string;
  /** Stripe: also tell the Clot when a customer finishes paying at checkout. */
  checkoutCompleted: boolean;
}

export const DEFAULT_OPTIONS: ToolOptions = { audience: "team", selfIsUser: true, shared: false, events: true, pollMinutes: 30, leadTimes: "24h", checkoutCompleted: false };

/** Lead times typed as "24h, 90m" to a list, or undefined when one of them is not a number with m, h or d. */
export function parseLeadTimes(text: string): string[] | undefined {
  const parts = text.split(",").map((p) => p.trim().toLowerCase()).filter(Boolean);
  return parts.length > 0 && parts.length <= 10 && parts.every((p) => /^\d{1,4}[mhd]$/.test(p)) ? parts : undefined;
}

/** A toolkit slug as a name: "microsoft_teams" is "Microsoft Teams". */
export const toolkitName = (slug: string): string => slug.replace(/(^|[_-])(\w)/g, (_m, sep: string, ch: string) => (sep ? " " : "") + ch.toUpperCase());

export const logoUrl = (toolkit: string, logo?: string): string => logo ?? composioLogo(toolkit);

/** Where a tool or inbox is used: "Shared", or "Truecast only". */
export const scopeLabel = (x: { shared: boolean; clot: string | null }): string => (x.shared || x.clot === null ? "Shared" : `${labelOfName(x.clot)} only`);

/** The connected tools and inboxes, kept up to date: it loads again when a connection becomes active. */
export function useIntegrations(): { overview: Overview | undefined; reload: () => void } {
  const { subscribe, onResync } = useAppState();
  const [overview, setOverview] = useState<Overview>();
  const reload = useCallback(() => void api<Overview>("/integrations").then(setOverview).catch(() => undefined), []);
  useEffect(reload, [reload]);
  useEffect(() => subscribe((event) => event.type === "integration.status" && event.data?.state === "active" && reload()), [subscribe, reload]);
  useEffect(() => onResync(reload), [onResync, reload]);
  return { overview, reload };
}

const knownNames = new Map<string, string>();
const lookedUp = new Set<string>();

/**
 * Toolkit names as Composio spells them ("PostHog", "GitHub"), which a slug cannot give. The tools list only has slugs, so each is
 * looked up once in the toolkit list (the daemon caches it); until then the name is the slug in title case.
 */
export function useToolkitNames(slugs: string[]): (slug: string) => string {
  const [, bump] = useState(0);
  const wanted = slugs.join(",");
  useEffect(() => {
    let live = true;
    for (const slug of wanted.split(",").filter((s) => s !== "" && !lookedUp.has(s))) {
      lookedUp.add(slug);
      void api<{ toolkits: Toolkit[] }>(`/integrations/toolkits?q=${encodeURIComponent(slug)}`)
        .then((res) => {
          const found = res.toolkits.find((t) => t.slug === slug);
          if (found) knownNames.set(slug, found.name);
          if (live) bump((n) => n + 1);
        })
        .catch(() => lookedUp.delete(slug));
    }
    return () => {
      live = false;
    };
  }, [wanted]);
  return (slug) => knownNames.get(slug) ?? toolkitName(slug);
}
