import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";

/** Stored icons are never larger than this on a side. */
const SIZE = 256;
const MAX_BYTES = 2 * 1024 * 1024;

export class IconError extends Error {}

/** What an upload really is, from its first bytes. ICO is not read here: the browser converts it, or it is refused. */
export function sniff(data: Buffer): "png" | "jpeg" | "webp" | "svg" | "ico" | undefined {
  if (data.length > 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (data.length > 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "jpeg";
  if (data.length > 12 && data.subarray(0, 4).toString("latin1") === "RIFF" && data.subarray(8, 12).toString("latin1") === "WEBP") return "webp";
  if (data.length > 4 && data[0] === 0 && data[1] === 0 && data[2] === 1 && data[3] === 0) return "ico";
  const head = data.subarray(0, 512).toString("utf8").trimStart().toLowerCase();
  if (head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"))) return "svg";
  return undefined;
}

type Pixels = { data: Buffer; width: number; height: number };

/**
 * The colours an image is made of: its opaque pixels grouped by colour (each channel in steps of 32), keeping the groups
 * with at least 3% of them. A two-colour image has two.
 */
export function colourClusters(pixels: Pixels): { r: number; g: number; b: number }[] {
  const groups = new Map<number, { n: number; r: number; g: number; b: number }>();
  let opaque = 0;
  for (let i = 0; i < pixels.data.length; i += 4) {
    if (pixels.data[i + 3]! < 128) continue;
    opaque += 1;
    const [r, g, b] = [pixels.data[i]!, pixels.data[i + 1]!, pixels.data[i + 2]!];
    const key = ((r >> 5) << 6) | ((g >> 5) << 3) | (b >> 5);
    const group = groups.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
    group.n += 1;
    group.r += r;
    group.g += g;
    group.b += b;
    groups.set(key, group);
  }
  return [...groups.values()].filter((g) => g.n >= opaque * 0.03).map((g) => ({ r: Math.round(g.r / g.n), g: Math.round(g.g / g.n), b: Math.round(g.b / g.n) }));
}

/** The active variant: two colours are swapped for each other; anything else is inverted. */
export function activeVariant(pixels: Pixels): Buffer {
  const clusters = colourClusters(pixels);
  const out = Buffer.from(pixels.data);
  const distance = (c: { r: number; g: number; b: number }, i: number) => (c.r - out[i]!) ** 2 + (c.g - out[i + 1]!) ** 2 + (c.b - out[i + 2]!) ** 2;
  for (let i = 0; i < out.length; i += 4) {
    if (out[i + 3]! === 0) continue;
    if (clusters.length === 2) {
      const [a, b] = clusters as [(typeof clusters)[0], (typeof clusters)[0]];
      const to = distance(a, i) <= distance(b, i) ? b : a;
      out[i] = to.r;
      out[i + 1] = to.g;
      out[i + 2] = to.b;
    } else {
      out[i] = 255 - out[i]!;
      out[i + 1] = 255 - out[i + 1]!;
      out[i + 2] = 255 - out[i + 2]!;
    }
  }
  return out;
}

export interface ProcessedIcon {
  normal: Buffer;
  active: Buffer;
}

/** Checks an upload and makes the stored icon and its active variant, as PNGs. An SVG is drawn to pixels first, so no markup is ever stored or served. */
export async function processIcon(data: Buffer): Promise<ProcessedIcon> {
  if (data.length > MAX_BYTES) throw new IconError("An icon can be at most 2 MB.");
  const kind = sniff(data);
  if (kind === undefined) throw new IconError("An icon is a PNG, JPEG, WebP or SVG image.");
  if (kind === "ico") throw new IconError("ICO files cannot be read here. Save the icon as PNG and upload that.");
  try {
    const image = sharp(data, { density: kind === "svg" ? 300 : 72, limitInputPixels: 40_000_000 }).resize(SIZE, SIZE, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } }).ensureAlpha();
    const { data: raw, info } = await image.raw().toBuffer({ resolveWithObject: true });
    const pixels = { data: raw, width: info.width, height: info.height };
    const toPng = (buf: Buffer) => sharp(buf, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer();
    return { normal: await toPng(raw), active: await toPng(activeVariant(pixels)) };
  } catch {
    throw new IconError("That image could not be read.");
  }
}

/** Where uploaded icons are kept. */
export class IconStore {
  constructor(private dir: string) {
    fs.mkdirSync(dir, { recursive: true });
  }
  async add(data: Buffer): Promise<string> {
    const icon = await processIcon(data);
    const id = randomBytes(8).toString("hex");
    fs.writeFileSync(path.join(this.dir, `${id}.png`), icon.normal);
    fs.writeFileSync(path.join(this.dir, `${id}.active.png`), icon.active);
    return id;
  }
  read(id: string, active: boolean): Buffer | undefined {
    if (!/^[a-f0-9]{16}$/.test(id)) return undefined;
    const file = path.join(this.dir, `${id}${active ? ".active" : ""}.png`);
    return fs.existsSync(file) ? fs.readFileSync(file) : undefined;
  }
}
