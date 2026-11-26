"use client";

import { useMemo, useRef, useState, type ClipboardEvent } from "react";
import { MagnifyingGlassIcon, UploadSimpleIcon } from "@phosphor-icons/react";
import type { ClotIcon as ClotIconValue } from "@clots/ui-api-schemas";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Spinner } from "@/components/ui/spinner";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { PHOSPHOR_NAMES } from "@/lib/phosphor-names";
import { ClotIcon, ICON_COLORS, iconColorName, type IconColor } from "./clot-icon";
import { CURATED_ICONS } from "./curated-icons";
import { IconUploadProblem, UNREADABLE, uploadIcon } from "./icon-upload";

const SHOWN = 96;
const words = (name: string) => name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();

/** The colour as a CSS value, from the icon colour tokens. */
const colorVar = (color: string): string => `var(--icon-${color})`;

/**
 * The button that shows a Clot's icon and opens the picker: any Phosphor icon in one of eight colours, or an upload (SVG, PNG,
 * JPG, WebP, ICO, or pasted). It opens on a curated grid; the whole catalogue is searched by name. The names load without the
 * library. The dialog is one size however many icons match, so nothing moves while typing; the results scroll, the footer stays.
 * A pick changes the preview at once; the dialog stays open until it is closed (an upload closes it).
 */
export function IconPicker({ value, onChange }: { value: ClotIconValue; onChange: (icon: ClotIconValue) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string>();
  const [uploading, setUploading] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const color = "phosphor" in value ? iconColorName(value.color) : "red";
  const name = "phosphor" in value ? value.phosphor : "";
  const searching = query.trim() !== "";
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q === "") return CURATED_ICONS;
    // Names with a word that starts with what was typed come before those that only contain it ("lock" before "clock").
    const starts = (n: string) => (words(n).startsWith(q) || words(n).includes(` ${q}`) ? 0 : 1);
    return PHOSPHOR_NAMES.filter((n) => words(n).includes(q))
      .sort((a, b) => starts(a) - starts(b))
      .slice(0, SHOWN);
  }, [query]);

  const upload = async (f: File | undefined, from: "dialog" | "paste") => {
    if (!f || uploading) return;
    setError(undefined);
    setUploading(true);
    try {
      onChange({ upload: await uploadIcon(f, from) });
      setOpen(false);
    } catch (e) {
      setError(e instanceof IconUploadProblem ? e.message : UNREADABLE);
    } finally {
      setUploading(false);
    }
  };

  // A picture on the clipboard is an upload; pasted text goes where it was pasted (the search box).
  const paste = (e: ClipboardEvent<HTMLElement>) => {
    const pasted = e.clipboardData.files[0];
    if (!pasted) return;
    e.preventDefault();
    void upload(pasted, "paste");
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setQuery("");
          setError(undefined);
        }
      }}
    >
      <DialogTrigger asChild>
        <Button type="button" variant="outline" aria-label="Pick an icon" className="size-18 rounded-2xl text-foreground [&_svg:not([class*='size-'])]:size-9">
          <ClotIcon icon={value} size={36} tile={72} />
        </Button>
      </DialogTrigger>
      <DialogContent className="flex h-140 max-h-[calc(100dvh-2rem)] w-120 flex-col gap-0 p-0 sm:max-w-120" aria-describedby={undefined} onPaste={paste}>
        <DialogHeader className="shrink-0 px-5.5 pt-5">
          <DialogTitle>Pick an icon</DialogTitle>
        </DialogHeader>
        <div className="flex shrink-0 flex-col items-center gap-4.5 px-5.5 py-4.5">
          <div className="flex size-20 items-center justify-center rounded-tile-2xl" style={{ background: `color-mix(in oklch, ${colorVar(color)} 14%, var(--popover))` }}>
            <ClotIcon icon={value} size={44} tile={80} />
          </div>
          <ToggleGroup type="single" value={color} onValueChange={(c) => c && onChange({ phosphor: name === "" ? "Sliders" : name, color: c })} aria-label="Colour" spacing={2.5}>
            {ICON_COLORS.map((c: IconColor) => (
              <ToggleGroupItem key={c} value={c} aria-label={c === "red" ? "Rose" : c[0]!.toUpperCase() + c.slice(1)} className="size-7 min-w-7 rounded-full p-0 data-[state=on]:ring-2 data-[state=on]:ring-foreground data-[state=on]:ring-offset-2 data-[state=on]:ring-offset-popover" style={{ background: colorVar(c) }} />
            ))}
          </ToggleGroup>
          <InputGroup>
            <InputGroupAddon>
              <MagnifyingGlassIcon />
            </InputGroupAddon>
            <InputGroupInput aria-label="Search icons" placeholder={`Search ${PHOSPHOR_NAMES.length.toLocaleString("en-US")} icons`} value={query} onChange={(e) => (setQuery(e.target.value), setError(undefined))} />
          </InputGroup>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4.5">
          {matches.length === 0 ? (
            <p className="px-2 pt-6 text-center text-body text-muted-foreground">No icon is called that. Try another word.</p>
          ) : (
            <ToggleGroup type="single" value={name} onValueChange={(n) => n && onChange({ phosphor: n, color })} aria-label={searching ? "Search results" : "Icons"} spacing={1} className="grid w-full grid-cols-8">
              {matches.map((n) => (
                <ToggleGroupItem
                  key={n}
                  value={n}
                  aria-label={words(n)}
                  title={words(n)}
                  className="aspect-square h-auto min-w-0 rounded-menu text-foreground-soft data-[state=on]:bg-primary-soft data-[state=on]:text-primary-ink data-[state=on]:ring-[1.5px] data-[state=on]:ring-primary data-[state=on]:ring-inset"
                >
                  <ClotIcon icon={{ phosphor: n, color: "currentColor" }} size={22} />
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          )}
        </div>
        <div className="mt-3 flex min-h-17 shrink-0 items-center justify-between gap-3 border-t px-5.5 py-3.5">
          {error ? (
            <span role="alert" className="min-w-0 text-label font-normal text-primary-ink">
              {error}
            </span>
          ) : (
            <span className="min-w-0 text-label font-normal text-muted-foreground">SVG, PNG, JPG, WebP or ICO. You can also paste one.</span>
          )}
          <Input
            ref={file}
            type="file"
            hidden
            aria-label="Icon file"
            accept="image/png,image/jpeg,image/webp,image/svg+xml,image/x-icon,image/vnd.microsoft.icon,.svg,.png,.jpg,.jpeg,.webp,.ico"
            onChange={(e) => {
              const picked = e.target.files?.[0];
              // Cleared so the same file can be chosen again after a failure.
              e.target.value = "";
              void upload(picked, "dialog");
            }}
          />
          <Button variant="outline" size="sm" className="shrink-0" disabled={uploading} onClick={() => file.current?.click()}>
            {uploading ? <Spinner /> : <UploadSimpleIcon />} Upload
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
