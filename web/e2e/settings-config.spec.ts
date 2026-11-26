import { expect, test, type Page } from "@playwright/test";
import { control, expectNoSeriousViolations } from "./helpers";

// The settings that used to be file-only: General's Clots, Incoming events and Spending groups, the Schedule page, a Clot's description and
// test command in Edit, an inbox's more options and the options only some tools have. Each saves, reloads and reads back what was saved.

test.beforeEach(async ({ request }) => {
  await control(request, "/config-reset");
  await control(request, "/integrations/reset");
});

const save = (page: Page) => page.getByRole("button", { name: "Save", exact: true });
const time = (page: Page, label: string, nth = 0) => page.getByRole("combobox", { name: label }).nth(nth);
const setTime = async (page: Page, label: string, value: string, nth = 0) => {
  await time(page, label, nth).click();
  await page.getByRole("option", { name: value, exact: true }).click();
};
const field = (page: Page, name: string) => page.getByRole("textbox", { name });

test("General shows the daemon's defaults for the new settings, and each one saves and reads back", async ({ page }) => {
  await page.goto("/settings/general");
  for (const name of ["Clots", "Incoming events", "Spending"]) await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  await expect(page.getByRole("switch", { name: "Home Clot" })).toBeChecked();
  await expect(field(page, "Wait for quiet")).toHaveValue("60");
  await expect(field(page, "Longest wait")).toHaveValue("120");
  await expect(page.getByRole("switch", { name: "Look through claude.ai connectors" })).toBeChecked();
  await expect(page.getByRole("group", { name: "Look every" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Look every, hours" })).toHaveValue("3");
  await expect(page.getByRole("switch", { name: "Warn about weekly spending" })).toBeChecked();
  await expect(field(page, "Weekly limit")).toHaveValue("50");

  await field(page, "Wait for quiet").fill("30");
  await field(page, "Longest wait").fill("90");
  await page.getByRole("textbox", { name: "Look every, hours" }).fill("1");
  await page.getByRole("textbox", { name: "Look every, minutes" }).fill("30");
  await field(page, "Weekly limit").fill("120");
  await save(page).click();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();

  await page.reload();
  await expect(field(page, "Wait for quiet")).toHaveValue("30");
  await expect(field(page, "Longest wait")).toHaveValue("90");
  await expect(page.getByRole("textbox", { name: "Look every, minutes" })).toHaveValue("30");
  await expect(field(page, "Weekly limit")).toHaveValue("120");
});

test("switching the sweep and the spending warning off hides their numbers, and off reads back as off", async ({ page }) => {
  await page.goto("/settings/general");
  await page.getByRole("switch", { name: "Look through claude.ai connectors" }).click();
  await expect(page.getByRole("group", { name: "Look every" })).toHaveCount(0);
  await page.getByRole("switch", { name: "Warn about weekly spending" }).click();
  await expect(field(page, "Weekly limit")).toHaveCount(0);
  await save(page).click();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("switch", { name: "Look through claude.ai connectors" })).not.toBeChecked();
  await expect(page.getByRole("switch", { name: "Warn about weekly spending" })).not.toBeChecked();
  // Turned on again, the warning starts from the daemon's default.
  await page.getByRole("switch", { name: "Warn about weekly spending" }).click();
  await expect(field(page, "Weekly limit")).toHaveValue("50");
});

test("the Home Clot switch is honest about needing a restart", async ({ page }) => {
  await page.goto("/settings/general");
  await expect(page.getByText("Takes effect after a restart")).toBeVisible();
  await page.getByRole("switch", { name: "Home Clot" }).click();
  await save(page).click();
  await expect(page.getByText("Saved. The Home Clot takes effect after a restart.")).toBeVisible();
  await page.reload();
  await expect(page.getByRole("switch", { name: "Home Clot" })).not.toBeChecked();
});

test("a longest wait shorter than the quiet wait is refused in words beside its field, and nothing is saved", async ({ page }) => {
  await page.goto("/settings/general");
  await field(page, "Wait for quiet").fill("200");
  await field(page, "Longest wait").fill("100");
  await save(page).click();
  await expect(page.getByRole("alert").filter({ hasText: "The longest wait cannot be shorter than the quiet wait." })).toBeVisible();
  await page.reload();
  await expect(field(page, "Wait for quiet")).toHaveValue("60");
});

test("a look every shorter than 15 minutes is refused beside its field", async ({ page }) => {
  await page.goto("/settings/general");
  await page.getByRole("textbox", { name: "Look every, hours" }).fill("0");
  await page.getByRole("textbox", { name: "Look every, minutes" }).fill("5");
  await save(page).click();
  await expect(page.getByRole("alert").filter({ hasText: "at least 15" })).toBeVisible();
});

test("Schedule lists a row per weekday for both gates with the defaults, saves a change, and reads it back", async ({ page }) => {
  await page.goto("/settings/general");
  await page.getByRole("link", { name: "Schedule" }).click();
  await expect(page.getByRole("heading", { name: "Schedule", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Scarce hours" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Lead-in hours" })).toBeVisible();
  await expect(page.getByRole("switch", { name: "Monday scarce hours" })).toBeChecked();
  await expect(time(page, "Monday from")).toHaveText("15:00");
  await expect(time(page, "Monday to")).toHaveText("18:00");
  await expect(page.getByRole("switch", { name: "Saturday scarce hours" })).not.toBeChecked();
  await expect(time(page, "Monday from", 1)).toHaveText("10:00");
  await expect(field(page, "Hold when usage reaches")).toHaveValue("50");

  await page.getByRole("switch", { name: "Monday scarce hours" }).click();
  await page.getByRole("switch", { name: "Saturday scarce hours" }).click();
  await setTime(page, "Saturday from", "09:00");
  await setTime(page, "Saturday to", "12:30");
  await field(page, "Hold when usage reaches").fill("70");
  await save(page).click();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();

  await page.reload();
  await expect(page.getByRole("switch", { name: "Monday scarce hours" })).not.toBeChecked();
  await expect(time(page, "Saturday from")).toHaveText("09:00");
  await expect(time(page, "Saturday to")).toHaveText("12:30");
  await expect(field(page, "Hold when usage reaches")).toHaveValue("70");
  // Restore defaults puts the weekdays back, and still has to be saved.
  await page.getByRole("button", { name: "Restore defaults" }).first().click();
  await expect(page.getByRole("switch", { name: "Monday scarce hours" })).toBeChecked();
  await expect(page.getByRole("switch", { name: "Saturday scarce hours" })).not.toBeChecked();
});

test("a window that ends before it starts is refused naming the day, and Schedule keeps its edits to fix", async ({ page }) => {
  await page.goto("/settings/schedule");
  await setTime(page, "Wednesday from", "18:00");
  await setTime(page, "Wednesday to", "09:00");
  await save(page).click();
  await expect(page.getByRole("alert").filter({ hasText: "Wednesday: the window must start before it ends." })).toBeVisible();
  await expect(time(page, "Wednesday from")).toHaveText("18:00");
  await setTime(page, "Wednesday from", "08:00");
  await save(page).click();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
});

test("the time pickers are shadcn selects that show the whole time at the widest and the narrowest width the page has", async ({ page, request }) => {
  await control(request, "/config-write", { patch: { gates: { scarce: { mon: "09:10-23:45" }, leadIn: {}, leadInPercent: 50 } } });
  for (const width of [1280, 768]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/settings/schedule");
    const from = time(page, "Monday from");
    // A time between the quarter-hours is kept and shown.
    await expect(from).toHaveText("09:10");
    await expect(time(page, "Monday to")).toHaveText("23:45");
    const clipped = await from.evaluate((el) => el.scrollWidth > el.clientWidth);
    expect(clipped).toBe(false);
    await expect(page.locator('input[type="time"]')).toHaveCount(0);
    const box = await time(page, "Monday to").boundingBox();
    expect(box!.x + box!.width).toBeLessThanOrEqual(width);
  }
  await setTime(page, "Monday from", "08:15");
  await expect(time(page, "Monday from")).toHaveText("08:15");
});

test("leaving Schedule with unsaved edits asks first", async ({ page }) => {
  await page.goto("/settings/schedule");
  await field(page, "Hold when usage reaches").fill("80");
  await page.getByRole("link", { name: "General" }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog.getByText("Leave without saving?")).toBeVisible();
  await dialog.getByRole("button", { name: "Keep editing" }).click();
  await expect(page).toHaveURL(/\/settings\/schedule$/);
});

test("a hand edit of the gates in clots.config.json shows on the Schedule page", async ({ page, request }) => {
  await page.goto("/settings/schedule");
  await expect(page.getByRole("switch", { name: "Tuesday scarce hours" })).toBeChecked();
  await control(request, "/config-write", { patch: { gates: { scarce: { tue: "13:00-14:00" }, leadIn: {}, leadInPercent: 40 } } });
  await expect(page.getByRole("switch", { name: "Monday scarce hours" })).not.toBeChecked({ timeout: 10_000 });
  await expect(time(page, "Tuesday from")).toHaveText("13:00");
  await expect(field(page, "Hold when usage reaches")).toHaveValue("40");
});

test("Edit shows a Clot's description and test command, saves them, and an empty one clears it", async ({ page }) => {
  await page.goto("/new?edit=Truecast");
  const about = page.getByLabel("What this project is");
  const test = page.getByLabel("Test command");
  await expect(about).toBeVisible();
  await expect(test).toHaveValue("");
  await about.fill("The payments service");
  await test.fill("npm test");
  await page.getByRole("button", { name: "Next" }).click();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page).toHaveURL(/\/settings\/clots$/, { timeout: 20_000 });

  await page.goto("/new?edit=Truecast");
  await expect(page.getByLabel("What this project is")).toHaveValue("The payments service");
  await expect(page.getByLabel("Test command")).toHaveValue("npm test");
  await page.getByLabel("Test command").fill("");
  await page.getByRole("button", { name: "Next" }).click();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page).toHaveURL(/\/settings\/clots$/, { timeout: 20_000 });
  await page.goto("/new?edit=Truecast");
  await expect(page.getByLabel("Test command")).toHaveValue("");
  await expect(page.getByLabel("What this project is")).toHaveValue("The payments service");
});

