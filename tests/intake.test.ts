import { afterEach, describe, expect, it } from "vitest";
import type { ClotEvent } from "../src/events/types.js";
import { jsonBody, startIntake, storeEvent, type Answer, type Handler } from "../src/intake.js";

const event: ClotEvent = { id: "x:1", source: "x", account: "a", kind: "comment", place: "p", actor: "someone", title: "t", body: "", url: "", ref: "1", subject: "s", automated: false, outsider: false, receivedAt: 0 };

let close: (() => void) | undefined;
afterEach(() => close?.());

async function serve(handlers: Record<string, Handler>, answers: Answer[]): Promise<string> {
  const server = startIntake({ port: 0, handlerFor: (path) => handlers[path], onAnswer: (answer) => answers.push(answer) });
  close = () => server.close();
  await new Promise((resolve) => server.once("listening", resolve));
  const address = server.address();
  return `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
}

describe("storeEvent", () => {
  it("answers 202 for a new event and 200 for a repeat, and carries a reason to drop it", () => {
    const seen = new Set<string>();
    const insert = (e: ClotEvent) => (seen.has(e.id) ? false : (seen.add(e.id), true));
    expect(storeEvent(event, insert)).toEqual({ status: 202, text: "accepted", event });
    expect(storeEvent(event, insert)).toEqual({ status: 200, text: "duplicate" });
    expect(storeEvent({ ...event, id: "x:2" }, insert, "caused by the Clot itself")).toMatchObject({ status: 202, dropped: "caused by the Clot itself" });
  });
});

describe("jsonBody", () => {
  it("reads JSON and gives nothing for anything else", () => {
    expect(jsonBody(Buffer.from('{"a":1}'))).toEqual({ a: 1 });
    expect(jsonBody(Buffer.from("nope"))).toBeUndefined();
  });
});

describe("startIntake", () => {
  it("hands each path to its handler with the headers, the query and the raw body, and passes on answers that carry an event", async () => {
    const seen: { headers: Record<string, string>; query: string; body: string; method: string }[] = [];
    const answers: Answer[] = [];
    const base = await serve(
      {
        "/webhooks/x/a": (req) => {
          seen.push({ headers: req.headers, query: req.query.toString(), body: req.rawBody.toString(), method: req.method });
          return { status: 202, text: "accepted", event };
        },
        "/oauth/callback": () => ({ status: 200, text: "<p>Logged in.</p>", contentType: "text/html; charset=utf-8" }),
      },
      answers,
    );
    const response = await fetch(`${base}/webhooks/x/a?k=v`, { method: "POST", body: "raw", headers: { "X-Thing": "1" } });
    expect(response.status).toBe(202);
    expect(seen).toEqual([{ headers: expect.objectContaining({ "x-thing": "1" }), query: "k=v", body: "raw", method: "POST" }]);
    expect(answers).toEqual([{ status: 202, text: "accepted", event }]);

    const page = await fetch(`${base}/oauth/callback?code=c`);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(await page.text()).toBe("<p>Logged in.</p>");
    expect(answers).toHaveLength(1);
  });

  it("answers 404 for a path no handler takes, and 500 when a handler fails", async () => {
    const base = await serve({ "/boom": () => Promise.reject(new Error("bad")) }, []);
    expect((await fetch(`${base}/nowhere`, { method: "POST" })).status).toBe(404);
    expect((await fetch(`${base}/boom`, { method: "POST" })).status).toBe(500);
    expect((await fetch(`${base}/`)).status).toBe(200);
  });
});
