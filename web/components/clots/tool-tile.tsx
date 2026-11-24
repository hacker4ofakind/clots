"use client";

import { useState, type MouseEvent, type ReactNode } from "react";
import { ArrowsClockwiseIcon, PencilSimpleIcon, TrashIcon } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "@/components/ui/context-menu";
import type { ToolRow } from "@/lib/integrations";
import { ConfirmDialog } from "./confirm-dialog";
import { StatusDot } from "./status-dot";
import { LogoImage } from "./tool-logo";

export interface ToolTileProps {
  toolkit: string;
  name: string;
  logo?: string;
  /** A built-in tool's own icon, shown instead of a logo (Gmail and Calendar, which Clots connect without Composio). */
  icon?: ReactNode;
  status?: ToolRow["status"];
  /** The Clot's name, for "Remove from Truecast". */
  clot: string;
  /** Each action is in the menu only when its handler is given. A tile with none is a plain display. */
  onEdit?: () => void;
  onReconnect?: () => void;
  onRemove?: () => void | Promise<void>;
}

/**
 * A connected tool as a tile with its name under it. Right-click (or a click, Enter or the menu key, so it works from the
 * keyboard) opens a menu: Edit settings, Reconnect, Remove from the Clot, which asks first.
 */
export function ToolTile({ toolkit, name, logo, icon, status, clot, onEdit, onReconnect, onRemove }: ToolTileProps) {
  const [confirming, setConfirming] = useState(false);
  const interactive = onEdit !== undefined || onReconnect !== undefined || onRemove !== undefined;

  // A click asks for the same menu a right-click does, below the tile's right edge.
  const open = (e: MouseEvent<HTMLButtonElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    e.currentTarget.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: box.right, clientY: box.top + 8 }));
  };

  const face = icon ?? <LogoImage toolkit={toolkit} name={name} logo={logo} size={28} />;
  const flag = status === "failed" ? "Needs signing in again" : status === "waiting" ? "Waiting for sign-in" : undefined;

  return (
    <div className="relative flex w-23 flex-col items-center gap-2 text-caption font-normal">
      {interactive ? (
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <Button variant="outline" aria-haspopup="menu" aria-label={`${name}, options`} onClick={open} className="size-14 rounded-[14px] border-input p-0 data-[state=open]:bg-muted dark:bg-primary-foreground dark:hover:bg-primary-foreground/90 dark:data-[state=open]:bg-primary-foreground/80">
              {face}
            </Button>
          </ContextMenuTrigger>
          <ContextMenuContent aria-label={name}>
            {onEdit ? (
              <ContextMenuItem onSelect={onEdit}>
                <PencilSimpleIcon /> Edit settings
              </ContextMenuItem>
            ) : null}
            {onReconnect ? (
              <ContextMenuItem onSelect={onReconnect}>
                <ArrowsClockwiseIcon /> Reconnect
              </ContextMenuItem>
            ) : null}
            {onRemove ? (
              <ContextMenuItem variant="destructive" onSelect={() => setConfirming(true)}>
                <TrashIcon /> Remove from {clot}
              </ContextMenuItem>
            ) : null}
          </ContextMenuContent>
        </ContextMenu>
      ) : (
        <span className="flex size-14 items-center justify-center rounded-[14px] border border-input bg-card dark:bg-primary-foreground">{face}</span>
      )}
      {flag ? (
        <span className="absolute top-0 right-3">
          <StatusDot tone={status === "failed" ? "primary" : "calling"} />
          <span className="sr-only">{flag}</span>
        </span>
      ) : null}
      <span className="line-clamp-2 max-w-full text-center break-words">{name}</span>
      {onRemove ? <ConfirmDialog open={confirming} onOpenChange={setConfirming} title={`Remove ${name} from ${clot}?`} description={`${clot} stops using it. You can connect it again later.`} confirmLabel="Remove" onConfirm={() => void onRemove()} /> : null}
    </div>
  );
}
