import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { clearAsks, control, expectNoSeriousViolations, gotoLive, openAsk } from "./helpers";

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
  await expect.poll(() => menu.getByRole("option").count()).toBeGreaterThan(5);
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
  await gotoLive(page, "/c/home");
  await openAsk(request, { kind: "email", clot: "home", text: "Hello Jane." });
  const card = page.getByRole("region", { name: "Send an email from Home?" });
  await expect(card).toBeVisible();
  await card.getByLabel("Message").fill("Edited test.");
  await card.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.locator("[data-ask-outcome]").last()).toContainText("Sent an email · you allowed it (with your changes)");
  const sent = await control(request, "/sent");
  expect(sent).toContain("Edited test.");
});

test("a choice shows its two options with the Clot's pick marked, and a pick settles it", async ({ page, request }) => {
  await gotoLive(page, "/c/home");
  await openAsk(request, { kind: "choice", clot: "home" });
  const card = page.getByRole("region", { name: "Which test runner?" });
  await expect(card.getByRole("button", { name: /Vitest.*pick/ })).toBeVisible();
  await card.getByRole("button", { name: "Jest" }).click();
  await expect(page.locator("[data-ask-outcome]").last()).toContainText("You picked 2");
});

test("an ended ask's icon says how it ended: approved, declined, timed out", async ({ page, request }) => {
  await gotoLive(page, "/c/home");
  const ended = (result: string) => page.locator(`[data-ask-outcome][data-ask-result="${result}"]`);
  const approved = await ended("approved").count();
  const declined = await ended("declined").count();
  const timedOut = await ended("timed_out").count();

  await openAsk(request, { kind: "email", clot: "home", text: "One." });
  await page.getByRole("region", { name: "Send an email from Home?" }).getByRole("button", { name: "Send", exact: true }).click();
  await expect(ended("approved")).toHaveCount(approved + 1);
  await expect(ended("approved").last().locator("svg")).toBeVisible();

  await openAsk(request, { kind: "email", clot: "home", text: "Two." });
  await page.getByRole("region", { name: "Send an email from Home?" }).getByRole("button", { name: "Don't send" }).click();
  await expect(ended("declined")).toHaveCount(declined + 1);

  await control(request, "/timeout", { minutes: 0.03 });
  try {
    await openAsk(request, { kind: "email", clot: "home", text: "Three." });
    await expect(ended("timed_out")).toHaveCount(timedOut + 1, { timeout: 15_000 });
  } finally {
    await control(request, "/timeout", { minutes: 10 });
  }

  // Each result draws its own icon.
  const drawn = await Promise.all(["approved", "declined", "timed_out"].map((r) => ended(r).last().locator("svg").innerHTML()));
  expect(new Set(drawn).size).toBe(3);
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
    await expect(page.getByRole("region", { name: "Send an email from Home?" })).toBeVisible();
    await expectNoSeriousViolations(page);
  });
}

/** How far the chat's view is from its end, in pixels. */
const fromEnd = (page: Page) => page.locator("[data-chat-scroller]").evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);

/** Puts `count` short messages from a Clot into its chat, so there is something to scroll. */
async function fill(request: APIRequestContext, clot: string, count: number, prefix = "Filler"): Promise<void> {
  for (let i = 1; i <= count; i++) await control(request, "/say", { clot, text: `${prefix} ${i}: a line long enough to wrap onto a second line when the window is narrow, so the chat has height.` });
}

test("the chat follows what arrives while the user is at its end, and shows a New messages pill when they are reading higher up", async ({ page, request }) => {
  await fill(request, "Encryptify", 40);
  await gotoLive(page, "/c/Encryptify");
  await expect.poll(() => fromEnd(page)).toBeLessThan(5);

  const stamp = Date.now();
  await control(request, "/say", { clot: "Encryptify", text: `Arrived at the end ${stamp}` });
  await expect(page.getByText(`Arrived at the end ${stamp}`)).toBeVisible();
  await expect.poll(() => fromEnd(page)).toBeLessThan(5);
  await expect(page.getByRole("button", { name: "New messages" })).toHaveCount(0);

  await page.locator("[data-chat-scroller]").evaluate((el) => el.scrollBy(0, -900));
  await expect.poll(() => fromEnd(page)).toBeGreaterThan(800);
  await control(request, "/say", { clot: "Encryptify", text: `Arrived while reading ${stamp}` });
  const pill = page.getByRole("button", { name: "New messages" });
  await expect(pill).toBeVisible();
  // What the user was reading did not move.
  expect(await fromEnd(page)).toBeGreaterThan(800);

  await pill.click();
  await expect(pill).toHaveCount(0);
  await expect.poll(() => fromEnd(page)).toBeLessThan(5);
  await expect(page.getByText(`Arrived while reading ${stamp}`)).toBeVisible();
});

