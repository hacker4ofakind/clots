"use client";

import type { ComponentType } from "react";
import { ArrowCounterClockwiseIcon, ArrowsClockwiseIcon, CalendarBlankIcon, CreditCardIcon, FolderSimpleIcon, LightningIcon, ListChecksIcon, TerminalWindowIcon, XIcon, type IconProps } from "@phosphor-icons/react";
import type { CommandInfo } from "@clots/ui-api-schemas";
import { cn } from "@/lib/utils";

/** A command matches what was typed as a prefix, or else as letters in order. Returns what to show in bold, or undefined for no match. */
export function fuzzy(name: string, query: string): { score: number; bold: number[] } | undefined {
  const q = query.toLowerCase();
  const n = name.toLowerCase();
  if (q === "") return { score: 0, bold: [] };
  if (n.startsWith(q)) return { score: 0, bold: Array.from({ length: q.length }, (_, i) => i) };
  const bold: number[] = [];
  let at = 0;
  for (const ch of q) {
    const found = n.indexOf(ch, at);
    if (found < 0) return undefined;
    bold.push(found);
    at = found + 1;
  }
  return { score: 1 + bold[bold.length - 1]!, bold };
}

export interface Match {
  command: CommandInfo;
  bold: number[];
}

/** The icon each command shows; the first word of its name decides. */
const ICONS: Record<string, ComponentType<IconProps>> = {
  effort: LightningIcon,
  close: XIcon,
  rules: ListChecksIcon,
  memory: FolderSimpleIcon,
  spend: CreditCardIcon,
  calendar: CalendarBlankIcon,
  composio: ArrowCounterClockwiseIcon,
};

function CommandIcon({ name }: { name: string }) {
  const Icon = name === "composio reconnect" ? ArrowsClockwiseIcon : (ICONS[name.split(" ")[0]!] ?? TerminalWindowIcon);
  return <Icon size={16} aria-hidden />;
}

function Highlight({ text, bold }: { text: string; bold: number[] }) {
  return (
    <>
      {[...text].map((ch, i) => (bold.includes(i) ? <b key={i} className="font-bold text-foreground">{ch}</b> : <span key={i}>{ch}</span>))}
    </>
  );
}

/**
 * The commands that match what is typed after the slash. It is exactly as wide as the composer under it (the caller places it
 * above the composer's own box), lists every match with its icon, name, options and what it does, and marks the chosen one.
 */
export function SlashMenu({ matches, selected, onChoose }: { matches: Match[]; selected: number; onChoose: (name: string) => void }) {
  return (
    <div role="listbox" aria-label="Commands" className="absolute inset-x-0 bottom-full z-20 mb-2 max-h-80 overflow-y-auto rounded-menu border bg-popover p-1.5 shadow-pop">
      {matches.map(({ command, bold }, i) => (
        <div
          key={command.name}
          role="option"
          aria-selected={i === selected}
          onMouseDown={(e) => (e.preventDefault(), onChoose(command.name))}
          className={cn("flex cursor-pointer items-center gap-3 rounded-lg px-3 text-body max-md:h-12 max-md:text-[15px] md:grid md:grid-cols-[16px_150px_minmax(0,1fr)_auto] md:gap-2.5 md:py-2.25", i === selected && "bg-muted")}
        >
          <CommandIcon name={command.name} />
          <span className="font-mono text-code">
            /<Highlight text={command.name} bold={bold} />
          </span>
          <span className="text-label font-normal text-muted-foreground max-md:ml-auto md:truncate">{command.options}</span>
          <span className="hidden truncate text-right text-label font-normal text-muted-foreground md:block">{command.description}</span>
        </div>
      ))}
    </div>
  );
}
