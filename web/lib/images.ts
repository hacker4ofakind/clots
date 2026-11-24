/** Longest side, in pixels, an image keeps before it is sent: a phone's screenshot is far larger than a Clot needs. */
export const MAX_SIDE = 2048;

/** Largest file that goes as it is when it is already small enough in pixels. Anything bigger is encoded again. */
const KEEP_BYTES = 3 * 1024 * 1024;

/** The formats the daemon stores. Anything else (HEIC from a phone, say) is always encoded again as a JPEG. */
const STORED_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

/** The size an image of `width` by `height` takes when its longest side may be at most `max`. Never makes it bigger. */
export function fitWithin(width: number, height: number, max: number = MAX_SIDE): { width: number; height: number; scaled: boolean } {
  const longest = Math.max(width, height);
  if (longest <= max) return { width, height, scaled: false };
  const scale = max / longest;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)), scaled: true };
}

/** Whether a picture can go to the daemon without being encoded again. */
export function canKeep(file: { type: string; size: number }, width: number, height: number): boolean {
  return STORED_TYPES.has(file.type) && file.size <= KEEP_BYTES && !fitWithin(width, height).scaled;
}

const read = (file: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });

/**
 * A picture ready to send, as a data URL: shrunk to at most MAX_SIDE on its longest side and encoded as a JPEG when it was
 * larger than that, larger than 3 MB, or in a format the daemon does not store. Small pictures pass untouched. Rejects when the
 * browser cannot read the picture, so the caller can say so.
 */
export async function prepareImage(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file).catch(() => undefined);
  if (!bitmap) {
    if (STORED_TYPES.has(file.type) && file.size <= KEEP_BYTES) return read(file);
    throw new Error("The browser cannot read this picture");
  }
  try {
    if (canKeep(file, bitmap.width, bitmap.height)) return await read(file);
    const size = fitWithin(bitmap.width, bitmap.height);
    const canvas = document.createElement("canvas");
    canvas.width = size.width;
    canvas.height = size.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("The browser cannot shrink this picture");
    // A JPEG has no transparency: a PNG's clear parts would turn black.
    context.fillStyle = "#fff";
    context.fillRect(0, 0, size.width, size.height);
    context.drawImage(bitmap, 0, 0, size.width, size.height);
    return canvas.toDataURL("image/jpeg", 0.85);
  } finally {
    bitmap.close();
  }
}
