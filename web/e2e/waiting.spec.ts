import { expect, test } from "@playwright/test";
import { clearAsks, control, openAsk } from "./helpers";

test.beforeEach(async ({ page }) => {
  await clearAsks(page);
});

test("with nothing waiting it says so", async ({ page }) => {
  await page.goto("/waiting");
  await expect(page.getByText("Continue with your life!")).toBeVisible();
  await expect(page.getByText("None of your Clots are waiting for you.")).toBeVisible();
});

test("asks are grouped under each Clot, the summary counts them, and an answer from the list removes the row", async ({ page, request }) => {
  await page.goto("/waiting");
  await openAsk(request, { kind: "email", clot: "home" });
  await openAsk(request, { kind: "choice", clot: "Truecast" });
  await expect(page.getByText("2 waiting · 0 urgent")).toBeVisible();
  await expect(page.getByRole("region", { name: "Home" }).locator("[data-ask-row]")).toHaveCount(1);
  await expect(page.getByRole("region", { name: "Truecast" }).locator("[data-ask-row]")).toHaveCount(1);
  const row = page.getByRole("region", { name: "Home" }).locator("[data-ask-row]");
  await row.getByRole("button", { name: "Send", exact: true }).first().click();
  await expect(page.getByRole("region", { name: "Home" })).toHaveCount(0);
  const sent = await control(request, "/sent");
  expect(sent.length).toBeGreaterThan(0);
  await page.getByRole("region", { name: "Truecast" }).getByRole("button", { name: /Jest/ }).click();
  await expect(page.getByText("Continue with your life!")).toBeVisible();
});

test("an email's body shows beside its subject on focus", async ({ page, request }) => {
  await page.goto("/waiting");
  await openAsk(request, { kind: "email", clot: "home", text: "Dear Jane, the refund is on its way." });
  await page.locator("[data-ask-row]").first().getByRole("button").first().focus();
  await expect(page.getByText("Dear Jane, the refund is on its way.")).toBeVisible();
});

test("Open in chat goes to the Clot's chat and the ask's card", async ({ page, request }) => {
  await page.goto("/waiting");
  await openAsk(request, { kind: "email", clot: "Truecast" });
  await page.locator("[data-ask-row]").first().getByRole("button", { name: "Open in chat" }).click();
  await expect(page).toHaveURL(/\/c\/Truecast\?ask=\d+/);
  await expect(page.getByRole("region", { name: "Allow Truecast to send an email?" })).toBeVisible();
});

test("the timer counts down, and turns calling then urgent", async ({ page, request }) => {
  await control(request, "/timeout", { minutes: 1 });
  await page.goto("/waiting");
  await openAsk(request, { kind: "email", clot: "home" });
  await expect(page.locator("[data-timer]").first()).toHaveAttribute("data-timer", /calling|urgent/);
  await expect(page.locator("[data-timer]").first()).toHaveAttribute("data-timer", "urgent", { timeout: 15_000 });
  await control(request, "/timeout", { minutes: 10 });
});
