import { expect, test, type Dialog, type Page } from "@playwright/test";
import { control, expectNoSeriousViolations, gotoLive } from "./helpers";

// The settings pages against the fake daemon's own configuration file: General saves and reloads, Manage Clots lists and deletes, and a
// hand edit of clots.config.json is picked up (or refused) while the page is open.

test.beforeEach(async ({ request }) => {
  await control(request, "/config-reset");
});

const workers = (page: Page) => page.getByRole("textbox", { name: "Workers at once" });
const rollover = (page: Page) => page.getByRole("textbox", { name: "Start a new session at" });
const saveButton = (page: Page) => page.getByRole("button", { name: "Save", exact: true });

test("General saves, and a reload shows what was saved", async ({ page }) => {
  await page.goto("/settings/general");
  await expect(workers(page)).toHaveValue("3");
  await workers(page).fill("5");
  await rollover(page).fill("70");
  await saveButton(page).click();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  await page.reload();
  await expect(workers(page)).toHaveValue("5");
  await expect(rollover(page)).toHaveValue("70");
});

test("a value the daemon refuses comes back as an error for its field, and nothing is saved", async ({ page }) => {
  await page.goto("/settings/general");
  // The fields clamp what is typed, so the refusal is asked of the daemon directly.
  const res = await page.evaluate(async () => {
    const r = await fetch("/api/d/settings/general", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ rolloverPercent: 300 }) });
    return { status: r.status, body: await r.json() };
  });
  expect(res.status).toBe(400);
  expect(res.body.errors.rolloverPercent).toBeTruthy();
  await page.reload();
  await expect(rollover(page)).toHaveValue("65");
});

test("Manage Clots lists every Clot with its repository, Edit and Delete, and Home cannot be deleted", async ({ page }) => {
  await page.goto("/settings/clots");
  await expect(page.getByRole("heading", { name: "Manage Clots" })).toBeVisible();
  const row = (name: string) => page.getByRole("listitem").filter({ has: page.getByRole("link", { name: `Edit ${name}` }) });
  await expect(row("Truecast")).toContainText("octo/Truecast");
  await expect(row("Encryptify")).toContainText("octo/Encryptify");
  await expect(row("Home")).toContainText("No repository");
  await expect(page.getByRole("link", { name: "Edit Truecast" })).toHaveAttribute("href", "/new?edit=Truecast");
  await expect(page.getByRole("link", { name: "New Clot" }).last()).toHaveAttribute("href", "/new");
  await expect(page.getByRole("button", { name: "Delete Home" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Delete Truecast" })).toBeEnabled();
});

test("deleting a Clot asks for its name to be typed, and only then deletes it", async ({ page }) => {
  await page.goto("/settings/clots");
  await page.getByRole("button", { name: "Delete Encryptify" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Delete Encryptify?" })).toBeVisible();
  const confirm = dialog.getByRole("button", { name: "Delete Encryptify" });
  await expect(confirm).toBeDisabled();
  await dialog.getByLabel("Type Encryptify to confirm").fill("encryptify");
  await expect(confirm).toBeDisabled();
  await dialog.getByLabel("Type Encryptify to confirm").fill("Encryptify");
  await expect(confirm).toBeEnabled();
  await confirm.click();
  await expect(page.getByText("Deleted Encryptify.")).toBeVisible();
  await expect(dialog).toHaveCount(0);
  // The daemon took it out of the configuration: deleting it again finds nothing.
  const again = await page.evaluate(async () => (await fetch("/api/d/clots/Encryptify?confirm=Encryptify", { method: "DELETE" })).status);
  expect(again).toBe(404);
});

test("a hand edit of clots.config.json shows the picked-up toast and the new value on the page", async ({ page, request }) => {
  await gotoLive(page, "/settings/general");
  await expect(rollover(page)).toHaveValue("65");
  await control(request, "/config-write", { patch: { rolloverPercent: 70 } });
  await expect(page.getByText("Picked up changes to clots.config.json")).toBeVisible({ timeout: 10_000 });
  await expect(rollover(page)).toHaveValue("70");
});

test("a hand edit that is not valid JSON shows an error toast and the page keeps the last good settings", async ({ page, request }) => {
  await gotoLive(page, "/settings/general");
  await control(request, "/config-write", { patch: { rolloverPercent: 70 } });
  await expect(rollover(page)).toHaveValue("70", { timeout: 10_000 });
  await control(request, "/config-write", { text: '{ "timeZone": ' });
  await expect(page.getByText("clots.config.json was not picked up")).toBeVisible({ timeout: 10_000 });
  await expect(rollover(page)).toHaveValue("70");
  await expect(page.getByRole("alert").filter({ hasText: "edited by hand and could not be used" })).toBeVisible();
});

test("a setting that takes a restart says so in the toast", async ({ page, request }) => {
  await gotoLive(page, "/settings/general");
  await control(request, "/config-write", { patch: { intake: { port: 9999 } } });
  await expect(page.getByText("Picked up changes to clots.config.json")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText("intake takes effect after a restart.")).toBeVisible();
});

test("leaving General with unsaved edits asks first, and a saved page leaves without asking", async ({ page }) => {
  await page.goto("/settings/general");
  await workers(page).click();
  await workers(page).fill("7");
  const dialogs: Dialog[] = [];
  page.on("dialog", (d) => {
    dialogs.push(d);
    void d.dismiss();
  });
  await page.close({ runBeforeUnload: true });
  await expect.poll(() => dialogs.map((d) => d.type())).toEqual(["beforeunload"]);
  expect(page.isClosed()).toBe(false);
  await saveButton(page).click();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  await page.close({ runBeforeUnload: true });
  await expect.poll(() => page.isClosed()).toBe(true);
  expect(dialogs).toHaveLength(1);
});

test("clicking away from General with unsaved edits asks first: Keep editing stays, Discard changes leaves", async ({ page }) => {
  await page.goto("/settings/general");
  await workers(page).fill("7");
  await page.getByRole("link", { name: "Waiting for you" }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog.getByText("Leave without saving?")).toBeVisible();
  await dialog.getByRole("button", { name: "Keep editing" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(/\/settings\/general$/);
  await expect(workers(page)).toHaveValue("7");
  await page.getByRole("link", { name: "Waiting for you" }).click();
  await dialog.getByRole("button", { name: "Discard changes" }).click();
  await expect(page).toHaveURL(/\/waiting$/);
  // The edit was not saved.
  await page.goto("/settings/general");
  await expect(workers(page)).toHaveValue("3");
});

for (const scheme of ["light", "dark"] as const) {
  test(`the settings pages have no serious accessibility violations (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto("/settings/general");
    await expect(workers(page)).toBeVisible();
    await expectNoSeriousViolations(page);
    await page.goto("/settings/clots");
    await expect(page.getByRole("button", { name: "Delete Truecast" })).toBeVisible();
    await expectNoSeriousViolations(page);
    await page.getByRole("button", { name: "Delete Truecast" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expectNoSeriousViolations(page);
  });
}