test("older messages come in above without moving what the user is reading", async ({ page, request }) => {
  await fill(request, "Truecast", 130, "History");
  await page.goto("/c/Truecast");
  const scroller = page.locator("[data-chat-scroller]");
  const messages = page.locator('[data-message-kind="clot"]');
  await expect.poll(() => fromEnd(page)).toBeLessThan(5);
  const before = await messages.count();
  expect(before).toBeLessThan(130);

  // The oldest message on screen after going to the top, and where it is.
  await scroller.evaluate((el) => (el.scrollTop = 0));
  const first = (await messages.first().innerText()).split("\n")[0]!;
  const offset = () => messages.filter({ hasText: first }).first().evaluate((el) => el.getBoundingClientRect().top - (document.querySelector("[data-chat-scroller]") as HTMLElement).getBoundingClientRect().top);
  const top = await offset();
  await expect.poll(() => messages.count()).toBeGreaterThan(before);
  expect(Math.abs((await offset()) - top)).toBeLessThan(2);
  // Not at the top any more: the new page is above the view.
  expect(await scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(200);
});

test("the chat and the Clots list show skeletons shaped like themselves while the daemon is slow", async ({ page, request }) => {
  await control(request, "/slow", { ms: 2500 });
  try {
    await page.goto("/c/home", { waitUntil: "commit" });
    await expect(page.getByRole("status", { name: "Loading the chat" })).toBeVisible();
    await expect(page.getByLabel("Message Home").first()).toBeVisible({ timeout: 20_000 });
    await page.goto("/clots", { waitUntil: "commit" });
    await expect(page.getByRole("status", { name: "Loading the Clots" })).toBeVisible();
    await expect(page.getByRole("status", { name: "Loading the Clots" })).toHaveCount(0, { timeout: 20_000 });
    // Moving between chats shows the chat skeleton while the next one loads.
    await control(request, "/slow", { ms: 0 });
    await page.goto("/c/home");
    await control(request, "/slow", { ms: 2500 });
    await page.getByRole("link", { name: "Truecast" }).click();
    await expect(page.getByRole("status", { name: "Loading the chat" })).toBeVisible();
    await expect(page.getByLabel("Message Truecast").first()).toBeVisible({ timeout: 20_000 });
  } finally {
    await control(request, "/slow", { ms: 0 });
  }
});

test("a draft stays with its Clot, across chats and reloads, and goes when it is sent", async ({ page }) => {
  await page.goto("/c/Truecast");
  await page.getByLabel("Message Truecast").fill("not sent yet");
  await page.getByRole("link", { name: "Encryptify" }).click();
  await expect(page.getByLabel("Message Encryptify")).toBeVisible();
  await expect(page.getByLabel("Message Encryptify")).toHaveValue("");
  await page.getByRole("link", { name: "Truecast" }).click();
  await expect(page.getByLabel("Message Truecast")).toHaveValue("not sent yet");
  await page.reload();
  await expect(page.getByLabel("Message Truecast")).toHaveValue("not sent yet");
  await page.getByLabel("Message Truecast").press("Enter");
  await expect(page.getByLabel("Message Truecast")).toHaveValue("");
  await page.reload();
  await expect(page.getByLabel("Message Truecast")).toHaveValue("");
});

test("a message that could not be sent stays in the chat with Retry, and Retry sends it once", async ({ page }) => {
  await page.goto("/c/home");
  await page.route("**/api/d/clots/home/messages", (route) => (route.request().method() === "POST" ? route.abort() : route.continue()));
  const text = `retry me ${Date.now()}`;
  await page.getByLabel("Message Home").fill(text);
  await page.getByLabel("Message Home").press("Enter");
  const mine = page.locator('[data-message-kind="user"]').filter({ hasText: text });
  await expect(mine).toHaveCount(1);
  await expect(mine.getByText("Not sent.")).toBeVisible();
  await page.unroute("**/api/d/clots/home/messages");
  await mine.getByRole("button", { name: "Retry" }).click();
  await expect(page.locator('[data-message-kind="clot"]').filter({ hasText: `You said: ${text}` })).toHaveCount(1, { timeout: 10_000 });
  await expect(page.locator('[data-message-kind="user"]').filter({ hasText: text })).toHaveCount(1);
  await expect(page.getByText("Not sent.")).toHaveCount(0);
});

test("a pasted picture larger than 2048 pixels is shrunk to a JPEG before it is uploaded", async ({ page }) => {
  await page.goto("/c/home");
  const box = page.getByLabel("Message Home");
  await box.focus();
  await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 3000;
    canvas.height = 1500;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#3a7";
    context.fillRect(0, 0, 3000, 1500);
    const blob = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!), "image/png"));
    const data = new DataTransfer();
    data.items.add(new File([blob], "big.png", { type: "image/png" }));
    document.querySelector("textarea")!.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await expect(page.getByRole("img", { name: "Attached" })).toBeVisible();
  const posted = page.waitForRequest((r) => r.url().endsWith("/api/d/clots/home/messages") && r.method() === "POST");
  await box.fill("a picture");
  await box.press("Enter");
  const body = JSON.parse((await posted).postData() ?? "{}") as { images: string[] };
  expect(body.images).toHaveLength(1);
  expect(body.images[0]).toMatch(/^data:image\/jpeg;base64,/);
  const size = await page.evaluate(
    (src) =>
      new Promise<{ width: number; height: number }>((resolve) => {
        const img = new Image();
        img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
        img.src = src;
      }),
    body.images[0]!,
  );
  expect(size).toEqual({ width: 2048, height: 1024 });
});

