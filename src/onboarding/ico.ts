import sharp from "sharp";

/** The first bytes of every PNG. */
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** An ICO file starts with a reserved zero, the type 1 and a count of images. (Type 2 is a cursor, which is not an icon.) */
export function looksLikeIco(data: Buffer): boolean {
  return data.length >= 22 && data.readUInt16LE(0) === 0 && data.readUInt16LE(2) === 1 && data.readUInt16LE(4) > 0 && data.readUInt16LE(4) <= 256;
}

interface Entry {
  width: number;
  height: number;
  bits: number;
  size: number;
  offset: number;
}

/** The images an ICO holds, from its directory. Each says where its bytes are; the ones past the end of the file are left out. */
function entries(data: Buffer): Entry[] {
  const count = data.readUInt16LE(4);
  const found: Entry[] = [];
  for (let i = 0; i < count; i += 1) {
    const at = 6 + i * 16;
    if (at + 16 > data.length) break;
    const size = data.readUInt32LE(at + 8);
    const offset = data.readUInt32LE(at + 12);
    if (size === 0 || offset + size > data.length) continue;
    found.push({ width: data[at]! || 256, height: data[at + 1]! || 256, bits: data.readUInt16LE(at + 6), size, offset });
  }
  return found;
}

/**
 * The pixels of a bitmap image inside an ICO (a DIB without the file header: its height counts the colour rows and the
 * transparency mask together). 1, 4, 8, 24 and 32 bits per pixel, uncompressed, which is all icons use. Returns RGBA.
 */
function decodeDib(dib: Buffer): { data: Buffer; width: number; height: number } {
  if (dib.length < 40) throw new Error("bitmap header too short");
  const headerSize = dib.readUInt32LE(0);
  const width = dib.readInt32LE(4);
  const doubled = dib.readInt32LE(8);
  const bits = dib.readUInt16LE(14);
  const compression = dib.readUInt32LE(16);
  const height = Math.abs(doubled) / 2;
  if (headerSize < 40 || width <= 0 || width > 1024 || height < 1 || height > 1024 || !Number.isInteger(height)) throw new Error("unsupported bitmap size");
  if (compression !== 0 && !(compression === 3 && bits === 32)) throw new Error("compressed bitmap");
  if (![1, 4, 8, 24, 32].includes(bits)) throw new Error("unsupported bit depth");

  const colours = bits <= 8 ? dib.readUInt32LE(32) || 1 << bits : 0;
  const paletteAt = headerSize;
  const rowBytes = Math.ceil((width * bits) / 32) * 4;
  const pixelsAt = paletteAt + colours * 4;
  const maskRowBytes = Math.ceil(width / 32) * 4;
  const maskAt = pixelsAt + rowBytes * height;
  if (pixelsAt + rowBytes * height > dib.length) throw new Error("bitmap data cut short");
  const hasMask = maskAt + maskRowBytes * height <= dib.length;

  const out = Buffer.alloc(width * height * 4);
  let anyAlpha = false;
  for (let y = 0; y < height; y += 1) {
    // Rows are stored bottom to top.
    const row = pixelsAt + (height - 1 - y) * rowBytes;
    for (let x = 0; x < width; x += 1) {
      let r: number, g: number, b: number, a = 255;
      if (bits === 32) {
        const p = row + x * 4;
        b = dib[p]!;
        g = dib[p + 1]!;
        r = dib[p + 2]!;
        a = dib[p + 3]!;
        if (a !== 0) anyAlpha = true;
      } else if (bits === 24) {
        const p = row + x * 3;
        b = dib[p]!;
        g = dib[p + 1]!;
        r = dib[p + 2]!;
      } else {
        const perByte = 8 / bits;
        const byte = dib[row + Math.floor(x / perByte)]!;
        const shift = 8 - bits * ((x % perByte) + 1);
        const index = (byte >> shift) & ((1 << bits) - 1);
        const p = paletteAt + Math.min(index, colours - 1) * 4;
        b = dib[p]!;
        g = dib[p + 1]!;
        r = dib[p + 2]!;
      }
      const o = (y * width + x) * 4;
      out[o] = r;
      out[o + 1] = g;
      out[o + 2] = b;
      out[o + 3] = a;
    }
  }
  // The mask says which pixels are clear (1) in everything but a 32 bit image that carries its own alpha.
  if (hasMask && !(bits === 32 && anyAlpha)) {
    for (let y = 0; y < height; y += 1) {
      const row = maskAt + (height - 1 - y) * maskRowBytes;
      for (let x = 0; x < width; x += 1) {
        const clear = (dib[row + (x >> 3)]! >> (7 - (x & 7))) & 1;
        out[(y * width + x) * 4 + 3] = clear ? 0 : 255;
      }
    }
  } else if (bits === 32 && !anyAlpha && !hasMask) {
    for (let i = 3; i < out.length; i += 4) out[i] = 255;
  }
  return { data: out, width, height };
}

/**
 * The biggest image an ICO holds, as a PNG. An ICO keeps each size as a PNG or as a bitmap; sharp reads neither the file nor the
 * bitmap, so the bitmap is decoded here. Throws when no image in it can be read.
 */
export async function icoToPng(data: Buffer): Promise<Buffer> {
  const all = entries(data).sort((a, b) => b.width * b.height - a.width * a.height || b.bits - a.bits);
  for (const entry of all) {
    const frame = data.subarray(entry.offset, entry.offset + entry.size);
    try {
      if (frame.subarray(0, 8).equals(PNG_MAGIC)) return Buffer.from(frame);
      const { data: rgba, width, height } = decodeDib(frame);
      return await sharp(rgba, { raw: { width, height, channels: 4 } }).png().toBuffer();
    } catch {
      // Try the next size.
    }
  }
  throw new Error("no readable image in the ICO");
}
