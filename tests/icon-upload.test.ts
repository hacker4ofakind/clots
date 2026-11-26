import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type net from "node:net";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { icoToPng, looksLikeIco } from "../src/onboarding/ico.js";
import { bytesOfDataUrl, IconError, IconStore, processIcon, sanitiseSvg, sniff } from "../src/onboarding/icons.js";
import { EventBus } from "../src/ui-api/events.js";
import { registerClotAdminRoutes } from "../src/ui-api/routes/clots-admin.js";
import { UiApi } from "../src/ui-api/server.js";

const svgText = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 40 40"><rect width="40" height="40" fill="#e11"/><circle cx="20" cy="20" r="8" fill="#fff"/></svg>';
const pixelAt = async (buf: Buffer, x: number, y: number) => {
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const i = (y * info.width + x) * 4;
  return [data[i]!, data[i + 1]!, data[i + 2]!, data[i + 3]!];
};

/** A bitmap frame as an ICO keeps it: BITMAPINFOHEADER with a doubled height, palette, colour rows bottom to top, then the 1 bit mask. */
function dib(opts: { width: number; height: number; bits: 1 | 4 | 8 | 24 | 32; palette?: [number, number, number][]; pixel: (x: number, y: number) => number | [number, number, number] | [number, number, number, number]; clear?: (x: number, y: number) => boolean }): Buffer {
  const { width, height, bits } = opts;
  const rowBytes = Math.ceil((width * bits) / 32) * 4;
  const maskRow = Math.ceil(width / 32) * 4;
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(width, 4);
  header.writeInt32LE(height * 2, 8);
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(bits, 14);
  const palette = Buffer.alloc((opts.palette?.length ?? 0) * 4);
  opts.palette?.forEach(([r, g, b], i) => palette.set([b, g, r, 0], i * 4));
  const colour = Buffer.alloc(rowBytes * height);
  const mask = Buffer.alloc(maskRow * height);
  for (let y = 0; y < height; y++) {
    const row = (height - 1 - y) * rowBytes;
    for (let x = 0; x < width; x++) {
      const v = opts.pixel(x, y);
      if (bits === 32) colour.set(Array.isArray(v) ? [v[2], v[1], v[0], v[3] ?? 255] : [0, 0, 0, 0], row + x * 4);
      else if (bits === 24) colour.set(Array.isArray(v) ? [v[2], v[1], v[0]] : [0, 0, 0], row + x * 3);
      else {
        const perByte = 8 / bits;
        colour[row + Math.floor(x / perByte)]! |= (v as number) << (8 - bits * ((x % perByte) + 1));
      }
      if (opts.clear?.(x, y)) mask[(height - 1 - y) * maskRow + (x >> 3)]! |= 0x80 >> (x & 7);
    }
  }
  return Buffer.concat([header, palette, colour, mask]);
}

/** An ICO file holding the given frames, each given as its own bytes and the size its directory entry names. */
function ico(frames: { size: number; bits?: number; data: Buffer }[]): Buffer {
  const head = Buffer.alloc(6 + frames.length * 16);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(frames.length, 4);
  let offset = head.length;
  frames.forEach((f, i) => {
    const at = 6 + i * 16;
    head[at] = f.size >= 256 ? 0 : f.size;
    head[at + 1] = f.size >= 256 ? 0 : f.size;
    head.writeUInt16LE(1, at + 4);
    head.writeUInt16LE(f.bits ?? 32, at + 6);
    head.writeUInt32LE(f.data.length, at + 8);
    head.writeUInt32LE(offset, at + 12);
    offset += f.data.length;
  });
  return Buffer.concat([head, ...frames.map((f) => f.data)]);
}

const solidPng = (size: number, rgb: [number, number, number]) => sharp({ create: { width: size, height: size, channels: 3, background: { r: rgb[0], g: rgb[1], b: rgb[2] } } }).png().toBuffer();

