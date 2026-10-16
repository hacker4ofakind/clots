import { describe, expect, it } from "vitest";
import { calendarScript, describeScriptEvent } from "../src/sources/calendar-script.js";

const event = { uid: "a@google.com", title: "Demo", start: "2026-10-16T12:00:00.000Z", end: "2026-10-16T13:00:00.000Z", allDay: false, location: "", description: "", guests: 0, repeats: false };

function script(answer: Response | Error) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (answer instanceof Error) throw answer;
    return answer;
  }) as unknown as typeof fetch;
  return { calls, client: calendarScript({ url: "https://script.google.com/macros/s/x/exec", secret: "s3" }, fetchFn) };
}

describe("calendarScript", () => {
  it("posts the secret with the request, following Google's redirect, and reads the answer", async () => {
    const { calls, client } = script(Response.json({ ok: true, event }));
    expect(await client.call({ action: "check", uid: "a@google.com" })).toEqual({ ok: true, event });
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ secret: "s3", action: "check", uid: "a@google.com" });
    expect(calls[0].init).toMatchObject({ method: "POST", redirect: "follow" });
  });

  it("passes on the script's refusal, says when the answer is a web page, and when the script cannot be reached", async () => {
    expect(await script(Response.json({ ok: false, reason: "the event has guests, and changing it would notify them" })).client.call({ action: "remove", uid: "a" })).toEqual({ ok: false, reason: "the event has guests, and changing it would notify them", reached: true });
    expect(await script(new Response("<!DOCTYPE html><html>Sign in</html>")).client.call({ action: "check", uid: "a" })).toMatchObject({ ok: false, reached: true, reason: expect.stringContaining("web page") });
    expect(await script(new Error("ENOTFOUND")).client.call({ action: "check", uid: "a" })).toMatchObject({ ok: false, reached: false });
  });

  it("describes an event for the user", () => {
    expect(describeScriptEvent({ ...event, location: "Room 2", guests: 1 }, "Europe/Zurich")).toBe('"Demo", Fri 16 Oct 2026, 14:00–15:00 (Europe/Zurich), at Room 2, with 1 guest [id: a@google.com]');
  });
});