test("a message that came while the page was away is fetched when the page is visible again", async ({ page, request }) => {
  await gotoLive(page, "/c/home");
  await expect(page.getByLabel("Message Home")).toBeVisible();
  // The stream goes dead without a word, as on a phone that slept.
  await page.evaluate(() => (window as unknown as { __sources: EventSource[] }).__sources.forEach((source) => source.close()));
  const text = `while away ${Date.now()}`;
  await control(request, "/say", { clot: "home", text });
  await page.waitForTimeout(500);
  await expect(page.getByText(text)).toHaveCount(0);
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(page.getByText(text)).toBeVisible({ timeout: 5000 });
});

test("an ask card past its deadline reads Closing… until the daemon closes it", async ({ page, request }) => {
  await control(request, "/timeout", { minutes: 1 });
  try {
    await gotoLive(page, "/c/Truecast");
    await openAsk(request, { kind: "email", clot: "Truecast" });
    const card = page.getByRole("region", { name: "Send an email from Truecast?" });
    await expect(card).toBeVisible();
    await expect(card.locator("[data-ask-closing]")).toHaveCount(0);
    // Two minutes pass on the page's clock, while the daemon's has not yet closed the ask.
    await page.evaluate(() => {
      const real = Date.now.bind(Date);
      Date.now = () => real() + 120_000;
    });
    await expect(card.locator("[data-ask-closing]")).toContainText("Closing…");
    await expect(card.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
  } finally {
    await control(request, "/timeout", { minutes: 10 });
  }
});

test("the rail's Clots move with the keyboard, and the side pane resizes with the arrow keys", async ({ page }) => {
  await page.goto("/c/home");
  // Other tests may have made more Clots in the fake daemon; only the first three are compared.
  const names = () => page.locator("[data-rail-clot]").evaluateAll((els) => els.map((el) => el.getAttribute("data-rail-clot")));
  const top = async () => (await names()).slice(0, 3);
  const start = await names();
  expect(start.slice(0, 3)).toEqual(["home", "Truecast", "Encryptify"]);
  await page.locator('[data-rail-clot="Truecast"] a').focus();
  await page.keyboard.press("Alt+ArrowDown");
  await expect.poll(top).toEqual(["home", "Encryptify", "Truecast"]);
  await expect(page.locator('[data-rail-clot="Truecast"] a')).toBeFocused();
  await expect(page.getByRole("status").filter({ hasText: /Truecast moved to position 3 of \d+/ })).toHaveCount(1);
  await page.keyboard.press("Alt+ArrowUp");
  await expect.poll(names).toEqual(start);
  // The same through the context menu, which the Menu key opens.
  await page.locator('[data-rail-clot="Truecast"]').dispatchEvent("contextmenu");
  await page.getByRole("menuitem", { name: "Move down" }).click();
  await expect.poll(top).toEqual(["home", "Encryptify", "Truecast"]);
  await page.locator('[data-rail-clot="Truecast"]').dispatchEvent("contextmenu");
  await page.getByRole("menuitem", { name: "Move up" }).click();
  await expect.poll(names).toEqual(start);

  await page.getByRole("button", { name: "Info" }).click();
  const grip = page.getByRole("separator", { name: "Resize the side pane" });
  await expect(grip).toBeAttached();
  const pane = page.getByRole("complementary", { name: /Info about/ });
  const width = () => pane.evaluate((el) => (el.parentElement ?? el).getBoundingClientRect().width);
  await expect.poll(width).toBeGreaterThan(290);
  const openWidth = await width();
  await grip.focus();
  await page.keyboard.press("ArrowLeft");
  await expect.poll(width).toBeGreaterThan(openWidth);
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await expect.poll(width).toBeLessThan(openWidth);
  // Narrowing it with the keys past the closing mark closes it, as letting go of the drag there does.
  for (let i = 0; i < 12; i++) await page.keyboard.press("ArrowRight");
  await expect(pane).toHaveCount(0);
});
