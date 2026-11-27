import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { control, expectNoSeriousViolations } from "./helpers";

// The daemon is the fake one with the real creator: a fake GitHub (a repository with "private" in its name is out of reach, one with
// "broken" fails its first build) and a fake Docker whose steps take `/build-ms` each. Each test makes Clots of its own names.

// The fake daemon may outlive a run, so the Clots a test makes get a name of their own each time.
const run = Math.random().toString(36).slice(2, 6);
const named = (base: string) => `${base}${run}`;

test.beforeEach(async ({ request }) => {
  await control(request, "/integrations/reset");
  await control(request, "/build-ms", { ms: 250 });
});

const fill = async (page: Page, name: string, repo: string) => {
  await page.getByLabel("Name").fill(name);
  await page.getByLabel("GitHub repository").fill(repo);
};
/** Makes a Clot through the API and waits until its build has finished (its checklist is in its chat), so an Edit test has one of its own. */
const makeClot = async (page: Page, request: APIRequestContext, name: string, repo: string) => {
  await control(request, "/build-ms", { ms: 50 });
  await page.goto("/waiting");
  const status = await page.evaluate(async ([n, r]) => (await fetch("/api/d/clots", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: n, repo: r }) })).status, [name, repo]);
  expect(status).toBe(202);
  await expect
    .poll(async () => page.evaluate(async (n) => ((await (await fetch(`/api/d/clots/${n}/messages`)).json()) as { messages: { kind: string }[] }).messages.some((m) => m.kind === "onboarding"), name), { timeout: 15_000 })
    .toBe(true);
};
/** Takes the pointer off the buttons: the dark theme's hover fill on a primary button is lighter than its resting one (3.9:1 with white), so a button the pointer is on would fail the contrast check. */
const calm = (page: Page) => page.mouse.move(640, 300);
const next = (page: Page) => page.getByRole("button", { name: /^(Next|Check again)/ }).click();

test("a taken name, a clash that differs only in capitals, a bad name and a repository the machine account cannot reach each show their error", async ({ page }) => {
  await page.goto("/new");
  await expect(page.getByRole("heading", { name: "Create a new Clot" })).toBeVisible();
  const nextButton = page.getByRole("button", { name: "Next" });
  await expect(nextButton).toBeDisabled();

  await fill(page, "Encryptify", "octo/anything");
  await next(page);
  await expect(page.getByRole("alert").filter({ hasText: "There is a Clot named Encryptify already." })).toBeVisible();

  // Names are compared in lower case: `truecast` is `Truecast`.
  await fill(page, "truecast", "octo/anything");
  await next(page);
  await expect(page.getByRole("alert").filter({ hasText: "There is a Clot named truecast already." })).toBeVisible();

  await fill(page, "bad_name", "octo/anything");
  await next(page);
  await expect(page.getByRole("alert").filter({ hasText: "letters, digits, hyphens" })).toBeVisible();

  await fill(page, "Locked", "octo/private-repo");
  await next(page);
  await expect(page.getByRole("alert").filter({ hasText: "clots-dot-dev cannot reach octo/private-repo" })).toBeVisible();
  // The instruction is said once, in the error, with the button's own wording.
  await expect(page.getByText("Invite clots-dot-dev as a collaborator on the repository. Then press Check again.")).toHaveCount(1);
  await expect(page.getByText(/Invite clots-dot-dev/)).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Check again" })).toBeVisible();
  // The step has not moved on.
  await expect(page).not.toHaveURL(/step=tools/);

  // A name with capitals that is free goes on, shown as typed.
  await fill(page, "Graphite", "octo/graphite");
  await next(page);
  await expect(page.getByRole("heading", { name: "Creating Graphite" })).toBeVisible({ timeout: 15_000 });
});

