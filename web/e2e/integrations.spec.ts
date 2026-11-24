import { expect, test, type Page } from "@playwright/test";
import { control, expectNoSeriousViolations } from "./helpers";

test.beforeEach(async ({ request }) => {
  await control(request, "/integrations/reset");
});

/** A row of a list (the toasts are list items too). */
const row = (page: Page, text: string) => page.getByRole("listitem").filter({ hasText: text }).filter({ has: page.getByRole("button", { name: /^(Edit|Remove)/ }) });

const open = async (page: Page) => {
  await page.goto("/settings/integrations");
  await page.getByRole("button", { name: "Add a tool" }).click();
  return page.getByRole("dialog");
};
const pick = async (page: Page, toolkit: string) => {
  const dialog = await open(page);
  await dialog.getByRole("button", { name: toolkit, exact: true }).click();
  await expect(dialog.getByRole("heading", { name: `Configure ${toolkit}` })).toBeVisible();
  return dialog;
};

test("Integrations lists the inboxes, the Composio tools and the keys, each with an icon, where it is used and its buttons", async ({ page }) => {
  await page.goto("/settings/integrations");
  await expect(page.getByRole("heading", { name: "Integrations", exact: true })).toBeVisible();
  for (const name of ["Inboxes", "Composio", "Keys"]) await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  const gmail = row(page, "lukbicycles.com+clots@gmail.com");
  await expect(gmail).toContainText("Gmail · Home only");
  await expect(row(page, "lukas@tady.ch")).toContainText("Shared");
  await expect(row(page, "PostHog")).toContainText("Truecast only · public");
  await expect(row(page, "Microsoft Teams")).toContainText("Shared · team");
  await expect(page.getByRole("button", { name: "Edit PostHog" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Remove PostHog" })).toBeVisible();
  // Browser use, Computer use and the Save button are planned: not drawn at all.
  await expect(page.getByText("Browser use")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
});

test("the pick step searches Composio's toolkits and marks the ones already added", async ({ page }) => {
  const dialog = await open(page);
  await expect(dialog.getByRole("heading", { name: "Add a tool" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Close" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Granola", exact: true })).toBeVisible();
  // Added ones show "added" and a remove button instead of a way in.
  await expect(dialog.getByText("PostHog")).toContainText("added");
  await expect(dialog.getByRole("button", { name: "PostHog", exact: true })).toHaveCount(0);
  await dialog.getByLabel("Search Composio’s toolkits").fill("gran");
  await expect(dialog.getByRole("button", { name: "Granola", exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Instagram", exact: true })).toHaveCount(0);
  await dialog.getByLabel("Search Composio’s toolkits").fill("zzzz");
  await expect(dialog.getByText("No toolkit matches")).toBeVisible();
  // Removing an added toolkit asks first.
  await dialog.getByLabel("Search Composio’s toolkits").fill("post");
  await dialog.getByRole("button", { name: "Remove PostHog" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Cancel" }).click();
  await expect(dialog.getByRole("button", { name: "Remove PostHog" })).toBeVisible();
  await dialog.getByRole("button", { name: "Remove PostHog" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Remove" }).click();
  await expect(dialog.getByRole("button", { name: "PostHog", exact: true })).toBeVisible();
});

test("an OAuth tool: skeletons while it works, no close button, Done off for five seconds and until the sign-in is active, then it is in the list", async ({ page, request }) => {
  const dialog = await pick(page, "Granola");
  // Only a webhook-less toolkit asks how often to check; with no Clot the tool is shared, so there is no "every Clot" switch.
  await expect(dialog.getByText("Check every")).toBeVisible();
  await expect(dialog.getByLabel("Share with every Clot")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Finish" }).click();

  await expect(dialog.getByRole("status", { name: "Setting up Granola" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Close" })).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Back" })).toBeVisible();

  const done = dialog.getByRole("button", { name: /^Done/ });
  await expect(dialog.getByText("You’re almost done!")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Close" })).toHaveCount(0);
  const signIn = dialog.getByRole("link", { name: /Sign in to Granola/ });
  await expect(signIn).toHaveAttribute("target", "_blank");
  await expect(signIn).toHaveAttribute("href", /^https:\/\/connect\.example\.test\//);
  await expect(done).toBeDisabled();
  await expect(done).toContainText(/\(\d\)/);
  // A stray click outside or Escape does not cancel a half-made connection.
  await page.keyboard.press("Escape");
  await page.mouse.click(5, 5);
  await expect(dialog).toBeVisible();

  // The sign-in finishes at once, but Done still waits out its five seconds.
  await control(request, "/integrations/activate");
  await expect(dialog.getByText("Connected")).toBeVisible();
  await expect(done).toBeDisabled();
  await expect(done).toBeEnabled({ timeout: 8000 });
  await expect(done).not.toContainText("(");
  await done.click();
  await expect(dialog).toHaveCount(0);
  const granola = row(page, "Granola");
  await expect(granola).toContainText("Shared · team");
});

test("Done stays off while the sign-in is not active, even after the five seconds", async ({ page }) => {
  const dialog = await pick(page, "Instagram");
  await dialog.getByRole("button", { name: "Finish" }).click();
  const done = dialog.getByRole("button", { name: /^Done/ });
  await expect(done).toContainText("(", { timeout: 5000 });
  await page.waitForTimeout(5500);
  await expect(done).not.toContainText("(");
  await expect(done).toBeDisabled();
  // Back returns to the options, and the options step has its close button again.
  await dialog.getByRole("button", { name: "Back" }).click();
  await expect(dialog.getByRole("heading", { name: "Configure Instagram" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Close" })).toBeVisible();
});

test("an API key tool: the key field with an eye toggle and the configurer's instructions, and Done is off while it is empty", async ({ page }) => {
  const dialog = await pick(page, "ElevenLabs");
  await dialog.getByRole("button", { name: "Finish" }).click();
  await expect(dialog.getByRole("button", { name: "Close" })).toHaveCount(0);
  const field = dialog.getByLabel("API key");
  await expect(field).toBeVisible();
  const done = dialog.getByRole("button", { name: "Done" });
  await expect(done).toBeDisabled();
  await expect(dialog.getByRole("heading", { name: "How to get one" })).toBeVisible();
  await expect(dialog.getByRole("listitem")).toHaveCount(4);
  await expect(dialog.getByRole("link", { name: "elevenlabs.io/app/developers/api-keys" })).toHaveAttribute("href", "https://elevenlabs.io/app/developers/api-keys");

  await field.fill("bad");
  await expect(field).toHaveAttribute("type", "password");
  await dialog.getByRole("button", { name: "Show the key" }).click();
  await expect(field).toHaveAttribute("type", "text");
  await expect(done).toBeEnabled();
  await done.click();
  await expect(dialog.getByRole("alert")).toHaveText("That key was refused.");
  await field.fill("sk_live_123");
  await done.click();
  await expect(dialog).toHaveCount(0);
  await expect(row(page, "ElevenLabs")).toBeVisible();
});

test("a failure shows its error with Try again and Back, and Try again goes on", async ({ page }) => {
  const dialog = await pick(page, "Flaky");
  await dialog.getByRole("button", { name: "Finish" }).click();
  await expect(dialog.getByRole("alert")).toContainText("could not find a way to connect Flaky");
  await expect(dialog.getByRole("button", { name: "Close" })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Try again" }).click();
  await expect(dialog.getByText("You’re almost done!")).toBeVisible();
  // Back goes to the options.
  await dialog.getByRole("button", { name: "Back" }).click();
  await expect(dialog.getByRole("heading", { name: "Configure Flaky" })).toBeVisible();
  await expect(dialog.getByText("Audience")).toBeVisible();
});

test("editing a tool opens its options filled in, and Finish replaces it, keeping the Clot it is for", async ({ page }) => {
  await page.goto("/settings/integrations");
  await page.getByRole("button", { name: "Edit PostHog" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Configure PostHog" })).toBeVisible();
  await expect(dialog.getByRole("combobox", { name: "Audience" })).toContainText("Public");
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeVisible();
  await dialog.getByRole("combobox", { name: "Audience" }).click();
  await page.getByRole("option", { name: "Private" }).click();
  await dialog.getByRole("button", { name: "Finish" }).click();
  await dialog.getByLabel("API key").fill("sk_live_456");
  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(dialog).toHaveCount(0);
  const rows = row(page, "PostHog");
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText("Truecast only · private");
});

test("the tool tile's menu: right-click or Enter opens Edit settings, Reconnect and Remove from the Clot, and Remove asks first", async ({ page }) => {
  await page.goto("/e2e-harness/tools");
  const tile = page.getByRole("button", { name: "PostHog, options" });
  await tile.click({ button: "right" });
  const menu = page.getByRole("menu", { name: "PostHog" });
  await expect(menu.getByRole("menuitem")).toHaveText(["Edit settings", "Reconnect", "Remove from Truecast"]);
  await page.keyboard.press("Escape");

  // The keyboard reaches the same menu.
  await tile.focus();
  await page.keyboard.press("Enter");
  await expect(menu).toBeVisible();
  await menu.getByRole("menuitem", { name: "Edit settings" }).click();
  const dialog = page.getByRole("dialog", { name: "Configure PostHog" });
  await expect(dialog.getByLabel("Share with every Clot")).not.toBeChecked();
  await expect(dialog.getByText("Off: only Truecast uses it")).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel" }).click();

  // Reconnect goes straight to the connect step.
  await tile.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Reconnect" }).click();
  await expect(dialog.getByLabel("API key")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Close" })).toHaveCount(0);
  await dialog.getByLabel("API key").fill("sk_live_789");
  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(dialog).toHaveCount(0);

  // Remove asks, and Cancel keeps it.
  await tile.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Remove from Truecast" }).click();
  const confirm = page.getByRole("alertdialog", { name: "Remove PostHog from Truecast?" });
  await confirm.getByRole("button", { name: "Cancel" }).click();
  await expect(tile).toBeVisible();
  await tile.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Remove from Truecast" }).click();
  await confirm.getByRole("button", { name: "Remove" }).click();
  await expect(tile).toHaveCount(0);
});

test("the dialog opened for a Clot offers to share the tool with every Clot, and a tool added for a Clot is its own", async ({ page, request }) => {
  await page.goto("/e2e-harness/tools");
  await page.getByRole("button", { name: "Add a tool" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Instagram", exact: true }).click();
  await expect(dialog.getByLabel("Share with every Clot")).not.toBeChecked();
  await dialog.getByRole("button", { name: "Finish" }).click();
  await expect(dialog.getByText("You’re almost done!")).toBeVisible();
  await control(request, "/integrations/activate");
  const done = dialog.getByRole("button", { name: /^Done/ });
  await expect(done).toBeEnabled({ timeout: 8000 });
  await done.click();
  await expect(page.getByRole("button", { name: "Instagram, options" })).toBeVisible();
  await page.goto("/settings/integrations");
  await expect(row(page, "Instagram")).toContainText("Truecast only");
});

test("an inbox: the provider is detected from the address, and it can be added, edited and removed", async ({ page }) => {
  await page.goto("/settings/integrations");
  await page.getByRole("button", { name: "Add inbox" }).click();
  const dialog = page.getByRole("dialog", { name: "Add an inbox" });
  const add = dialog.getByRole("button", { name: "Add inbox" });
  await expect(add).toBeDisabled();
  await dialog.getByLabel("Address").fill("me@example.org");
  await expect(dialog.getByLabel("Password", { exact: true })).toBeVisible();
  await dialog.getByLabel("Address").fill("me@gmail.com");
  await expect(dialog.getByText("Gmail", { exact: true })).toBeVisible();
  await expect(dialog.getByLabel("App password")).toBeVisible();
  await dialog.getByLabel("App password").fill("abcd efgh ijkl mnop");
  await dialog.getByLabel("Folders to watch").fill("INBOX, Alerts");
  await dialog.getByRole("switch", { name: "Share with every Clot" }).click();
  await dialog.getByRole("combobox", { name: "Only this Clot" }).click();
  await page.getByRole("option", { name: "Truecast" }).click();
  await add.click();
  await expect(dialog).toHaveCount(0);
  const inbox = row(page, "me@gmail.com");
  await expect(inbox).toContainText("Gmail · Truecast only");

  await page.getByRole("button", { name: "Edit me@gmail.com" }).click();
  const edit = page.getByRole("dialog", { name: "Edit inbox" });
  await expect(edit.getByLabel("Address")).toBeDisabled();
  await expect(edit.getByLabel("Folders to watch")).toHaveValue("INBOX, Alerts");
  await edit.getByRole("switch", { name: "Share with every Clot" }).click();
  await edit.getByRole("button", { name: "Save" }).click();
  await expect(inbox).toContainText("Gmail · Shared");

  await page.getByRole("button", { name: "Remove me@gmail.com" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Remove" }).click();
  await expect(inbox).toHaveCount(0);
});

for (const scheme of ["light", "dark"] as const) {
  test(`the integration dialog's steps and Settings have no serious accessibility violations (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto("/settings/integrations");
    await expect(row(page, "PostHog")).toBeVisible();
    await expectNoSeriousViolations(page);

    await page.getByRole("button", { name: "Add a tool" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("button", { name: "Granola", exact: true })).toBeVisible();
    await expectNoSeriousViolations(page);
    await dialog.getByRole("button", { name: "Granola", exact: true }).click();
    await expect(dialog.getByText("Audience")).toBeVisible();
    await expectNoSeriousViolations(page);
    await dialog.getByRole("button", { name: "Finish" }).click();
    await expect(dialog.getByRole("status", { name: "Setting up Granola" })).toBeVisible();
    await expectNoSeriousViolations(page);
    await expect(dialog.getByText("You’re almost done!")).toBeVisible();
    await expectNoSeriousViolations(page);
    await dialog.getByRole("button", { name: "Back" }).click();
    await dialog.getByRole("button", { name: "Back" }).click();
    await dialog.getByRole("button", { name: "ElevenLabs", exact: true }).click();
    await dialog.getByRole("button", { name: "Finish" }).click();
    await expect(dialog.getByLabel("API key")).toBeVisible();
    await expectNoSeriousViolations(page);
  });
}
