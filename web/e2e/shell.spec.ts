import { expect, test } from "@playwright/test";
import { clearAsks, control, gotoLive, openAsk } from "./helpers";

test.beforeEach(async ({ page }) => {
  await clearAsks(page);
});

test("Retry on a failed ask card sends the answer that was chosen, not Allow", async ({ page, request }) => {
  const before = (await control(request, "/sent")) as string[];
  await openAsk(request, { kind: "email", clot: "home", text: `Do not send me ${Date.now()}` });
  await gotoLive(page, "/c/home");
  const card = page.getByRole("region", { name: "Send an email from Home?" });
  await expect(card).toBeVisible();
  // The first answer never reaches the daemon.
  await page.route("**/api/d/asks/*/answer", (route) => route.abort());
  await card.getByRole("button", { name: "Don't send" }).click();
  await expect(card.getByRole("alert")).toContainText("Can't reach the Clots daemon.");
  await page.unroute("**/api/d/asks/*/answer");
  await card.getByRole("button", { name: "Retry" }).click();
  // It carried out Don't send: the ask is closed as dropped, and nothing was sent.
  await expect(page.locator("[data-ask-outcome]").last()).toContainText(/Dropped|not sent/i);
  expect(await control(request, "/sent")).toEqual(before);
});

test("a closed ask shows how it ended once: its card's line, not the daemon's note as well", async ({ page, request }) => {
  const words = 'Dropped, not sent: the email to jane@x.com, "Order 7" (tady)';
  await gotoLive(page, "/c/home");
  const lines = () => page.getByText(words, { exact: true });
  // Earlier asks of the same words are in this chat already: only the one added now is counted.
  await expect(page.locator("[data-chat-scroller]")).toBeVisible();
  // Lines from earlier tests may still be arriving: wait until the count has stopped changing.
  let before = await lines().count();
  for (let again = 0; again < 20; again++) {
    await page.waitForTimeout(300);
    const now = await lines().count();
    if (now === before) break;
    before = now;
  }
  await openAsk(request, { kind: "email", clot: "home", text: `Once only ${Date.now()}` });
  const card = page.getByRole("region", { name: "Send an email from Home?" });
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "Don't send" }).click();
  await expect(lines()).toHaveCount(before + 1);
  // The daemon posted its own note with the same words; the chat leaves it out. The same after a reload, when the chat is built from what the daemon kept.
  await page.reload();
  await expect(page.locator("[data-chat-scroller]")).toBeVisible();
  await expect(lines()).toHaveCount(before + 1);
  await expect(page.locator("[data-ask-outcome]").filter({ hasText: words })).toHaveCount(before + 1);
});

test("Enter on /sp runs /spend in one press; a command that needs an argument is completed instead", async ({ page }) => {
  await page.goto("/c/home");
  const box = page.getByLabel("Message Home");
  await box.fill("/sp");
  await box.press("Enter");
  await expect(box).toHaveValue("");
  // It was sent as /spend (a command that takes nothing), so the daemon did not answer that it does not know "/sp".
  const chat = page.locator("[data-chat-scroller]");
  await expect(chat).toContainText(/spend/i);
  await expect(chat.getByText("I don't know '/sp'")).toHaveCount(0);
  await box.fill("/eff");
  await box.press("Enter");
  await expect(box).toHaveValue("/effort ");
});

test("the Wide chat has the same space at its sides as above and below; Medium keeps its page padding", async ({ page }) => {
  await page.goto("/c/home");
  await page.evaluate(() => (document.documentElement.dataset.width = "wide"));
  const gutter = () => page.locator("[data-chat-scroller] > div").evaluate((el) => parseFloat(getComputedStyle(el).paddingLeft));
  await expect.poll(gutter).toBe(16);
  const bottom = await page.locator("[data-chat-scroller] > div").evaluate((el) => parseFloat(getComputedStyle(el).paddingBottom));
  expect(bottom).toBe(16);
  await page.evaluate(() => (document.documentElement.dataset.width = "medium"));
  await expect.poll(gutter).toBe(40);
  await page.evaluate(() => (document.documentElement.dataset.width = "wide"));
});

test("the active Clot's tile in the rail keeps its whole border (the rail's scroller does not clip it)", async ({ page }) => {
  await page.goto("/c/Truecast");
  const link = page.locator('[data-rail-clot="Truecast"] a');
  const scroller = link.locator("xpath=ancestor::*[contains(@class,'overflow-y-auto')][1]");
  const [a, b] = await Promise.all([link.boundingBox(), scroller.boundingBox()]);
  // A 1px ring needs a pixel of room on every side inside the element that clips.
  expect(a!.x - b!.x).toBeGreaterThanOrEqual(1);
  expect(b!.x + b!.width - (a!.x + a!.width)).toBeGreaterThanOrEqual(1);
  expect(a!.y - b!.y).toBeGreaterThanOrEqual(1);
});

test("a Waiting page title and an empty Waiting state follow the design's type", async ({ page }) => {
  await page.goto("/waiting");
  const h1 = page.getByRole("heading", { level: 1, name: "Waiting for you" });
  expect(await h1.evaluate((el) => getComputedStyle(el).lineHeight)).toBe("39px");
  const title = page.getByRole("heading", { level: 2, name: "Continue with your life!" });
  const style = await title.evaluate((el) => ({ size: getComputedStyle(el).fontSize, weight: getComputedStyle(el).fontWeight }));
  expect(style).toEqual({ size: "22px", weight: "700" });
});

test("an open page shows the banner and turns its composer off when the daemon goes away, and picks up again when it is back", async ({ page, request }) => {
  const BACK = `Back again, said after ${Date.now()}.`;
  await gotoLive(page, "/c/home");
  await control(request, "/stop");
  await expect(page.getByRole("alert").filter({ hasText: "Can't reach the Clots daemon. Retrying…" })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("button", { name: "Send" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Attach an image" })).toBeDisabled();
  await control(request, "/say", { clot: "home", text: "Said while the page was blind." }).catch(() => undefined);
  await control(request, "/start");
  await expect(page.getByRole("alert").filter({ hasText: "Can't reach the Clots daemon" })).toHaveCount(0, { timeout: 40_000 });
  await control(request, "/say", { clot: "home", text: BACK });
  await expect(page.locator('[data-message-kind="clot"]').filter({ hasText: BACK })).toHaveCount(1, { timeout: 15_000 });
});
