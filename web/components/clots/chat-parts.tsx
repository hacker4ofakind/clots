"use client";

import { useId, useState } from "react";
import { CaretRightIcon, InfoIcon } from "@phosphor-icons/react";
import type { MessageView } from "@clots/ui-api-schemas";
import { Button } from "@/components/ui/button";
import { motion, AnimatePresence, useReducedMotion } from "motion/react";
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
  const body = rest.join("\n\n") || first || "";
  return <Recap body={body} />;
}

/** The recap's lines, one unit each: a list item on its own, any other block whole. They fade in one after another. */
export function recapLines(body: string): string[] {
  const listItem = /^\s*([-*]|\d+\.)\s/;
  return body
    .split(/\n{2,}/)
    .flatMap((block) => {
      const lines = block.split("\n").filter((l) => l.trim() !== "");
      return lines.length > 1 && lines.every((l) => listItem.test(l)) ? lines : [block];
    })
    .filter((b) => b.trim() !== "");
}

/**
 * The folded recap a new session starts with. It stays centred when opened: the button is centred above a text block of its own, the
 * caret turns, the height opens smoothly (the conversation below moves with it) and the lines fade in one after another.
 */
function Recap({ body }: { body: string }) {
  const [open, setOpen] = useState(false);
  const reduce = useReducedMotion();
  const lines = recapLines(body);
  const id = useId();
  return (
    <div className="flex w-full flex-col items-center text-caption text-muted-foreground" data-recap>
      <Button variant="ghost" size="xs" className="text-foreground-soft" aria-expanded={open} aria-controls={id} onClick={() => setOpen((o) => !o)}>
        <motion.span className="inline-flex" animate={{ rotate: open ? 90 : 0 }} transition={{ duration: reduce ? 0 : 0.2, ease: "easeOut" }}>
          <CaretRightIcon aria-hidden />
        </motion.span>
        New session. Recap of the previous one
      </Button>
      <AnimatePresence initial={false}>
        {open ? (
          <motion.div
            key="recap"
            id={id}
            className="w-full overflow-hidden"
            initial={{ height: 0 }}
            animate={{ height: "auto" }}
            exit={{ height: 0 }}
            transition={{ duration: reduce ? 0 : 0.32, ease: [0.22, 1, 0.36, 1] }}
          >
            <div className="mx-auto max-w-full pt-2 text-left text-body text-foreground">
              {lines.map((line, i) => (
                <motion.div key={i} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: { duration: reduce ? 0 : 0.12 } }} transition={{ duration: reduce ? 0 : 0.19, delay: reduce ? 0 : 0.03 + Math.min(i, 10) * 0.015 }}>
                  <Markdown text={line} />
                </motion.div>
              ))}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
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