describe("SVG icons", () => {
  it("draws an SVG the browser sent as a base64 data URL (what a file read gives)", async () => {
    const dataUrl = `data:image/svg+xml;base64,${Buffer.from(svgText).toString("base64")}`;
    const bytes = bytesOfDataUrl(dataUrl);
    expect(sniff(bytes)).toBe("svg");
    const icon = await processIcon(bytes);
    expect(sniff(icon.normal)).toBe("png");
    expect((await pixelAt(icon.normal, 10, 128)).slice(0, 3)).toEqual([238, 17, 17]);
  });

  it("also reads percent encoded SVG text, and an SVG with an XML declaration, comments or a byte order mark", async () => {
    expect(bytesOfDataUrl(`data:image/svg+xml,${encodeURIComponent(svgText)}`).toString()).toBe(svgText);
    for (const text of [`<?xml version="1.0" encoding="UTF-8"?>\n${svgText}`, `<!-- made by hand -->\n${svgText}`, `﻿${svgText}`]) {
      const bytes = Buffer.from(text, "utf8");
      expect(sniff(bytes)).toBe("svg");
      expect((await processIcon(bytes)).normal.length).toBeGreaterThan(0);
    }
  });

  it("draws a tiny and a huge SVG at the icon size without running out of memory", async () => {
    for (const size of ["8", "100000"]) {
      const icon = await processIcon(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 10 10"><rect width="10" height="10" fill="#1a1"/></svg>`));
      const meta = await sharp(icon.normal).metadata();
      expect([meta.width, meta.height]).toEqual([256, 256]);
    }
  });

  it("removes scripts, handlers, outside references and style imports, and refuses entity tricks", () => {
    const dirty = `<?xml version="1.0"?><!DOCTYPE svg><svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" onload="x()"><script>alert(1)</script><foreignObject><div>hi</div></foreignObject><style>@import url(http://evil.test/a.css); .a{fill:url(http://evil.test/p)} .b{fill:url(#grad)}</style><image href="http://evil.test/p.png"/><image xlink:href="file:///etc/passwd"/><image href="data:image/png;base64,AAAA"/><use xlink:href="#a" onclick='y()'/><rect/></svg>`;
    const clean = sanitiseSvg(dirty);
    expect(clean).not.toMatch(/script|foreignObject|onload|onclick|evil\.test|file:|@import/i);
    expect(clean).toContain('href="data:image/png;base64,AAAA"');
    expect(clean).toContain('xlink:href="#a"');
    expect(clean).toContain("url(#grad)");
    expect(() => sanitiseSvg('<!DOCTYPE svg [<!ENTITY a "aaaa">]><svg>&a;</svg>')).toThrow(IconError);
  });

  it("stores a PNG with none of the markup, even for an SVG that points outside itself", async () => {
    const icon = await processIcon(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="20" height="20"><image xlink:href="file:///etc/passwd" width="20" height="20"/><rect width="20" height="20" fill="#e11" onload="x()"/><script>1</script></svg>`));
    expect(sniff(icon.normal)).toBe("png");
    expect(icon.normal.toString("latin1")).not.toMatch(/script|passwd|onload/);
  });
});

describe("ICO icons", () => {
  it("takes the biggest PNG frame", async () => {
    const file = ico([
      { size: 16, data: await solidPng(16, [0, 0, 255]) },
      { size: 48, data: await solidPng(48, [255, 0, 0]) },
    ]);
    expect(looksLikeIco(file)).toBe(true);
    expect(sniff(file)).toBe("ico");
    const frame = await icoToPng(file);
    expect((await sharp(frame).metadata()).width).toBe(48);
    const icon = await processIcon(file);
    expect((await pixelAt(icon.normal, 128, 128)).slice(0, 3)).toEqual([255, 0, 0]);
  });

  it("decodes a 32 bit bitmap frame with its own alpha", async () => {
    const frame = dib({ width: 4, height: 4, bits: 32, pixel: (x) => (x < 2 ? [10, 200, 30, 255] : [200, 10, 30, 0]) });
    const png = await icoToPng(ico([{ size: 4, data: frame }]));
    expect(await pixelAt(png, 0, 3)).toEqual([10, 200, 30, 255]);
    expect((await pixelAt(png, 3, 0))[3]).toBe(0);
  });

  it("decodes a 24 bit frame and uses the mask for transparency", async () => {
    const frame = dib({ width: 8, height: 2, bits: 24, pixel: () => [90, 20, 160], clear: (x) => x >= 4 });
    const png = await icoToPng(ico([{ size: 8, bits: 24, data: frame }]));
    expect(await pixelAt(png, 1, 0)).toEqual([90, 20, 160, 255]);
    expect((await pixelAt(png, 6, 1))[3]).toBe(0);
  });

  it("decodes 8, 4 and 1 bit frames through their palettes", async () => {
    const palette: [number, number, number][] = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [9, 9, 9], [10, 10, 10], [11, 11, 11], [12, 12, 12], [13, 13, 13], [14, 14, 14], [15, 15, 15], [16, 16, 16], [17, 17, 17], [18, 18, 18], [19, 19, 19], [20, 20, 20], [21, 21, 21]];
    const four = await icoToPng(ico([{ size: 8, bits: 4, data: dib({ width: 8, height: 1, bits: 4, palette, pixel: (x) => x % 3 }) }]));
    expect((await pixelAt(four, 1, 0)).slice(0, 3)).toEqual([0, 255, 0]);
    expect((await pixelAt(four, 2, 0)).slice(0, 3)).toEqual([0, 0, 255]);
    const eight = await icoToPng(ico([{ size: 3, bits: 8, data: dib({ width: 3, height: 1, bits: 8, palette: [...palette, ...Array.from({ length: 240 }, () => [0, 0, 0] as [number, number, number])], pixel: (x) => x }) }]));
    expect((await pixelAt(eight, 2, 0)).slice(0, 3)).toEqual([0, 0, 255]);
    const one = await icoToPng(ico([{ size: 8, bits: 1, data: dib({ width: 8, height: 1, bits: 1, palette: [[0, 0, 0], [255, 255, 255]], pixel: (x) => x % 2 }) }]));
    expect((await pixelAt(one, 1, 0)).slice(0, 3)).toEqual([255, 255, 255]);
    expect((await pixelAt(one, 0, 0)).slice(0, 3)).toEqual([0, 0, 0]);
  });

  it("goes on to the next size when the biggest cannot be read, and refuses a file with none", async () => {
    const good = await solidPng(16, [1, 2, 3]);
    const file = ico([
      { size: 64, data: Buffer.from("not a bitmap at all, not a PNG either, just junk bytes here") },
      { size: 16, data: good },
    ]);
    expect((await sharp(await icoToPng(file)).metadata()).width).toBe(16);
    await expect(processIcon(ico([{ size: 64, data: Buffer.from("junk junk junk junk junk junk junk junk junk junk junk junk") }]))).rejects.toThrow(/isn't an image Clots can use/);
  });

  it("does not take a cursor or a file whose directory points past its end", async () => {
    const cursor = ico([{ size: 16, data: await solidPng(16, [1, 2, 3]) }]);
    cursor.writeUInt16LE(2, 2);
    expect(looksLikeIco(cursor)).toBe(false);
    const cut = ico([{ size: 16, data: await solidPng(16, [1, 2, 3]) }]).subarray(0, 40);
    await expect(processIcon(cut)).rejects.toThrow(IconError);
  });
});

describe("other uploads, by their own bytes", () => {
  it("reads PNG, JPEG and WebP whatever they are called", async () => {
    const raw = { create: { width: 30, height: 20, channels: 3 as const, background: { r: 20, g: 120, b: 220 } } };
    for (const make of [() => sharp(raw).png().toBuffer(), () => sharp(raw).jpeg().toBuffer(), () => sharp(raw).webp().toBuffer()]) {
      const icon = await processIcon(await make());
      expect((await sharp(icon.normal).metadata()).width).toBe(256);
    }
  });

  it("says plainly what is wrong with a file that is not an image, a data URL that is not one, and one that is too big", async () => {
    await expect(processIcon(Buffer.from("just some text"))).rejects.toThrow("That file isn't an image Clots can use. Use an SVG, PNG, JPG, WebP or ICO.");
    expect(() => bytesOfDataUrl("not a data url")).toThrow(IconError);
    expect(() => bytesOfDataUrl("data:image/svg+xml,%E0%A4%A")).toThrow(IconError);
    await expect(processIcon(Buffer.alloc(3 * 1024 * 1024))).rejects.toThrow("That image is too large. An icon can be up to 2 MB.");
  });
});

describe("the upload route", () => {
  let api: UiApi;
  let post: (dataUrl: string) => Promise<Response>;
  let icons: IconStore;
  beforeEach(async () => {
    icons = new IconStore(fs.mkdtempSync(path.join(os.tmpdir(), "clots-icon-route-")));
    api = new UiApi({ secret: () => "s", bus: new EventBus("b") });
    registerClotAdminRoutes(api, { creator: {} as never, icons, config: {} as never, webhookSecret: () => "w", onboarding: () => [] });
    const server = await api.listen(0);
    const port = (server.address() as net.AddressInfo).port;
    post = (dataUrl) => fetch(`http://127.0.0.1:${port}/api/v1/clots/icons`, { method: "POST", headers: { "x-clots-ui-secret": "s", "content-type": "application/json" }, body: JSON.stringify({ dataUrl }) });
  });
  afterEach(() => api.close());

  it("stores an SVG, a PNG and an ICO sent the way the browser sends them, and serves both variants as PNG", async () => {
    const files = [`data:image/svg+xml;base64,${Buffer.from(svgText).toString("base64")}`, `data:image/png;base64,${(await solidPng(32, [9, 9, 200])).toString("base64")}`, `data:image/x-icon;base64,${ico([{ size: 16, data: await solidPng(16, [200, 9, 9]) }]).toString("base64")}`, `data:application/octet-stream;base64,${(await solidPng(32, [9, 200, 9])).toString("base64")}`];
    for (const file of files) {
      const res = await post(file);
      expect(res.status).toBe(201);
      const { iconId } = (await res.json()) as { iconId: string };
      expect(sniff(icons.read(iconId, false)!)).toBe("png");
      expect(sniff(icons.read(iconId, true)!)).toBe("png");
    }
  });

  it("answers a file that is not an image with a plain sentence", async () => {
    const res = await post(`data:text/plain;base64,${Buffer.from("hello there, this is text").toString("base64")}`);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "That file isn't an image Clots can use. Use an SVG, PNG, JPG, WebP or ICO." });
  });
});
