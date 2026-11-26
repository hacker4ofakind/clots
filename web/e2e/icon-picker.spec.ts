import { expect, test, type Page } from "@playwright/test";
import { expectNoSeriousViolations } from "./helpers";

// The icon picker in New Clot against the fake daemon's real icon store: the curated grid, a dialog that never changes size while
// searching, and uploads of every format (SVG, PNG, JPEG, WebP, ICO) and pastes, with plain words for what cannot be used.

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" fill="#2255dd"/><circle cx="12" cy="12" r="6" fill="#fff"/></svg>';

const open = async (page: Page) => {
  await page.goto("/new");
  await page.getByRole("button", { name: "Pick an icon" }).click();
  const dialog = page.getByRole("dialog", { name: "Pick an icon" });
  await expect(dialog.getByLabel("Search icons")).toBeVisible();
  return dialog;
};

/** A real PNG, made by the browser. */
const png = (page: Page, type = "image/png") =>
  page.evaluate(async (mime) => {
    const c = document.createElement("canvas");
    c.width = c.height = 48;
    const x = c.getContext("2d")!;
    x.fillStyle = "#d22";
    x.fillRect(0, 0, 48, 48);
    x.fillStyle = "#fff";
    x.fillRect(12, 12, 24, 24);
    const blob = await new Promise<Blob>((r) => c.toBlob((b) => r(b!), mime));
    return [...new Uint8Array(await blob.arrayBuffer())];
  }, type);

/** An ICO that holds one PNG frame. */
const ico = (bytes: number[]) => {
  const head = Buffer.alloc(22);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(1, 4);
  head[6] = 48;
  head[7] = 48;
  head.writeUInt16LE(1, 10);
  head.writeUInt16LE(32, 12);
  head.writeUInt32LE(bytes.length, 14);
  head.writeUInt32LE(22, 18);
  return Buffer.concat([head, Buffer.from(bytes)]);
};

test("it opens on the curated grid, red chosen, the first icon ringed, and has no serious accessibility violations", async ({ page }) => {
  const dialog = await open(page);
  await expect(dialog.getByRole("radio", { name: "Rose" })).toHaveAttribute("data-state", "on");
  const icons = dialog.getByRole("radiogroup", { name: "Icons" }).getByRole("radio");
  await expect(icons).toHaveCount(24);
  await expect(icons.first()).toHaveAttribute("aria-label", "sliders");
  await expect(icons.first()).toHaveAttribute("data-state", "on");
  await expect(dialog.getByLabel("Search icons")).toHaveAttribute("placeholder", /^Search 1,\d{3} icons$/);
  await expect(dialog.getByText("SVG, PNG, JPG, WebP or ICO. You can also paste one.")).toBeVisible();
  await expectNoSeriousViolations(page);
});

test("the dialog keeps its size and its footer in place while the results change", async ({ page }) => {
  const dialog = await open(page);
  const upload = dialog.getByRole("button", { name: "Upload" });
  const measure = async () => ({ box: await dialog.boundingBox(), upload: await upload.boundingBox() });
  const first = await measure();
  for (const query of ["lock", "zzzzzz", "a", ""]) {
    await dialog.getByLabel("Search icons").fill(query);
    const now = await measure();
    expect(now.box!.width).toBe(first.box!.width);
    expect(now.box!.height).toBe(first.box!.height);
    expect(now.upload!.y).toBe(first.upload!.y);
  }
  await dialog.getByLabel("Search icons").fill("zzzzzz");
  await expect(dialog.getByText("No icon is called that")).toBeVisible();
});

test("an SVG, a PNG, a JPEG, a WebP and an ICO each become the Clot's icon, whatever the browser says their type is", async ({ page }) => {
  for (const file of [
    { name: "logo.svg", mimeType: "image/svg+xml", buffer: Buffer.from(SVG) },
    { name: "logo.SVG", mimeType: "", buffer: Buffer.from(SVG) },
    { name: "a.png", mimeType: "image/png", buffer: Buffer.from(await png(page)) },
    { name: "a.jpg", mimeType: "image/jpeg", buffer: Buffer.from(await png(page, "image/jpeg")) },
    { name: "a.webp", mimeType: "image/webp", buffer: Buffer.from(await png(page, "image/webp")) },
    { name: "favicon.ico", mimeType: "image/x-icon", buffer: ico(await png(page)) },
  ]) {
    const dialog = await open(page);
    await dialog.getByLabel("Icon file").setInputFiles(file);
    await expect(dialog).toBeHidden();
    await expect(page.getByRole("button", { name: "Pick an icon" }).locator("img")).toHaveAttribute("src", /\/api\/d\/clots\/icons\/[a-f0-9]{16}$/);
    // The stored icon is served as a PNG.
    const src = await page.getByRole("button", { name: "Pick an icon" }).locator("img").getAttribute("src");
    const res = await page.request.get(src!);
    expect(res.headers()["content-type"]).toBe("image/png");
  }
});

test("a file that is not an image, and one that is too big, say so in plain words and leave the icon alone", async ({ page }) => {
  const dialog = await open(page);
  await dialog.getByLabel("Icon file").setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("just some words in a file") });
  await expect(dialog.getByRole("alert")).toHaveText("That file couldn't be read as an image. Try another one.");
  await dialog.getByLabel("Icon file").setInputFiles({ name: "big.png", mimeType: "image/png", buffer: Buffer.alloc(3 * 1024 * 1024, 1) });
  await expect(dialog.getByRole("alert")).toHaveText("That image is too large. An icon can be up to 2 MB.");
  await expect(dialog.getByRole("radio", { name: "sliders" })).toHaveAttribute("data-state", "on");
  await expect(dialog.getByRole("alert")).not.toContainText(/invalid|failed with|error/i);
});

test("a pasted image becomes the icon, a pasted file that is not an image says what is accepted, and pasted text goes to the search box", async ({ page }) => {
  const paste = (dialogPage: Page, make: () => DataTransfer) => dialogPage.getByLabel("Search icons").evaluate((el, makeSource) => {
    const dt = new Function(`return (${makeSource})()`)() as DataTransfer;
    const event = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
    el.dispatchEvent(event);
    return event.defaultPrevented;
  }, make.toString());

  let dialog = await open(page);
  const prevented = await paste(page, () => {
    const dt = new DataTransfer();
    dt.items.add(new File(["%PDF-1.4"], "a.pdf", { type: "application/pdf" }));
    return dt;
  });
  expect(prevented).toBe(true);
  await expect(dialog.getByRole("alert")).toHaveText("Paste an image, or upload an SVG, PNG, JPG, WebP or ICO.");

  const text = await paste(page, () => {
    const dt = new DataTransfer();
    dt.setData("text/plain", "lock");
    return dt;
  });
  expect(text).toBe(false);

  await paste(page, () => {
    const c = document.createElement("canvas");
    c.width = c.height = 16;
    c.getContext("2d")!.fillRect(0, 0, 16, 16);
    const dt = new DataTransfer();
    const bytes = Uint8Array.from(atob(c.toDataURL("image/png").split(",")[1]!), (ch) => ch.charCodeAt(0));
    dt.items.add(new File([bytes], "shot.png", { type: "image/png" }));
    return dt;
  });
  dialog = page.getByRole("dialog", { name: "Pick an icon" });
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("button", { name: "Pick an icon" }).locator("img")).toBeVisible();
});
