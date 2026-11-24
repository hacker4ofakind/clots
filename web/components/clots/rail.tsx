"use client";

import { useState, type KeyboardEvent, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Reorder } from "motion/react";
import { ArrowDownIcon, ArrowUpIcon, BellIcon, GearSixIcon, PlusIcon } from "@phosphor-icons/react";
import type { ClotSummary } from "@clots/ui-api-schemas";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "@/components/ui/context-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { api } from "@/lib/api-client";
import { clotLabel, labelOfName } from "@/lib/clots";
import { cn } from "@/lib/utils";
import { useAppState } from "./app-state";
import { ClotIcon } from "./clot-icon";

function RailLink({ href, label, active, children, className }: { href: string; label: string; active: boolean; children: ReactNode; className?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Link
          href={href}
          aria-label={label}
          aria-current={active ? "page" : undefined}
          className={cn("relative flex size-11 shrink-0 items-center justify-center rounded-card text-muted-foreground transition-colors hover:bg-muted-strong hover:text-foreground", active && "bg-card text-foreground ring-1 ring-border hover:bg-card", className)}
        >
          {children}
        </Link>
      </TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
}

/** A Clot in the rail: a link with its icon, a right-click menu that moves it, and a grip to drag it. */
function ClotItem({ clot, active, onMove, canUp, canDown }: { clot: ClotSummary; active: boolean; onMove: (direction: -1 | 1) => void; canUp: boolean; canDown: boolean }) {
  // The context menu opens with the Menu key or Shift+F10; Alt with an arrow key moves the Clot without opening it.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
    e.preventDefault();
    onMove(e.key === "ArrowUp" ? -1 : 1);
  };
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div onKeyDown={onKeyDown} data-rail-clot={clot.name}>
          <RailLink href={`/c/${encodeURIComponent(clot.name)}`} label={clotLabel(clot)} active={active}>
            <ClotIcon icon={clot.icon} home={clot.home} active={active} />
          </RailLink>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem disabled={!canUp} onSelect={() => onMove(-1)}>
          <ArrowUpIcon /> Move up
        </ContextMenuItem>
        <ContextMenuItem disabled={!canDown} onSelect={() => onMove(1)}>
          <ArrowDownIcon /> Move down
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** The desktop app's icon rail, on the background beside the page container. */
export function Rail() {
  const { clots, asks, refresh } = useAppState();
  const pathname = usePathname();
  const names = clots.map((c) => c.name).join("|");
  const [order, setOrder] = useState(() => clots.map((c) => c.name));
  const [seen, setSeen] = useState(names);
  const [said, setSaid] = useState("");
  const activeName = /^\/c\/([^/]+)/.exec(pathname)?.[1];
  const active = activeName === undefined ? undefined : decodeURIComponent(activeName);

  // The daemon's order is the truth; a drag changes it here first and tells the daemon when it lets go.
  if (seen !== names) {
    setSeen(names);
    setOrder(clots.map((c) => c.name));
  }

  const byName = new Map(clots.map((c) => [c.name, c]));
  const ordered = order.flatMap((name) => byName.get(name) ?? []);

  const save = async (next: string[]) => {
    try {
      await api("/clots/order", { method: "POST", body: { order: next } });
    } catch {
      await refresh();
    }
  };
  const move = (name: string, direction: -1 | 1) => {
    const at = order.indexOf(name);
    const to = at + direction;
    if (at < 0 || to < 0 || to >= order.length) return;
    const next = [...order];
    [next[at], next[to]] = [next[to]!, next[at]!];
    setOrder(next);
    void save(next);
    setSaid(`${labelOfName(name)} moved to position ${to + 1} of ${next.length}`);
    // The moved link is a new place in the list; keep the keyboard where it was.
    requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-rail-clot="${CSS.escape(name)}"] a`)?.focus());
  };

  const waiting = asks.length > 0;

  return (
    <nav aria-label="Clots" className="hidden w-17 shrink-0 flex-col items-center gap-1 py-2.5 md:flex">
      <div className="flex min-h-0 flex-col items-center gap-1 overflow-y-auto overflow-x-hidden [scrollbar-width:none]">
        <Reorder.Group axis="y" values={order} onReorder={setOrder} className="flex flex-col items-center gap-1">
          {ordered.map((clot) => (
            <Reorder.Item key={clot.name} value={clot.name} onDragEnd={() => void save(order)} className="cursor-grab active:cursor-grabbing" whileDrag={{ scale: 1.05 }}>
              <ClotItem clot={clot} active={active === clot.name} onMove={(d) => move(clot.name, d)} canUp={order.indexOf(clot.name) > 0} canDown={order.indexOf(clot.name) < order.length - 1} />
            </Reorder.Item>
          ))}
        </Reorder.Group>
        <RailLink href="/new" label="New Clot" active={pathname.startsWith("/new")}>
          <PlusIcon size={24} weight={pathname.startsWith("/new") ? "bold" : "regular"} />
        </RailLink>
      </div>
      <p role="status" className="sr-only">
        {said}
      </p>
      <div className="mt-auto flex flex-col items-center gap-1">
        <RailLink href="/waiting" label="Waiting for you" active={pathname.startsWith("/waiting")}>
          <BellIcon size={24} weight={pathname.startsWith("/waiting") ? "bold" : "regular"} />
          {waiting ? <span className="absolute right-2.5 top-[9px] size-2 rounded-full bg-highlight ring-2 ring-background" aria-label="Something is waiting" /> : null}
        </RailLink>
        <RailLink href="/settings/general" label="Settings" active={pathname.startsWith("/settings")}>
          <GearSixIcon size={24} weight={pathname.startsWith("/settings") ? "bold" : "regular"} />
        </RailLink>
      </div>
    </nav>
  );
}
