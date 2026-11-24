"use client";

import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent } from "react";
import { ArrowUpIcon, PlusIcon, XIcon } from "@phosphor-icons/react";
import type { CommandInfo } from "@clots/ui-api-schemas";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { useAppState } from "./app-state";
import { fuzzy, SlashMenu, type Match } from "./slash-menu";

export interface Draft {
  text: string;
  /** Data URLs of the images attached. */
  images: string[];
}

/** Longest side, in pixels, an image keeps before it is sent: a phone's screenshot is far larger than a Clot needs. */
export const MAX_SIDE = 2048;

/** Shrinks an image to at most MAX_SIDE on its longest side, as a JPEG when it had to be changed. Small images pass as they are. */
export async function prepareImage(file: File): Promise<string> {
  const original = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
  const bitmap = await createImageBitmap(file).catch(() => undefined);
  if (!bitmap) return original;
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  if (scale === 1 && file.size < 3 * 1024 * 1024) return original;
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.85);
}

/** The message box: attach (desktop), an auto-growing text, send. Typing / opens the slash menu. `clot` keys the draft, `label` is what the box says. */
export function Composer({ clot, label, onSend, disabled }: { clot: string; label: string; onSend: (draft: Draft) => void; disabled?: boolean }) {
  const { connection } = useAppState();
  const [text, setText] = useState("");
  const [images, setImages] = useState<string[]>([]);
  const [commands, setCommands] = useState<CommandInfo[]>([]);
  const [selected, setSelected] = useState(0);
  const [menuClosed, setMenuClosed] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const key = `draft:${clot}`;

  // A draft survives leaving the chat, per Clot.
  useEffect(() => {
    try {
      setText(localStorage.getItem(key) ?? "");
    } catch {
      setText("");
    }
    setImages([]);
  }, [key]);
  useEffect(() => {
    try {
      if (text === "") localStorage.removeItem(key);
      else localStorage.setItem(key, text);
    } catch {
      // Private mode: the draft lives only while the page does.
    }
  }, [key, text]);
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
  useEffect(() => setSelected(0), [query]);
  useEffect(() => setMenuClosed(false), [text === "" || text === "/"]);

  const off = disabled || connection === "down";
  const canSend = (text.trim() !== "" || images.length > 0) && !off;
  const touch = typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches;

  const send = () => {
    if (!canSend) return;
    onSend({ text, images });
    setText("");
    setImages([]);
  };
  const choose = (name: string) => {
    setText(`/${name} `);
    area.current?.focus();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (matches.length > 0) {
      if (e.key === "ArrowDown") return void (e.preventDefault(), setSelected((s) => (s + 1) % matches.length));
      if (e.key === "ArrowUp") return void (e.preventDefault(), setSelected((s) => (s - 1 + matches.length) % matches.length));
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey && matches[selected] && query.trim().toLowerCase() !== matches[selected]!.command.name)) return void (e.preventDefault(), choose(matches[selected]!.command.name));
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
    setImages((list) => [...list, ...prepared.filter((x): x is string => x !== undefined)].slice(0, 6));
  };
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const pictures = [...e.clipboardData.files].filter((f) => f.type.startsWith("image/"));
    if (pictures.length === 0) return;
    e.preventDefault();
    void addFiles(pictures);
  };

  return (
    <div className="px-3 pb-[max(env(safe-area-inset-bottom),34px)] pt-2 md:px-10 md:pb-4 md:pt-0">
      <div className="relative">
        {matches.length > 0 ? <SlashMenu matches={matches} selected={selected} onChoose={choose} /> : null}
        <div className="flex flex-col gap-2 rounded-composer border border-input bg-card p-2 shadow-xs focus-within:ring-2 focus-within:ring-ring">
          {images.length > 0 ? (
            <ul className="flex gap-2 px-2 pt-1">
              {images.map((src, i) => (
                <li key={i} className="relative">
                  {/* eslint-disable-next-line @next/next/no-img-element -- a local data URL the user attached */}
                  <img src={src} alt="Attached" className="size-14 rounded-control object-cover" />
                  <Button type="button" variant="default" size="icon-xs" aria-label="Remove image" onClick={() => setImages((list) => list.filter((_, j) => j !== i))} className="absolute -right-1.5 -top-1.5 size-5 rounded-full bg-foreground text-background hover:bg-foreground-soft">
                    <XIcon size={12} weight="bold" />
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}
          <div className="flex items-end gap-2">
            <Input ref={file} type="file" accept="image/*" multiple hidden onChange={(e) => void addFiles([...(e.target.files ?? [])])} />
            <Button variant="ghost" size="icon" aria-label="Attach an image" onClick={() => file.current?.click()} className="size-9 rounded-full max-md:hidden">
              <PlusIcon />
            </Button>
            <Textarea
              ref={area}
              rows={1}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={onKeyDown}
              onPaste={onPaste}
              aria-label={`Message ${label}`}
              placeholder={`Message ${label}…`}
              className={cn("max-h-[200px] min-h-[34px] flex-1 resize-none self-center rounded-none border-0 bg-transparent px-2 py-[5px] text-[16px] leading-6 shadow-none ring-0 focus-visible:ring-0 md:text-chat max-md:pl-2", text.startsWith("/") && "font-mono md:text-body")}
            />
            <Button type="button" size="icon" aria-label="Send" disabled={!canSend} onClick={send} className={cn("size-[34px] rounded-full max-md:size-9 [&_svg:not([class*='size-'])]:size-4", !canSend && "bg-muted-strong text-muted-foreground disabled:opacity-100")}>
              <ArrowUpIcon weight="bold" />
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
