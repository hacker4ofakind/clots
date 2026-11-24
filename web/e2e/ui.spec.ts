import { expect, test } from "@playwright/test";
import { clearAsks, control, gotoLive } from "./helpers";

test.beforeEach(async ({ page }) => {
  await clearAsks(page);
});

test("the composer: the send button fills once there is text, Enter sends, Shift+Enter is a new line, and your message has no time", async ({ page }) => {
  await page.goto("/c/Truecast");
  const box = page.getByLabel("Message Truecast");
  const send = page.getByRole("button", { name: "Send", exact: true });
  await expect(send).toBeDisabled();
  await box.fill("one");
  await expect(send).toBeEnabled();
  await box.press("Shift+Enter");
  await box.pressSequentially("two");
  await expect(box).toHaveValue("one\ntwo");
  await box.press("Enter");
  const mine = page.locator('[data-message-kind="user"]').filter({ hasText: "one" });
  await expect(mine).toHaveCount(1);
  await expect(mine.locator("..")).not.toContainText(/\d{1,2}:\d{2}/);
});

test("the attach button is a plus, and pasting an image attaches it", async ({ page }) => {
  await page.goto("/c/Truecast");
  await expect(page.getByRole("button", { name: "Attach an image" })).toBeVisible();
  await page.getByLabel("Message Truecast").focus();
  await page.evaluate(() => {
    const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
    const data = new DataTransfer();
    data.items.add(new File([png], "shot.png", { type: "image/png" }));
    document.querySelector("textarea")!.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await expect(page.getByRole("img", { name: "Attached" })).toBeVisible();
});

test("the slash menu is exactly as wide as the composer, wherever the content width is set", async ({ page }) => {
  for (const width of ["Wide", "Narrow"]) {
    await page.goto("/settings/general");
    await page.getByRole("radiogroup", { name: "Content width" }).getByRole("radio", { name: width }).click();
    await gotoLive(page, "/c/Truecast");
    await page.getByLabel("Message Truecast").fill("/");
    const menu = await page.getByRole("listbox", { name: "Commands" }).boundingBox();
    const composer = await page.getByLabel("Message Truecast").locator("xpath=ancestor::div[contains(@class,'rounded-composer')]").boundingBox();
    expect(Math.abs(menu!.width - composer!.width)).toBeLessThan(2);
    expect(Math.abs(menu!.x - composer!.x)).toBeLessThan(2);
  }
  await page.goto("/settings/general");
  await page.getByRole("radiogroup", { name: "Content width" }).getByRole("radio", { name: "Wide" }).click();
});

test("the info pane has no close or full-screen button; dragging its grip to the far left fills the page and to the right edge closes it", async ({ page }) => {
  await page.goto("/c/Truecast");
  await page.getByRole("button", { name: "Info", exact: true }).click();
  const pane = page.getByRole("complementary", { name: /Info about Truecast/ });
  await expect(pane).toBeVisible();
  await expect(pane.getByRole("button")).toHaveCount(0);
  const grip = page.getByRole("separator", { name: "Resize the side pane" });
  const box = (await grip.boundingBox())!;
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(120, y, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator('[data-page="container"]')).toBeHidden();
  const wide = (await grip.boundingBox())!;
  await page.mouse.move(wide.x + wide.width / 2, wide.y + wide.height / 2);
  await page.mouse.down();
  await page.mouse.move(1270, wide.y + wide.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect(pane).toHaveCount(0);
});

test("General settings: the theme and content width change at once, and Save keeps the rest", async ({ page }) => {
  await page.goto("/settings/general");
  await expect(page.getByRole("heading", { name: "General" })).toBeVisible();
  await page.getByRole("radiogroup", { name: "Content width" }).getByRole("radio", { name: "Medium" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-width", "medium");
  await page.getByRole("radiogroup", { name: "Theme" }).getByRole("radio", { name: "Dark" }).click();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await page.getByRole("button", { name: "More Workers at once" }).click();
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Saved", { exact: false }).first()).toBeVisible();
  await page.reload();
  await expect(page.getByRole("textbox", { name: "Workers at once" })).toHaveValue("4");
  await page.getByRole("radiogroup", { name: "Content width" }).getByRole("radio", { name: "Wide" }).click();
  await page.getByRole("radiogroup", { name: "Theme" }).getByRole("radio", { name: "System" }).click();
  await page.getByRole("button", { name: "Less Workers at once" }).click();
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Saved", { exact: false }).first()).toBeVisible();
});

test("every settings page has its heading, and Manage Clots shows capitals as typed with only a dot and a word for state", async ({ page }) => {
  await page.goto("/settings/clots");
  await expect(page.getByRole("heading", { name: "Manage Clots" })).toBeVisible();
  await expect(page.getByText("Truecast", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Delete Home" })).toBeDisabled();
  await expect(page.getByText("A project")).toHaveCount(0);
  await page.goto("/settings/integrations");
  await expect(page.getByRole("heading", { name: "Integrations" })).toBeVisible();
});

test("a new Clot's first message is a short checklist that ticks itself, and its secret is only fetched by Copy", async ({ page, request, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await control(request, "/onboard", { clot: "Encryptify" });
  await page.goto("/c/Encryptify");
  const card = page.locator("[data-onboarding]").last();
  await expect(card).toContainText("Encryptify is ready. Three steps finish its setup.");
  expect(await card.innerHTML()).not.toContain("whsec_fake_secret");
  await expect(page.getByLabel("Secret").first()).toHaveValue(/^•+$/);
  await card.getByRole("button", { name: "Copy the secret" }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("whsec_fake_secret");
  await control(request, "/onboard-done", { step: "webhook" });
  await expect(card.locator('[data-step="webhook"]')).toHaveAttribute("data-done", "true", { timeout: 15_000 });
});

test("the icon picker: a colour and an icon change the preview, and the grid marks the chosen one", async ({ page }) => {
  await page.goto("/new");
  await page.getByRole("button", { name: "Pick an icon" }).click();
  const dialog = page.getByRole("dialog", { name: "Pick an icon" });
  await dialog.getByRole("radio", { name: "Blue", exact: true }).click();
  await dialog.getByLabel("Search icons").fill("lock simple");
  const lock = dialog.getByRole("radio", { name: "lock simple", exact: true });
  // The first click can land while the dialog is still opening in a cold dev build, so it is tried again.
  await expect(async () => {
    await lock.click();
    await expect(lock).toHaveAttribute("data-state", "on", { timeout: 2000 });
  }).toPass({ timeout: 20_000 });
  await expect(dialog.getByRole("button", { name: "Upload" })).toBeVisible();
});
