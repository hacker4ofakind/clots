import { expect, test, type APIRequestContext } from "@playwright/test";
import { control } from "./helpers";

const setTheme = async (request: APIRequestContext, theme: "light" | "dark" | "system") => {
  const res = await request.put("/api/d/settings/ui", { data: { theme }, headers: { origin: "http://localhost:3100" } });
  expect(res.ok()).toBe(true);
};
const html = (page: import("@playwright/test").Page) => page.evaluate(() => ({ dark: document.documentElement.classList.contains("dark"), stored: localStorage.getItem("theme") }));

test.afterEach(async ({ request }) => {
  await control(request, "/start");
  await setTheme(request, "system");
});

test("the saved theme wins over whatever the browser kept from an earlier visit, on every page", async ({ page, request }) => {
  await setTheme(request, "light");
  // The browser's own copy says "dark" and the machine is in dark mode: the page still shows Light, and the copy is corrected.
  await page.emulateMedia({ colorScheme: "dark" });
  await page.addInitScript(() => localStorage.setItem("theme", "dark"));
  for (const path of ["/waiting", "/does-not-exist"]) {
    await page.goto(path);
    expect(await html(page), path).toEqual({ dark: false, stored: "light" });
  }
  await setTheme(request, "dark");
  await page.goto("/waiting");
  expect(await html(page)).toEqual({ dark: true, stored: "dark" });
  await setTheme(request, "system");
  await page.goto("/waiting");
  expect(await html(page)).toEqual({ dark: true, stored: "system" });
});

test("Settings, the stored theme and the page agree after a change, and after a reload", async ({ page, request }) => {
  await setTheme(request, "light");
  await page.goto("/settings/general");
  const theme = page.getByRole("radiogroup", { name: "Theme" });
  await theme.getByRole("radio", { name: "Dark" }).click();
  await expect(page.locator("html")).toHaveClass(/dark/);
  expect((await html(page)).stored).toBe("dark");
  await page.reload();
  await expect(theme.getByRole("radio", { name: "Dark" })).toBeChecked();
  expect(await html(page)).toEqual({ dark: true, stored: "dark" });
});

test("a daemon that is down when the page loads does not change the theme the browser had", async ({ page, request }) => {
  await setTheme(request, "dark");
  await page.goto("/waiting");
  expect(await html(page)).toEqual({ dark: true, stored: "dark" });
  await control(request, "/stop");
  await page.reload();
  await expect(page.getByRole("alert").filter({ hasText: "Can't reach the Clots daemon" })).toBeVisible({ timeout: 15_000 });
  expect(await html(page)).toEqual({ dark: true, stored: "dark" });
});
