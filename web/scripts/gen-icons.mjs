// Draws the PNG icons the installed app needs from the logo mark (public/icons/mark.svg): the home-screen icon on the
// background colour, and the sizes the manifest lists.
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";

const dir = path.join(import.meta.dirname, "../public/icons");
const svg = fs.readFileSync(path.join(dir, "mark.svg"));
const background = { r: 250, g: 246, b: 246, alpha: 1 };

async function icon(size, file, padding = 0.16) {
  const inner = Math.round(size * (1 - padding * 2));
  const mark = await sharp(svg, { density: 384 }).resize(inner, inner).png().toBuffer();
  await sharp({ create: { width: size, height: size, channels: 4, background } })
    .composite([{ input: mark, gravity: "center" }])
    .png()
    .toFile(path.join(dir, file));
}

await icon(180, "apple-touch-icon.png");
await icon(192, "icon-192.png");
await icon(512, "icon-512.png");
await icon(512, "icon-maskable-512.png", 0.26);
console.log("icons written");
