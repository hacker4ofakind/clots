"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ClipboardEvent, type KeyboardEvent } from "react";
import { ArrowUpIcon, PlusIcon, XIcon } from "@phosphor-icons/react";
import type { CommandInfo } from "@clots/ui-api-schemas";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { api } from "@/lib/api-client";
import { readDraft, writeDraft } from "@/lib/draft";
import { prepareImage } from "@/lib/images";
import { useViewport } from "@/lib/viewport";
import { cn } from "@/lib/utils";
import { useAppState } from "./app-state";
import { AttachmentThumb } from "./attachment-thumb";
import { fuzzy, SlashMenu, type Match } from "./slash-menu";

export interface Draft {
  text: string;
  /** Data URLs of the images attached. */
  images: string[];
}

/** The message box: attach (desktop), an auto-growing text, send. Typing / opens the slash menu. `clot` keys the draft, `label` is what the box says. */
export function Composer({ clot, label, onSend, disabled }: { clot: string; label: string; onSend: (draft: Draft) => void; disabled?: boolean }) {
  const { connection } = useAppState();
  const { keyboard } = useViewport();
  const [typed, setTyped] = useState<{ clot: string; text: string }>();
  const [images, setImages] = useState<string[]>([]);
  const [commands, setCommands] = useState<CommandInfo[]>([]);
  const [selected, setSelected] = useState(0);
  const [menuClosed, setMenuClosed] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const file = useRef<HTMLInputElement>(null);

  // A draft survives leaving the chat, per Clot. The stored text is read after hydration (the server has none) and is replaced by what is
  // typed; each keystroke writes it back, so no effect has to, and a remount cannot wipe it.
  const stored = useSyncExternalStore(
    () => () => undefined,
    () => readDraft(clot),
    () => "",
  );
  const text = typed?.clot === clot ? typed.text : stored;
  const edit = (value: string) => {
    setTyped({ clot, text: value });
    writeDraft(clot, value);
    setSelected(0);
    if (value === "" || value === "/") setMenuClosed(false);
  };
  useEffect(() => {
    void api<CommandInfo[]>("/commands").then(setCommands).catch(() => undefined);
  }, []);
  useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [text]);

  const slash = text.startsWith("/") && !text.includes("\n") && !menuClosed;
  const query = text.slice(1);
  const matches = useMemo(
    () =>
      slash
        ? commands
            .map((command) => ({ command, m: fuzzy(command.name, query.trimStart()) }))
            .filter((x): x is { command: CommandInfo; m: { score: number; bold: number[] } } => x.m !== undefined)
            .sort((a, b) => a.m.score - b.m.score)
            .map(({ command, m }): Match => ({ command, bold: m.bold }))
        : [],
    [slash, commands, query],
  );

  const off = disabled || connection === "down";
  const canSend = (text.trim() !== "" || images.length > 0) && !off;
  const touch = typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches;

  const send = (words = text) => {
    if (!canSend) return;
    onSend({ text: words, images });
    edit("");
    setImages([]);
  };
  const choose = (name: string) => {
    edit(`/${name} `);
    area.current?.focus();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (matches.length > 0) {
      if (e.key === "ArrowDown") return void (e.preventDefault(), setSelected((s) => (s + 1) % matches.length));
      if (e.key === "ArrowUp") return void (e.preventDefault(), setSelected((s) => (s - 1 + matches.length) % matches.length));
      const picked = matches[selected]?.command;
      if (picked && e.key === "Tab") return void (e.preventDefault(), choose(picked.name));
      if (picked && e.key === "Enter" && !e.shiftKey && !touch) {
        e.preventDefault();
        // A command that needs nothing more is run by the one press; one that needs an argument is completed for the user to finish.
        if (!picked.required) send(`/${picked.name}`);
        else if (query.trim().toLowerCase() !== picked.name) choose(picked.name);
        else send();
        return;
      }
      if (e.key === "Escape") return void (e.preventDefault(), setMenuClosed(true));
    }
    if (e.key === "Enter" && !e.shiftKey && !touch) {
      e.preventDefault();
      send();
    }
  };
  const addFiles = async (files: File[]) => {
    const pictures = files.filter((f) => f.type.startsWith("image/"));
    if (pictures.length === 0) return;
    const prepared = await Promise.all(pictures.map((f) => prepareImage(f).catch(() => undefined)));
    if (prepared.some((x) => x === undefined)) toast("That picture could not be read, so it was left out");
    setImages((list) => [...list, ...prepared.filter((x): x is string => x !== undefined)].slice(0, 6));
  };
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const pictures = [...e.clipboardData.files].filter((f) => f.type.startsWith("image/"));
    if (pictures.length === 0) return;
    e.preventDefault();
    void addFiles(pictures);
  };

  return (
    <div className={cn("chat-gutter px-3 pt-2 md:pb-4 md:pt-0", keyboard ? "pb-2" : "pb-[max(env(safe-area-inset-bottom),34px)]")}>
      <div className="relative">
        {matches.length > 0 ? <SlashMenu matches={matches} selected={selected} onSelect={setSelected} onChoose={choose} /> : null}
        <div className="flex flex-col gap-2 rounded-composer border border-input bg-card p-2 shadow-xs focus-within:ring-2 focus-within:ring-ring">
          {images.length > 0 ? (
            <ul className="flex gap-2 px-2 pt-1">
              {images.map((src, i) => (
                <li key={i} className="relative">
                  <AttachmentThumb src={src} sizes="56px" fit="cover" className="size-14" />
                  <Button type="button" variant="default" size="icon-xs" aria-label="Remove image" onClick={() => setImages((list) => list.filter((_, j) => j !== i))} className="absolute -right-1.5 -top-1.5 size-5 rounded-full bg-foreground text-background hover:bg-foreground-soft">
                    <XIcon size={12} weight="bold" />
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}
          <div className="flex items-end gap-2">
            <Input ref={file} type="file" accept="image/*" multiple hidden onChange={(e) => void addFiles([...(e.target.files ?? [])])} />
            <Button variant="ghost" size="icon" aria-label="Attach an image" disabled={off} onClick={() => file.current?.click()} className="size-9 rounded-full max-md:hidden">
              <PlusIcon />
            </Button>
            <Textarea
              ref={area}
              rows={1}
              value={text}
              onChange={(e) => edit(e.target.value)}
              onKeyDown={onKeyDown}
              onPaste={onPaste}
              aria-label={`Message ${label}`}
              placeholder={`Message ${label}…`}
              className={cn("max-h-50 min-h-8.5 flex-1 resize-none self-center rounded-none border-0 bg-transparent px-0 py-1.25 text-base leading-6 shadow-none ring-0 focus-visible:ring-0 md:text-chat max-md:pl-2", text.startsWith("/") && "font-mono md:text-body")}
            />
            <Button type="button" size="icon" aria-label="Send" disabled={!canSend} onClick={() => send()} className={cn("size-8.5 rounded-full border-0 max-md:size-9 [&_svg:not([class*='size-'])]:size-4", !canSend && "bg-muted-strong text-muted-foreground disabled:opacity-100")}>
              <ArrowUpIcon weight="bold" />
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
