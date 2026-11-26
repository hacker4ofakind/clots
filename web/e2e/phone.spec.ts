import { expect, test, type Page } from "@playwright/test";
import { clearAsks, control, expectNoSeriousViolations, openAsk } from "./helpers";

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

test("the Clots list gives every Clot an icon (the same default as the rail) and shows a reply's start as plain words", async ({ page, request }) => {
  await control(request, "/say", { clot: "Truecast", text: "Fixed [#71](https://github.com/octo/truecast/pull/71) with **care**, see `npm test`" });
  await page.goto("/clots");
  const row = page.getByRole("link", { name: /Truecast/ });
  await expect(row).toContainText("Fixed #71 with care, see npm test");
  await expect(row).not.toContainText("](");
  // No row has an empty tile: Truecast and Encryptify were made without an icon, Home keeps its house.
  const rows = page.getByRole("region", { name: "Clots" }).locator("li");
  await expect(rows.first()).toBeVisible();
  for (const li of await rows.all()) await expect(li.locator("a > span").first().locator("svg, img")).toHaveCount(1);
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

/** A finger that goes down at (fromX, y), moves to (toX, y) in a few steps and lifts. Real touch events, through the browser's own input. */
async function swipe(page: Page, fromX: number, toX: number, y: number): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: fromX, y }] });
  for (let i = 1; i <= 5; i++) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: fromX + ((toX - fromX) * i) / 5, y }] });
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();
}

test("a swipe right from the left edge of a chat goes back to the Clots list; one that starts away from the edge does not", async ({ page }) => {
  await page.goto("/c/Truecast");
  await expect(page.getByLabel("Message Truecast")).toBeVisible();
  await swipe(page, 120, 300, 400);
  await page.waitForTimeout(400);
  await expect(page).toHaveURL(/\/c\/Truecast$/);
  await swipe(page, 4, 40, 400);
  await page.waitForTimeout(400);
  await expect(page).toHaveURL(/\/c\/Truecast$/);
  await swipe(page, 4, 200, 400);
  await expect(page).toHaveURL(/\/clots$/);
  await expect(page.getByRole("heading", { name: "Clots" })).toBeVisible();
});

test("the composer stays above the keyboard and the tab bar hides while it is open", async ({ page }) => {
  // The visual viewport shrinks when the keyboard opens; the test makes it do so.
  const keyboard = (height: number | null) =>
    page.evaluate((h) => {
      const vv = window.visualViewport!;
      if (h === null) delete (vv as unknown as { height?: number }).height;
      else Object.defineProperty(vv, "height", { configurable: true, get: () => h });
      vv.dispatchEvent(new Event("resize"));
    }, height);

  await page.goto("/clots");
  const bar = page.getByRole("navigation", { name: "Pages" });
  await expect(bar).toBeVisible();
  await page.goto("/waiting");
  await expect(bar).toBeVisible();
  await keyboard(520);
  await expect(bar).toHaveCount(0);
  await keyboard(null);
  await expect(bar).toBeVisible();

  await page.goto("/c/Truecast");
  const box = page.getByLabel("Message Truecast");
  await expect(box).toBeVisible();
  const full = page.viewportSize()!.height;
  expect((await box.boundingBox())!.y + (await box.boundingBox())!.height).toBeGreaterThan(full - 120);
  await keyboard(520);
  await expect(page.locator("[data-keyboard=open]")).toHaveCount(1);
  await expect.poll(async () => (await box.boundingBox())!.y + (await box.boundingBox())!.height).toBeLessThanOrEqual(520);
  await keyboard(null);
  await expect(page.locator("[data-keyboard=open]")).toHaveCount(0);
  await expect.poll(async () => (await box.boundingBox())!.y + (await box.boundingBox())!.height).toBeGreaterThan(full - 120);
});

test("the pages fill the window exactly: nothing scrolls the page itself", async ({ page }) => {
  for (const path of ["/clots", "/waiting", "/c/Truecast"]) {
    await page.goto(path);
    await expect(page.getByRole("main")).toBeVisible();
    const scrolls = await page.evaluate(() => document.documentElement.scrollHeight > window.innerHeight + 1);
    expect(scrolls, path).toBe(false);
  }
});

test("the notification row asks to turn on, says how to fix a block, and offers a test once on", async ({ page }) => {
  await page.goto("/waiting");
  await expect(page.locator("[data-notifications=ask]")).toContainText("Get a notification when a Clot needs you");
  await expect(page.locator("[data-notifications=ask]").getByRole("button")).toHaveCount(1);
  await expect(page.locator("[data-notifications=ask]").getByRole("button", { name: "Turn on" })).toBeVisible();
  await page.goto("/clots");
  await expect(page.locator("[data-notifications]")).toHaveCount(0);

  const denied = await page.context().newPage();
  await denied.addInitScript(() => Object.defineProperty(Notification, "permission", { get: () => "denied" }));
  await denied.goto("/waiting");
  await expect(denied.locator("[data-notifications=denied]")).toContainText("blocked");
  await expect(denied.locator("[data-notifications=denied]")).toContainText("Settings");
  await denied.close();

  const on = await page.context().newPage();
  await on.addInitScript(() => {
    Object.defineProperty(Notification, "permission", { get: () => "granted" });
    Object.defineProperty(navigator.serviceWorker, "ready", { get: () => Promise.resolve({ pushManager: { getSubscription: async () => ({ endpoint: "https://fcm.googleapis.com/x" }) } }) });
  });
  await on.goto("/waiting");
  await expect(on.locator("[data-notifications=on]")).toContainText("Notifications are on");
  await on.locator("[data-notifications=on]").getByRole("button", { name: "Send a test notification" }).click();
  await expect(on.getByText(/test notification|No device is subscribed/).last()).toBeVisible();
  await on.close();
});

for (const scheme of ["light", "dark"] as const) {
  test(`the phone's Clots list, Waiting and chat have no serious accessibility violations (${scheme})`, async ({ page, request }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await openAsk(request, { kind: "email", clot: "home" });
    for (const path of ["/clots", "/waiting", "/c/home"]) {
      await page.goto(path);
      await expect(page.getByRole("main")).toBeVisible();
      await expectNoSeriousViolations(page);
    }
  });
}
