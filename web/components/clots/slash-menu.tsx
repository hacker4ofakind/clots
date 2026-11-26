"use client";

import type { ComponentType } from "react";
import { ArrowCounterClockwiseIcon, ArrowsClockwiseIcon, CalendarBlankIcon, CreditCardIcon, FolderSimpleIcon, LightningIcon, ListChecksIcon, TerminalWindowIcon, XIcon, type IconProps } from "@phosphor-icons/react";
import type { CommandInfo } from "@clots/ui-api-schemas";
import { Command, CommandItem, CommandList } from "@/components/ui/command";

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
 * above the composer's own box), lists every match with its icon, name, options and what it does, and marks the chosen one. The text
 * box keeps the focus and decides which command is chosen (arrow keys, Tab, Enter); the menu only shows it, and a click chooses.
 * Matching is the fuzzy one above, so the list does its own filtering. A phone's rows leave the description out.
 */
export function SlashMenu({ matches, selected, onSelect, onChoose }: { matches: Match[]; selected: number; onSelect: (index: number) => void; onChoose: (name: string) => void }) {
  return (
    <Command
      shouldFilter={false}
      loop
      label="Commands"
      value={matches[selected]?.command.name ?? ""}
      onValueChange={(name) => onSelect(Math.max(0, matches.findIndex((m) => m.command.name === name)))}
      className="absolute inset-x-0 bottom-full z-20 mb-2 h-auto border p-1.5 shadow-menu"
    >
      <CommandList label="Commands">
        {matches.map(({ command, bold }) => (
          <CommandItem
            key={command.name}
            value={command.name}
            onMouseDown={(e) => e.preventDefault()}
            onSelect={() => onChoose(command.name)}
            className="min-h-9.5 gap-3 rounded-lg px-3 py-1.5 text-body data-[selected=true]:bg-muted max-md:h-12 max-md:text-chat md:grid md:grid-cols-[16px_150px_minmax(0,1fr)_auto] md:gap-2.5 [&>svg:last-child]:hidden"
          >
            <CommandIcon name={command.name} />
            <span className="font-mono text-code">
              /<Highlight text={command.name} bold={bold} />
            </span>
            <span className="text-label leading-normal font-normal text-muted-foreground max-md:ml-auto md:truncate">{command.options}</span>
            <span className="hidden truncate text-right text-label leading-normal font-normal text-muted-foreground md:block">{command.description}</span>
          </CommandItem>
        ))}
      </CommandList>
    </Command>
  );
}
