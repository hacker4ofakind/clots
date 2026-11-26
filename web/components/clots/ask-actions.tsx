"use client";

import { ArrowSquareOutIcon, CaretRightIcon, CheckIcon, PencilSimpleIcon, XIcon } from "@phosphor-icons/react";
import type { AskSnapshot } from "@clots/ui-api-schemas";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

export interface AskActionsProps {
  ask: AskSnapshot;
  busy: boolean;
  disabled: boolean;
  onAllow: () => void;
  onBlock: () => void;
  onPick: (option: 0 | 1) => void;
  onOpen: () => void;
  /** Email only: go to the card with its text open for changes. */
  onEdit?: () => void;
  /** The phone: Block and Allow, and nothing else. A choice has no buttons there: tapping the row opens the chat. */
  compact?: boolean;
}

/**
 * The buttons that answer an ask from Waiting for you, in one bordered group with dividers: Decline, Open in chat, Approve, with the approving one
 * last and filled. An email adds Edit first. A choice shows its two options, the Clot's pick marked. Each button names its effect for
 * a screen reader.
 */
export function AskActions({ ask, busy, disabled, onAllow, onBlock, onPick, onOpen, onEdit, compact }: AskActionsProps) {
  const labels = ask.view.labels ?? { allow: "Approve", block: "Decline" };
  const off = disabled || busy;

  if (ask.view.options) {
    if (compact) return <CaretRightIcon size={20} className="text-muted-foreground" aria-hidden />;
    return (
      <div className="flex items-center gap-1.5" role="group" aria-label="Choose">
        {ask.view.options.map((option, i) => (
          <Button key={option} variant="outline" size="sm" disabled={off} onClick={() => onPick(i as 0 | 1)} className={cn(ask.view.pick === i && "border-primary text-primary-ink")}>
            <span className="max-w-48 truncate">{option}</span>
            {ask.view.pick === i ? <span className="font-medium text-muted-foreground">· pick</span> : null}
          </Button>
        ))}
        <Button variant="ghost" size="icon-sm" aria-label="Open in chat" onClick={onOpen}>
          <ArrowSquareOutIcon />
        </Button>
      </div>
    );
  }

  if (compact) {
    return (
      <ButtonGroup aria-label="Answer">
        <Button variant="outline" disabled={off} aria-label={labels.block} onClick={onBlock} className="h-10 w-11 [&_svg:not([class*='size-'])]:size-5">
          <XIcon />
        </Button>
        <Button disabled={off} aria-label={labels.allow === "Approve" ? "Allow" : labels.allow} onClick={onAllow} className="h-10 w-11 border-primary [&_svg:not([class*='size-'])]:size-5">
          {busy ? <Spinner /> : <CheckIcon />}
        </Button>
      </ButtonGroup>
    );
  }

  return (
    <div role="group" aria-label="Answer" className="flex h-8.5 overflow-hidden rounded-control border border-input bg-card [&>button]:h-8 [&>button]:w-9 [&>button]:rounded-none [&>button]:border-0 [&>button+button]:border-l [&>button+button]:border-l-input">
      {onEdit ? (
        <Button variant="ghost" aria-label="Edit" disabled={off} onClick={onEdit}>
          <PencilSimpleIcon />
        </Button>
      ) : null}
      <Button variant="ghost" aria-label={labels.block} disabled={off} onClick={onBlock}>
        <XIcon />
      </Button>
      <Button variant="ghost" aria-label="Open in chat" onClick={onOpen}>
        <ArrowSquareOutIcon />
      </Button>
      <Button aria-label={labels.allow} disabled={off} onClick={onAllow}>
        {busy ? <Spinner /> : <CheckIcon />}
      </Button>
    </div>
  );
}
