import { expect, test, type Page } from "@playwright/test";
import { expectNoSeriousViolations } from "./helpers";

// The 404, the error page and the access page, in both themes on a desktop and on a phone. The error page is reached through
// /e2e/error, a route that exists only while CLOTS_E2E_HARNESS=1 (the e2e runs set it).

const SCREENS = [
  { name: "desktop", viewport: { width: 1280, height: 800 } },
  { name: "phone", viewport: { width: 412, height: 915 } },
] as const;

async function expectAllInView(page: Page): Promise<void> {
  const box = await page.getByRole("heading", { level: 1 }).boundingBox();
  const size = page.viewportSize()!;
  expect(box && box.x >= 0 && box.x + box.width <= size.width).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

for (const screen of SCREENS) {
  for (const scheme of ["light", "dark"] as const) {
    test.describe(`${screen.name}, ${scheme}`, () => {
      test.use({ viewport: screen.viewport, colorScheme: scheme });

      test("an unknown address shows the 404 page and a way to Waiting for you", async ({ page }) => {
        const response = await page.goto("/no-such-page");
        expect(response?.status()).toBe(404);
        await expect(page.getByRole("heading", { level: 1, name: "We can't find that page" })).toBeVisible();
        await expect(page.getByText("The link may be old, or that Clot may have been removed.")).toBeVisible();
        await expect(page.locator("html")).toHaveClass(scheme === "dark" ? /\bdark\b/ : /^(?!.*\bdark\b)/);
        await expectAllInView(page);
        await expectNoSeriousViolations(page);
        await page.getByRole("link", { name: "Go to Waiting for you" }).click();
        await expect(page).toHaveURL(/\/waiting$/, { timeout: 30_000 });
      });

      test("an unknown Clot shows the 404 page inside the app", async ({ page }) => {
        await page.goto("/c/no-such-clot");
        await expect(page.getByRole("heading", { level: 1, name: "We can't find that page" })).toBeVisible();
        // Inside the shell: no second frame, and on a desktop the rail stays.
        await expect(page.locator("[data-slot=status-page]")).toHaveCount(0);
        if (screen.name === "desktop") await expect(page.getByRole("navigation", { name: "Clots" })).toBeVisible();
        await expectAllInView(page);
        await expectNoSeriousViolations(page);
      });

      test("a page that fails shows the error page with no detail, Try again recovers and the other button goes home", async ({ page, context }) => {
        const logged: string[] = [];
        page.on("console", (message) => message.type() === "error" && logged.push(message.text()));
        await page.goto("/e2e/error");
        await expect(page.getByRole("heading", { level: 1, name: "Something went wrong" })).toBeVisible();
        await expect(page.getByText("Clots hit a problem showing this page.")).toBeVisible();
        // (The dev server adds its own overlay with the message; the page itself must not show it.)
        await expect(page.locator("[data-slot=status-panel]")).not.toContainText("Internal detail");
        expect(logged.some((line) => line.includes("Internal detail"))).toBe(true);
        await expectAllInView(page);
        await expectNoSeriousViolations(page);

        await context.addCookies([{ name: "e2e-ok", value: "1", url: page.url() }]);
        await page.getByRole("button", { name: "Try again" }).click();
        await expect(page.getByRole("paragraph").filter({ hasText: /^Recovered$/ })).toBeVisible();

        await context.clearCookies({ name: "e2e-ok" });
        await page.reload();
        await expect(page.getByRole("heading", { level: 1, name: "Something went wrong" })).toBeVisible();
        await page.getByRole("link", { name: "Go to Waiting for you" }).click();
        await expect(page).toHaveURL(/\/waiting$/, { timeout: 30_000 });
      });

      test("a visitor who is not the owner gets the private page", async ({ browser, baseURL }) => {
        const context = await browser.newContext({ baseURL, viewport: screen.viewport, colorScheme: scheme, extraHTTPHeaders: { "tailscale-user-login": "someone-else@example.com" } });
        try {
          const page = await context.newPage();
          const response = await page.goto("/waiting");
          expect(response?.status()).toBe(403);
          await expect(page.getByRole("heading", { level: 1, name: "Clots is private" })).toBeVisible();
          await expect(page.getByRole("link", { name: "Reload" })).toBeVisible();
          await expectAllInView(page);
          await expectNoSeriousViolations(page);
        } finally {
          await context.close();
        }
      });
    });
  }
}