test("a new Clot's first step has no description or test command, and the home Clot's Edit has none either", async ({ page }) => {
  await page.goto("/new");
  await expect(page.getByLabel("GitHub repository")).toBeVisible();
  await expect(page.getByLabel("What this project is")).toHaveCount(0);
  await page.goto("/new?edit=home");
  await expect(page.getByLabel("What this project is")).toHaveCount(0);
});

test("an inbox's more options: other addresses, the told address, and the mail servers of a provider that is not Gmail", async ({ page }) => {
  await page.goto("/settings/integrations");
  await page.getByRole("button", { name: "Add inbox" }).click();
  const dialog = page.getByRole("dialog", { name: "Add an inbox" });
  await dialog.getByLabel("Address").fill("me@acme.example");
  await dialog.getByLabel("Password", { exact: true }).fill("pw");
  await expect(dialog.getByLabel("Incoming mail server", { exact: true })).toHaveCount(0);
  await dialog.getByRole("button", { name: "More options" }).click();
  await dialog.getByLabel("Incoming mail server", { exact: true }).fill("imap.acme.example");
  await dialog.getByLabel("Outgoing mail server", { exact: true }).fill("smtp.acme.example");
  await dialog.getByLabel("Other addresses").fill("support@acme.example, hello@acme.example");
  await dialog.getByRole("switch", { name: "Tell the Clots the address" }).click();
  await dialog.getByRole("button", { name: "Add inbox" }).click();
  await expect(dialog).toHaveCount(0);

  await page.getByRole("button", { name: "Edit me@acme.example" }).click();
  const edit = page.getByRole("dialog", { name: "Edit inbox" });
  // An inbox that uses any of them opens with them showing.
  await expect(edit.getByLabel("Incoming mail server", { exact: true })).toHaveValue("imap.acme.example");
  await expect(edit.getByLabel("Incoming mail server port")).toHaveValue("993");
  await expect(edit.getByLabel("Outgoing mail server port")).toHaveValue("465");
  await expect(edit.getByLabel("Other addresses")).toHaveValue("support@acme.example, hello@acme.example");
  await expect(edit.getByRole("switch", { name: "Tell the Clots the address" })).not.toBeChecked();
  await edit.getByLabel("Other addresses").fill("");
  await edit.getByRole("switch", { name: "Tell the Clots the address" }).click();
  await edit.getByRole("button", { name: "Save" }).click();
  await expect(edit).toHaveCount(0);
  await page.getByRole("button", { name: "Edit me@acme.example" }).click();
  await expect(page.getByRole("dialog", { name: "Edit inbox" }).getByLabel("Other addresses")).toHaveValue("");
  await expect(page.getByRole("dialog", { name: "Edit inbox" }).getByRole("switch", { name: "Tell the Clots the address" })).toBeChecked();
});