test("Tools step: shared accounts first, the old text gone; a tool added for the new Clot is held and sent with Create; the build shows cloning, building, starting; the chat opens with the checklist card", async ({ page, request }) => {
  const slate = named("Slate");
  test.setTimeout(90_000);
  await control(request, "/build-ms", { ms: 1200 });
  await page.goto("/new");
  await fill(page, slate, "octo/slate");
  await next(page);
  await expect(page.getByRole("heading", { name: `Creating ${slate}` })).toBeVisible({ timeout: 15_000 });
  await expect(page).toHaveURL(/step=tools/);

  await expect(page.getByRole("heading", { name: "Tools", exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("Tools shared with every Clot already work")).toHaveCount(0);
  await expect(page.getByText("add one in Settings")).toHaveCount(0);
  // Shared accounts are listed first and have no menu; Browser use and Computer use are planned, so they are not drawn.
  await expect(page.getByText("Microsoft Teams")).toBeVisible();
  await expect(page.getByRole("button", { name: "Microsoft Teams, options" })).toHaveCount(0);
  await expect(page.getByText("Browser use")).toHaveCount(0);

  // Add a tool: the dialog is for the Clot to be.
  await page.getByRole("button", { name: "Add a tool" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Instagram", exact: true }).click();
  await expect(dialog.getByLabel("Share with every Clot")).not.toBeChecked();
  await expect(dialog.getByText(`Off: only ${slate} uses it`)).toBeVisible();
  await dialog.getByRole("button", { name: "Finish" }).click();
  await expect(dialog.getByText("You’re almost done!")).toBeVisible();
  await control(request, "/integrations/activate");
  const done = dialog.getByRole("button", { name: /^Done/ });
  await expect(done).toBeEnabled({ timeout: 8000 });
  await done.click();
  const tile = page.getByRole("button", { name: "Instagram, options" });
  await expect(tile).toBeVisible();
  await expect(page).toHaveURL(/tools=/);

  // The held tool has Edit settings and Remove from Slate (it is not connected to anything to reconnect yet).
  await tile.click({ button: "right" });
  const menu = page.getByRole("menu", { name: "Instagram" });
  await expect(menu.getByRole("menuitem")).toHaveText(["Edit settings", `Remove from ${slate}`]);
  await menu.getByRole("menuitem", { name: "Edit settings" }).click();
  await expect(dialog.getByRole("heading", { name: "Configure Instagram" })).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);

  // A reload keeps the step and the tool.
  await page.reload();
  await expect(page.getByRole("heading", { name: `Creating ${slate}` })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("button", { name: "Instagram, options" })).toBeVisible();

  await page.getByRole("button", { name: `Create ${slate}` }).click();
  await expect(page).toHaveURL(/step=create/);
  const step = (name: string) => page.locator(`[data-build-step="${name}"]`);
  await expect(step("cloning")).toHaveAttribute("data-state", "now");
  await expect(step("building")).toHaveAttribute("data-state", "next");
  await expect(step("building")).toHaveAttribute("data-state", "now", { timeout: 5000 });
  await expect(step("cloning")).toHaveAttribute("data-state", "done");
  await expect(step("starting")).toHaveAttribute("data-state", "now", { timeout: 5000 });

  // The new Clot's chat opens with the one-line message and its checklist.
  await expect(page).toHaveURL(new RegExp(`/c/${slate}$`), { timeout: 10_000 });
  const card = page.locator("[data-onboarding]");
  await expect(card).toContainText(`${slate} is ready. Three steps finish its setup.`);
  await expect(card.locator("[data-step]")).toHaveCount(3);
  expect(await card.innerHTML()).not.toContain("whsec_fake_secret");
  await expect(page.getByRole("link", { name: slate })).toBeVisible();

  // The tool went in with the Clot: it is the Clot's own, in the list.
  await page.goto("/settings/integrations");
  await expect(page.getByRole("listitem").filter({ hasText: "Instagram" }).filter({ hasText: `${slate} only` })).toBeVisible();
});

test("a reload during a build shows the build progress, and the chat opens when it is done", async ({ page, request }) => {
  const midway = named("Midway");
  await control(request, "/build-ms", { ms: 1500 });
  await page.goto("/new");
  await fill(page, midway, "octo/midway");
  await next(page);
  await page.getByRole("button", { name: `Create ${midway}` }).click();
  await expect(page).toHaveURL(/step=create/);
  await expect(page.locator('[data-build-step="cloning"]')).toHaveAttribute("data-state", "done", { timeout: 5000 });
  await page.reload();
  await expect(page.getByRole("heading", { name: `Creating ${midway}` })).toBeVisible({ timeout: 15_000 });
  await expect(page.locator("[data-build-step]")).toHaveCount(3);
  await expect(page.locator('[data-build-step="cloning"]')).toHaveAttribute("data-state", "done");
  await expect(page).toHaveURL(new RegExp(`/c/${midway}$`), { timeout: 15_000 });
});

test("a failed build shows its log and Retry, and Retry carries on to the chat", async ({ page, request }) => {
  const brittle = named("Brittle");
  await control(request, "/build-ms", { ms: 150 });
  await page.goto("/new");
  await fill(page, brittle, "octo/broken-one");
  await next(page);
  await page.getByRole("button", { name: `Create ${brittle}` }).click();
  await expect(page.getByRole("heading", { name: `Creating ${brittle} failed` })).toBeVisible();
  await expect(page.getByText(`${brittle} could not be created.`)).toBeVisible();
  await expect(page.getByText("The repository could not be downloaded. Check its name and that the Clots account can reach it. The log below has the details.")).toBeVisible();
  await expect(page.getByText("Remote branch main not found")).toBeVisible();
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page).toHaveURL(new RegExp(`/c/${brittle}$`), { timeout: 15_000 });
  await expect(page.locator("[data-onboarding]")).toContainText(`${brittle} is ready.`);
});

test("Reset clears the form and Back keeps what was typed", async ({ page }) => {
  await page.goto("/new");
  await fill(page, "Keeper", "octo/keeper");
  await next(page);
  await page.getByRole("button", { name: "Back" }).click();
  await expect(page.getByLabel("Name")).toHaveValue("Keeper");
  await expect(page.getByLabel("GitHub repository")).toHaveValue("octo/keeper");
  // A reload keeps the form too: it is in the address.
  await page.reload();
  await expect(page.getByLabel("Name")).toHaveValue("Keeper");
  await page.getByRole("button", { name: "Reset" }).click();
  await expect(page.getByLabel("Name")).toHaveValue("");
  await expect(page.getByLabel("GitHub repository")).toHaveValue("");
  await expect(page).toHaveURL(/\/new(\?step=details)?$/);
});

test("Edit opens the same steps prefilled with the name fixed; a changed repository re-clones into a fresh workspace and shows the build", async ({ page, request }) => {
  const rework = named("Rework");
  await makeClot(page, request, rework, "octo/rework");
  await control(request, "/build-ms", { ms: 1500 });
  await page.goto(`/new?edit=${rework}`);
  await expect(page.getByRole("heading", { name: `Edit ${rework}` })).toBeVisible();
  await expect(page.getByLabel("Name")).toBeDisabled();
  await expect(page.getByLabel("Name")).toHaveValue(rework);
  await expect(page.getByLabel("GitHub repository")).toHaveValue("octo/rework");
  await expect(page.getByRole("button", { name: "Reset" })).toBeVisible();
  await expect(page.getByText("fresh workspace")).toHaveCount(0);

  await page.getByLabel("GitHub repository").fill("octo/rework-next");
  await expect(page.getByText("clones this repository into a fresh workspace")).toBeVisible();
  await next(page);
  await expect(page.getByRole("heading", { name: `Edit ${rework}` })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Tools", exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("button", { name: `Create ${rework}` })).toHaveCount(0);
  await page.getByRole("button", { name: "Save" }).click();

  await expect(page.getByRole("heading", { name: `Saving ${rework}` })).toBeVisible();
  await expect(page.getByText("cloned from the new repository into a fresh workspace")).toBeVisible();
  await expect(page.locator('[data-build-step="cloning"]')).toHaveAttribute("data-state", "now");
  await expect(page).toHaveURL(/\/settings\/clots$/, { timeout: 15_000 });
  const clots = await page.evaluate(async () => (await (await fetch("/api/d/clots")).json()) as { name: string; repository: string }[]);
  expect(clots.find((c) => c.name === rework)?.repository).toBe("octo/rework-next");
});

test("Edit with the repository unchanged saves at once and goes back to Manage Clots", async ({ page, request }) => {
  const plain = named("Plain");
  await makeClot(page, request, plain, "octo/plain");
  await page.goto(`/new?edit=${plain}`);
  await expect(page.getByLabel("GitHub repository")).toHaveValue("octo/plain");
  await next(page);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page).toHaveURL(/\/settings\/clots$/);
});

test("in Edit the Tools step shows the Clot's tools after the shared ones, and a tile's menu has Edit settings, Reconnect and Remove from the Clot, which asks first", async ({ page }) => {
  await page.goto("/new?edit=Truecast&step=tools");
  const tile = page.getByRole("button", { name: "PostHog, options" });
  await expect(tile).toBeVisible();
  await expect(page.getByRole("button", { name: "Microsoft Teams, options" })).toHaveCount(0);
  // Shared first (it is earlier in the page than the Clot's own).
  const teams = await page.getByText("Microsoft Teams").boundingBox();
  const posthog = await tile.boundingBox();
  expect(teams!.x).toBeLessThan(posthog!.x);

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

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });
  test("New Clot is not a phone screen: it goes back to the Clots list", async ({ page }) => {
    await page.goto("/new");
    await expect(page).toHaveURL(/\/clots$/);
    await page.goto("/new?edit=Truecast");
    await expect(page).toHaveURL(/\/clots$/);
  });
});

