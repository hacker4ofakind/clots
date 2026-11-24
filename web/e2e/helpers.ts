import AxeBuilder from "@axe-core/playwright";
import { expect, type APIRequestContext, type Page } from "@playwright/test";

const CONTROL = `http://127.0.0.1:${Number(process.env.E2E_DAEMON_PORT ?? 8791) + 1}`;

/** Opens an ask through the fake daemon's own controls. */
export async function openAsk(request: APIRequest, body: { kind: "email" | "choice"; clot?: string; text?: string }): Promise<void> {
  await request.post(`${CONTROL}/ask`, { data: body });
}
type APIRequest = APIRequestContext;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function control(request: APIRequest, path: string, body: unknown = {}): Promise<any> {
  return (await request.post(`${CONTROL}${path}`, { data: body })).json();
}

/**
 * Opens a page and waits until its event stream is connected. Whatever the daemon does after this reaches the page as an event; before
 * it, the page only learns of it when it fetches again, which is slower and not what the test means to look at.
 */
export async function gotoLive(page: Page, path: string): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __streamOpen?: boolean; __wrapped?: boolean; __sources?: EventSource[]; EventSource: typeof EventSource };
    if (w.__wrapped) return;
    w.__wrapped = true;
    const Real = w.EventSource;
    w.EventSource = class extends Real {
      constructor(url: string | URL, init?: EventSourceInit) {
        super(url, init);
        (w.__sources ??= []).push(this);
        this.addEventListener("open", () => (w.__streamOpen = true));
      }
    };
  });
  await page.goto(path);
  await page.waitForFunction(() => (window as unknown as { __streamOpen?: boolean }).__streamOpen === true);
}

/** Blocks every ask that is open, so a test starts with nothing waiting. */
export async function clearAsks(page: Page): Promise<void> {
  await page.goto("/waiting");
  await page.evaluate(async () => {
    const asks: { id: number; view: { options?: unknown } }[] = await (await fetch("/api/d/asks")).json();
    for (const ask of asks) {
      const answer = ask.view.options ? { action: "pick", option: 0 } : { action: "block" };
      await fetch(`/api/d/asks/${ask.id}/answer`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ answer }) });
    }
  });
}

/** Fails on any serious or critical accessibility violation on the page as it is. */
export async function expectNoSeriousViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(serious.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}