test("a Gmail inbox's more options have no mail servers: Gmail's are known", async ({ page }) => {
  await page.goto("/settings/integrations");
  await page.getByRole("button", { name: "Add inbox" }).click();
  const dialog = page.getByRole("dialog", { name: "Add an inbox" });
  await dialog.getByLabel("Address").fill("me@gmail.com");
  await dialog.getByRole("button", { name: "More options" }).click();
  await expect(dialog.getByLabel("Other addresses")).toBeVisible();
  await expect(dialog.getByLabel("Incoming mail server", { exact: true })).toHaveCount(0);
});

test("Google Calendar asks how long before events it reminds, refuses a wrong lead time in words, and keeps the answer on edit", async ({ page, request }) => {
  await page.goto("/settings/integrations");
  await page.getByRole("button", { name: "Add a tool" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Google Calendar", exact: true }).click();
  const lead = dialog.getByLabel("Remind me before events");
  await expect(lead).toHaveValue("24h");
  await lead.fill("a day");
  await expect(dialog.getByText("Use a number and m, h or d, like 24h or 90m.")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Finish" })).toBeDisabled();
  await lead.fill("24h, 90m");
  await expect(dialog.getByRole("button", { name: "Finish" })).toBeEnabled();
  await dialog.getByRole("button", { name: "Finish" }).click();
  await expect(dialog.getByRole("link", { name: /Sign in to Google Calendar/ })).toBeVisible();
  await control(request, "/integrations/activate");
  await expect(dialog.getByText("Connected")).toBeVisible();
  const done = dialog.getByRole("button", { name: /^Done/ });
  await expect(done).toBeEnabled({ timeout: 8000 });
  await done.click();
  await page.getByRole("button", { name: "Edit Google Calendar" }).click();
  await expect(page.getByRole("dialog").getByLabel("Remind me before events")).toHaveValue("24h, 90m");
});

test("Stripe asks whether to include completed checkouts, and keeps the answer on edit", async ({ page }) => {
  await page.goto("/settings/integrations");
  await page.getByRole("button", { name: "Add a tool" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Stripe", exact: true }).click();
  await expect(dialog.getByRole("switch", { name: "Include completed checkouts" })).not.toBeChecked();
  await expect(dialog.getByLabel("Remind me before events")).toHaveCount(0);
  await dialog.getByRole("switch", { name: "Include completed checkouts" }).click();
  await dialog.getByRole("button", { name: "Finish" }).click();
  await dialog.getByLabel("API key").fill("sk_test_123");
  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole("button", { name: "Edit Stripe" }).click();
  await expect(page.getByRole("dialog").getByRole("switch", { name: "Include completed checkouts" })).toBeChecked();
});

for (const scheme of ["light", "dark"] as const) {
  test(`General, Schedule and Edit have no serious accessibility violations (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto("/settings/general");
    await expect(field(page, "Wait for quiet")).toBeVisible();
    await expectNoSeriousViolations(page);
    await page.goto("/settings/schedule");
    await expect(page.getByRole("heading", { name: "Scarce hours" })).toBeVisible();
    await expectNoSeriousViolations(page);
    await page.goto("/new?edit=Truecast");
    await expect(page.getByLabel("Test command")).toBeVisible();
    await expectNoSeriousViolations(page);
  });
}
