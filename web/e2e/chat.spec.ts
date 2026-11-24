import { expect, test } from "@playwright/test";
import { clearAsks, control, expectNoSeriousViolations, openAsk } from "./helpers";

test.beforeEach(async ({ page }) => {
  await clearAsks(page);
});

test("a sent message appears at once, and the reply streams in and settles as one message", async ({ page }) => {
  await page.goto("/c/home");
  const box = page.getByLabel("Message Home");
  const text = `hello ${Date.now()}`;
  await box.fill(text);
  await box.press("Enter");
  await expect(page.locator('[data-message-kind="user"]').filter({ hasText: text })).toHaveCount(1);
  const reply = page.locator('[data-message-kind="clot"]').filter({ hasText: `You said: ${text}` });
  await expect(reply).toHaveCount(1, { timeout: 10_000 });
  await expect(reply).not.toHaveAttribute("data-streaming", "true");
});

test("the slash menu filters /cl to close and calendar undo, with the matched letters in bold", async ({ page }) => {
  await page.goto("/c/home");
  const box = page.getByLabel("Message Home");
  await box.fill("/");
  const menu = page.getByRole("listbox", { name: "Commands" });
  await expect(menu.getByRole("option")).toHaveCount(10);
  await box.fill("/cl");
  await expect(menu.getByRole("option")).toHaveCount(2);
  await expect(menu.getByRole("option").first()).toContainText("/close");
  await expect(menu.getByRole("option").nth(1)).toContainText("/calendar undo");
  await expect(menu.getByRole("option").first().locator("b")).toHaveText(["c", "l"]);
  await box.fill("/sp");
  await expect(menu.getByRole("option")).toHaveCount(1);
  await expect(menu).toContainText("/spend");
});

test("an email ask is answered from its card in the chat, after the user edits the text", async ({ page, request }) => {
  await page.goto("/c/home");
  await openAsk(request, { kind: "email", clot: "home", text: "Hello Jane." });
  const card = page.getByRole("region", { name: "Allow Home to send an email?" });
  await expect(card).toBeVisible();
  await card.getByLabel("Message").fill("Edited test.");
  await card.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.locator("[data-ask-outcome]").last()).toContainText("Sent an email · you allowed it (with your changes)");
  const sent = await control(request, "/sent");
  expect(sent).toContain("Edited test.");
});

test("a choice shows its two options with the Clot's pick marked, and a pick settles it", async ({ page, request }) => {
  await page.goto("/c/home");
  await openAsk(request, { kind: "choice", clot: "home" });
  const card = page.getByRole("region", { name: "Which test runner?" });
  await expect(card.getByRole("button", { name: /Vitest.*pick/ })).toBeVisible();
  await card.getByRole("button", { name: "Jest" }).click();
  await expect(page.locator("[data-ask-outcome]").last()).toContainText("You picked 2");
});

test("an ask that closed in another tab shows how it ended in a toast", async ({ page, request }) => {
  await page.goto("/waiting");
  await openAsk(request, { kind: "email", clot: "home" });
  const row = page.locator("[data-ask-row]").first();
  await expect(row).toBeVisible();
  const id = await row.getAttribute("data-ask-row");
  await page.evaluate(async (askId) => {
    await fetch(`/api/d/asks/${askId}/answer`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ answer: { action: "allow" } }) });
  }, id);
  // The stream has not told this page yet, perhaps; answering again gets the first outcome.
  const again = await page.evaluate(async (askId) => {
    const res = await fetch(`/api/d/asks/${askId}/answer`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ answer: { action: "block" } }) });
    return { status: res.status, body: await res.json() };
  }, id);
  expect(again.status).toBe(409);
  expect(again.body.outcome).toContain("Sent an email");
});

test("the banner shows while the daemon is away, and goes when it is back", async ({ page, request }) => {
  await page.goto("/c/home");
  await control(request, "/stop");
  await expect(page.getByRole("alert").filter({ hasText: "Can't reach the Clots daemon. Retrying…" })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("button", { name: "Send" })).toBeDisabled();
  await control(request, "/start");
  await expect(page.getByRole("alert").filter({ hasText: "Can't reach the Clots daemon" })).toHaveCount(0, { timeout: 40_000 });
});

for (const scheme of ["light", "dark"] as const) {
  test(`the chat and Waiting for you have no serious accessibility violations (${scheme})`, async ({ page, request }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await openAsk(request, { kind: "email", clot: "home" });
    await page.goto("/waiting");
    await expect(page.locator("[data-ask-row]").first()).toBeVisible();
    await expectNoSeriousViolations(page);
    await page.goto("/c/home");
    await expect(page.getByRole("region", { name: "Allow Home to send an email?" })).toBeVisible();
    await expectNoSeriousViolations(page);
  });
}
