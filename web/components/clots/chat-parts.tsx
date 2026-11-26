"use client";

import { useState } from "react";
import { CaretDownIcon, CaretRightIcon, InfoIcon } from "@phosphor-icons/react";
import type { MessageView } from "@clots/ui-api-schemas";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { AttachmentThumb } from "./attachment-thumb";
import type { Item } from "./chat-items";
import { NamedIcon } from "./clot-icon";
import { Markdown } from "./markdown";

/** A line of what the Clot did between its messages, or the summary of a turn's files and commands. */
export function Activity({ message }: { message: MessageView }) {
  const data = message.data as { type?: string; icon?: string; files?: { path: string; added: number; removed: number }[]; commands?: string[] } | null;
  if (data?.type === "summary") {
    const files = data.files ?? [];
    const commands = data.commands ?? [];
    return (
      <details className="text-label leading-normal font-normal text-muted-foreground">
        <summary className="cursor-pointer select-none">
          {files.length > 0 ? `${files.length} file${files.length === 1 ? "" : "s"} changed` : ""}
          {files.length > 0 && commands.length > 0 ? ", " : ""}
          {commands.length > 0 ? `${commands.length} command${commands.length === 1 ? "" : "s"} run` : ""}
        </summary>
        <ul className="mt-1 flex flex-col gap-0.5 font-mono text-code">
          {files.map((f) => (
            <li key={f.path}>
              <span className="text-highlight-ink">+{f.added}</span> <span className="text-primary-ink">-{f.removed}</span> {f.path}
            </li>
          ))}
          {commands.map((c, i) => (
            <li key={i} className="truncate">
              {c.split("\n")[0]}
            </li>
          ))}
        </ul>
      </details>
    );
  }
  return (
    <p className="flex items-center gap-2 text-label leading-normal font-normal text-muted-foreground">
      {data?.icon ? <NamedIcon name={data.icon} size={16} className="shrink-0" /> : null}
      {message.text}
    </p>
  );
}

/** A centred system line (the context limit, a pause), or the folded recap a new session starts with. */
export function Note({ message }: { message: MessageView }) {
  const [open, setOpen] = useState(false);
  const recap = (message.data as { recap?: boolean } | null)?.recap === true;
  if (!recap) {
    return (
      <p className="flex items-center gap-1.5 self-center py-1 text-center text-caption leading-normal font-normal text-muted-foreground">
        <InfoIcon size={16} className="shrink-0" aria-hidden />
        {message.text}
      </p>
    );
  }
  const [first, ...rest] = message.text.split("\n\n");
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="self-center text-caption text-muted-foreground" data-recap>
      <CollapsibleTrigger asChild>
        <Button variant="ghost" size="xs" className="text-foreground-soft">
          {open ? <CaretDownIcon /> : <CaretRightIcon />}
          New session. Recap of the previous one
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <Markdown text={rest.join("\n\n") || first || ""} className="mt-2 text-body text-foreground" />
      </CollapsibleContent>
    </Collapsible>
  );
}

/** The user's own message: a muted bubble on the right, with its pictures, and Retry when it did not go. */
export function UserBubble({ item, onRetry, dimmed }: { item: Item; onRetry: () => void; dimmed: boolean }) {
  const { message } = item;
  const sources = item.images ?? Array.from({ length: message.images }, (_, i) => `/api/d/clots/${encodeURIComponent(message.clot)}/messages/${message.id}/images/${i}`);
  return (
    <div className={cn("flex w-full flex-col items-end gap-1", dimmed && "opacity-55")} data-message-kind="user">
      <div className={cn("max-w-[75%] rounded-card bg-muted px-3.5 py-2.5 text-chat", item.status === "sending" && "opacity-70")}>
        {sources.length > 0 ? (
          <div className="mb-2 flex flex-wrap gap-2">
            {sources.map((src, i) => (
              <AttachmentThumb key={i} src={src} sizes="240px" className="aspect-4/3 w-60 max-w-full" />
            ))}
          </div>
        ) : null}
        {message.text ? <p className="break-words whitespace-pre-wrap [overflow-wrap:anywhere]">{message.text}</p> : null}
      </div>
      {item.status === "failed" ? (
        <p className="flex items-center gap-2 text-caption text-primary-ink" role="alert">
          Not sent.
          <Button type="button" variant="link" size="xs" onClick={onRetry} className="h-auto p-0 text-primary-ink">
            Retry
          </Button>
        </p>
      ) : null}
    </div>
  );
}