test("with reduced motion the steps do not slide", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/new");
  await fill(page, "Still", "octo/still");
  await next(page);
  await expect(page.getByRole("heading", { name: "Tools", exact: true })).toBeVisible({ timeout: 15_000 });
  const x = await page.getByRole("heading", { name: "Tools", exact: true }).evaluate((el) => el.getBoundingClientRect().x);
  expect(x).toBeGreaterThan(100);
  expect(x).toBeLessThan(120);
});

for (const scheme of ["light", "dark"] as const) {
  test(`New Clot's steps have no serious accessibility violations (${scheme})`, async ({ page, request }) => {
    const axe = named(`Axe${scheme}`);
    await control(request, "/build-ms", { ms: 1500 });
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto("/new");
    await expect(page.getByLabel("Name")).toBeVisible();
    await calm(page);
    await expectNoSeriousViolations(page);
    await fill(page, `${axe}`, "octo/axe");
    await next(page);
    await expect(page.getByRole("heading", { name: "Tools", exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("button", { name: "Microsoft Teams, options" }).or(page.getByText("Microsoft Teams"))).toBeVisible();
    await calm(page);
    await expectNoSeriousViolations(page);
    await page.getByRole("button", { name: "Add a tool" }).click();
    await expect(page.getByRole("dialog").getByRole("button", { name: "Instagram", exact: true })).toBeVisible({ timeout: 15_000 });
    await calm(page);
    await expectNoSeriousViolations(page);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: `Create ${axe}` }).click();
    await expect(page.locator("[data-build-step]")).toHaveCount(3);
    await calm(page);
    await expectNoSeriousViolations(page);
    await expect(page).toHaveURL(new RegExp(`/c/${axe}$`), { timeout: 15_000 });
    await expect(page.locator("[data-onboarding]")).toBeVisible();
    await expect(page.locator("[data-step]")).toHaveCount(3);
    await calm(page);
    await expectNoSeriousViolations(page);
  });

  test(`a failed build and the Edit steps have no serious accessibility violations (${scheme})`, async ({ page, request }) => {
    const cracked = named(`Cracked${scheme}`);
    await control(request, "/build-ms", { ms: 100 });
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto("/new");
    await fill(page, `${cracked}`, "octo/broken-axe");
    await next(page);
    await page.getByRole("button", { name: `Create ${cracked}` }).click();
    await expect(page.getByText("could not be created.")).toBeVisible();
    await calm(page);
    await expectNoSeriousViolations(page);
    await page.goto("/new?edit=Truecast");
    await expect(page.getByLabel("GitHub repository")).toHaveValue("octo/Truecast");
    await calm(page);
    await expectNoSeriousViolations(page);
  });
}
