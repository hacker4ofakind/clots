"use client";

import { useMemo, useRef, useState } from "react";
import { MagnifyingGlassIcon, UploadSimpleIcon } from "@phosphor-icons/react";
import type { ClotIcon as ClotIconValue } from "@clots/ui-api-schemas";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { api, ApiFailure } from "@/lib/api-client";
import { PHOSPHOR_NAMES } from "@/lib/phosphor-names";
import { cn } from "@/lib/utils";
import { ClotIcon, ICON_COLORS, iconColorName, type IconColor } from "./clot-icon";

const SHOWN = 96;
const words = (name: string) => name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();

function readDataUrl(f: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(f);
  });
}

/** Converts an ICO to a PNG in the browser (the server cannot read ICO), or says it could not. */
async function fromIco(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file).catch(() => undefined);
  if (!bitmap) throw new Error("That ICO file could not be read. Save the icon as PNG and upload that.");
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 256;
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, 256, 256);
  return canvas.toDataURL("image/png");
}

/** The colour as a CSS value, from the icon colour tokens. */
const colorVar = (color: string): string => `var(--icon-${color})`;

/**
 * The button that shows a Clot's icon and opens the picker: any Phosphor icon in one of eight colours, or an upload (SVG, PNG,
 * JPG, WebP, ICO, or pasted). The names load without the library. A pick changes the preview at once; the dialog stays open until
 * it is closed.
 */
export function IconPicker({ value, onChange }: { value: ClotIconValue; onChange: (icon: ClotIconValue) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string>();
  const file = useRef<HTMLInputElement>(null);
  const color = "phosphor" in value ? iconColorName(value.color) : "red";
  const name = "phosphor" in value ? value.phosphor : "";
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q === "") return PHOSPHOR_NAMES.slice(0, SHOWN);
    // Names with a word that starts with what was typed come before those that only contain it ("lock" before "clock").
    const starts = (n: string) => (words(n).startsWith(q) || words(n).includes(` ${q}`) ? 0 : 1);
    return PHOSPHOR_NAMES.filter((n) => words(n).includes(q))
      .sort((a, b) => starts(a) - starts(b))
      .slice(0, SHOWN);
  }, [query]);

  const upload = async (f: File | undefined) => {
    if (!f) return;
    setError(undefined);
    try {
      const dataUrl = f.name.toLowerCase().endsWith(".ico") || f.type === "image/x-icon" || f.type === "image/vnd.microsoft.icon" ? await fromIco(f) : await readDataUrl(f);
      const { iconId } = await api<{ iconId: string }>("/clots/icons", { method: "POST", body: { dataUrl } });
      onChange({ upload: iconId });
      setOpen(false);
    } catch (e) {
      setError(e instanceof ApiFailure ? e.message : e instanceof Error ? e.message : "The icon could not be uploaded.");
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" variant="outline" aria-label="Pick an icon" className="size-18 rounded-2xl text-foreground">
          <ClotIcon icon={value} size={36} tile={72} />
        </Button>
      </DialogTrigger>
      <DialogContent className="flex max-h-155 flex-col gap-0 p-0 sm:max-w-120" aria-describedby={undefined} onPaste={(e) => void upload([...e.clipboardData.files][0])}>
        <DialogHeader className="px-5.5 pt-5">
          <DialogTitle>Pick an icon</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col items-center gap-4.5 px-5.5 py-4.5">
          <div className="flex size-20 items-center justify-center rounded-[20px]" style={{ background: `color-mix(in oklch, ${colorVar(color)} 14%, var(--popover))` }}>
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
            <InputGroupInput aria-label="Search icons" placeholder={`Search ${PHOSPHOR_NAMES.length.toLocaleString("en-US")} icons`} value={query} onChange={(e) => setQuery(e.target.value)} />
          </InputGroup>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4.5">
          <ToggleGroup type="single" value={name} onValueChange={(n) => n && onChange({ phosphor: n, color })} aria-label="Icon" spacing={1} className="grid w-full grid-cols-8">
            {matches.map((n) => (
              <ToggleGroupItem
                key={n}
                value={n}
                aria-label={words(n)}
                title={words(n)}
                className={cn("aspect-square h-auto min-w-0 rounded-[10px] text-foreground-soft data-[state=on]:bg-primary-soft data-[state=on]:text-primary-ink data-[state=on]:ring-[1.5px] data-[state=on]:ring-primary data-[state=on]:ring-inset")}
              >
                <ClotIcon icon={{ phosphor: n, color: "currentColor" }} size={22} />
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>
        {error ? (
          <p role="alert" className="px-5.5 pt-3 text-body text-primary-ink">
            {error}
          </p>
        ) : null}
        <div className="mt-3 flex items-center justify-between gap-3 border-t px-5.5 pb-4.5 pt-3.5">
          <span className="text-label font-normal text-muted-foreground">SVG, PNG, JPG, WebP or ICO. You can also paste one.</span>
          <Input ref={file} type="file" hidden accept="image/png,image/jpeg,image/webp,image/svg+xml,.ico,image/x-icon" onChange={(e) => void upload(e.target.files?.[0])} />
          <Button variant="outline" size="sm" onClick={() => file.current?.click()}>
            <UploadSimpleIcon /> Upload
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
