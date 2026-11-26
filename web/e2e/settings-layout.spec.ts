import { expect, test } from "@playwright/test";
import { control, expectNoSeriousViolations } from "./helpers";

// The settings pages' measures against the design: the capped content column, the theme picker's square-ish buttons, the time and
// number fields in the sans face with no leading zero, and the Keys list.

test.beforeEach(async ({ request }) => {
  await control(request, "/config-reset");
});

test("General's column is 680 px wide and Manage Clots and Integrations are 720, left aligned", async ({ page }) => {
  await page.goto("/settings/general");
  const nav = page.getByRole("navigation", { name: "Settings" });
  const column = async (heading: string) => {
    const box = await page.getByRole("heading", { name: heading, exact: true }).locator("xpath=ancestor::div[contains(@class,'max-w-')][1]").boundingBox();
    return { x: box!.x, width: box!.width };
  };
  await expect(page.getByRole("heading", { name: "General", exact: true })).toBeVisible();
  const navBox = await nav.boundingBox();
  const general = await column("General");
  expect(general.width).toBe(680);
  expect(general.x).toBeGreaterThan(navBox!.x + navBox!.width);
  await page.goto("/settings/clots");
  expect((await column("Manage Clots")).width).toBe(720);
  await page.goto("/settings/integrations");
  expect((await column("Integrations")).width).toBe(720);
});

test("the theme picker's buttons are 36 by 30 with 2 px between them, and the width picker's text is 13 px", async ({ page }) => {
  await page.goto("/settings/general");
  const theme = page.getByRole("radiogroup", { name: "Theme" });
  await expect(theme.getByRole("radio")).toHaveCount(3);
  const boxes = await theme.getByRole("radio").evaluateAll((els) => els.map((e) => e.getBoundingClientRect().toJSON()));
  for (const b of boxes) expect([Math.round(b.width), Math.round(b.height)]).toEqual([36, 30]);
  expect(Math.round(boxes[1]!.x - (boxes[0]!.x + boxes[0]!.width))).toBe(2);
  const size = await page.getByRole("radiogroup", { name: "Content width" }).getByRole("radio").first().evaluate((e) => getComputedStyle(e).fontSize);
  expect(size).toBe("13px");
});

test("the number, time and address fields use the sans face, and a duration has no leading zero", async ({ page }) => {
  await page.goto("/settings/general");
  const face = (locator: ReturnType<typeof page.getByRole>) => locator.evaluate((e) => getComputedStyle(e).fontFamily);
  for (const field of [page.getByRole("textbox", { name: "Start a new session at" }), page.getByRole("textbox", { name: "Ask timeout, hours" }), page.getByRole("textbox", { name: "Ask timeout, minutes" }), page.getByRole("textbox", { name: "Public URL" })]) {
    expect(await face(field)).toContain("Rethink");
  }
  await expect(page.getByRole("textbox", { name: "Ask timeout, hours" })).toHaveValue("0");
  await expect(page.getByRole("textbox", { name: "Ask timeout, minutes" })).toHaveValue("10");
});

test("every key has Replace and Remove, the daemon's own are off with a reason, and no lock is drawn", async ({ page }) => {
  await page.goto("/settings/integrations");
  const row = page.locator("[data-key=GITHUB_WEBHOOK_SECRET]");
  await expect(row).toBeVisible();
  await expect(row.getByRole("button", { name: "Replace GITHUB_WEBHOOK_SECRET" })).toBeDisabled();
  await expect(row.getByRole("button", { name: "Remove GITHUB_WEBHOOK_SECRET" })).toBeDisabled();
  await expect(row.getByRole("button", { name: "Replace GITHUB_WEBHOOK_SECRET" })).toHaveAttribute("title", /daemon's own/);
  await expect(page.getByLabel("The daemon's own key")).toHaveCount(0);
  // A key of the user's own is editable.
  await page.getByRole("button", { name: "Add key" }).click();
  const dialog = page.getByRole("dialog", { name: "Add a key" });
  await dialog.getByLabel("Name").fill("LAYOUT_TEST_KEY");
  await dialog.getByRole("textbox", { name: "Value" }).fill("secret-value-1234");
  await dialog.getByRole("button", { name: "Save" }).click();
  const own = page.locator("[data-key=LAYOUT_TEST_KEY]");
  await expect(own).toContainText("•••• 1234");
  await expect(own.getByRole("button", { name: "Replace LAYOUT_TEST_KEY" })).toBeEnabled();
  await expect(own.getByRole("button", { name: "Remove LAYOUT_TEST_KEY" })).toBeEnabled();
  await own.getByRole("button", { name: "Remove LAYOUT_TEST_KEY" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Remove" }).click();
  await expect(own).toHaveCount(0);
  await expectNoSeriousViolations(page);
});

test("a key refused by the daemon shows a sentence, never the raw error", async ({ page }) => {
  await page.goto("/settings/integrations");
  await page.getByRole("button", { name: "Add key" }).click();
  const dialog = page.getByRole("dialog", { name: "Add a key" });
  await dialog.getByLabel("Name").fill("CLAUDE_CODE_OAUTH_TOKEN");
  await dialog.getByRole("textbox", { name: "Value" }).fill("x");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog.getByRole("alert")).toHaveText("CLAUDE_CODE_OAUTH_TOKEN is the daemon's own and cannot be changed here.");
});
