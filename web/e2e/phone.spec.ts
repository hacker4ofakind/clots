import { expect, test } from "@playwright/test";
import { clearAsks, expectNoSeriousViolations, openAsk } from "./helpers";

// These run in the "phone" project: a 412 by 915 touch device.

test.beforeEach(async ({ page }) => {
  await clearAsks(page);
});

test("the tab bar is on Clots and Waiting for you, and gone in a chat, which has a back button and no attach", async ({ page }) => {
  await page.goto("/clots");
  await expect(page.getByRole("navigation", { name: "Pages" })).toBeVisible();
  await page.goto("/waiting");
  await expect(page.getByRole("navigation", { name: "Pages" })).toBeVisible();
  await page.getByRole("link", { name: "Clots" }).first().click();
  await page.getByRole("link", { name: /Home/ }).first().click();
  await expect(page.getByLabel("Message Home")).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Pages" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Clots" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Attach an image" })).toBeHidden();
  await expect(page.getByRole("button", { name: "Info" })).toBeHidden();
});

test("a Waiting for you row shows only Block and Allow", async ({ page, request }) => {
  await page.goto("/waiting");
  await openAsk(request, { kind: "email", clot: "home" });
  const row = page.locator("[data-ask-row]").first();
  await expect(row).toBeVisible();
  await expect(row.getByRole("button", { name: "Don't send" })).toBeVisible();
  await expect(row.getByRole("button", { name: "Send", exact: true })).toBeVisible();
  await expect(row.getByRole("button", { name: "Open in chat" })).toBeHidden();
  await expect(row.getByRole("button", { name: "Edit" })).toBeHidden();
});

test("inputs are at least 16px so the page does not zoom, and the phone has no horizontal scroll", async ({ page }) => {
  await page.goto("/c/home");
  const size = await page.getByLabel("Message Home").evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  expect(size).toBeGreaterThanOrEqual(16);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  expect(overflow).toBe(false);
  await expectNoSeriousViolations(page);
});

test("the manifest names the app, lists icons and opens standalone", async ({ request }) => {
  const manifest = await (await request.get("/manifest.webmanifest")).json();
  expect(manifest).toMatchObject({ name: "Clots", display: "standalone" });
  expect(manifest.icons.map((i: { sizes: string }) => i.sizes)).toEqual(expect.arrayContaining(["192x192", "512x512"]));
});
