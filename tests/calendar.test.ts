import { beforeEach, describe, expect, it } from "vitest";
import type { CalendarAccount } from "../src/config.js";
import { CalendarFeed, describeWhen, dueReminders, linksIn, parseFeed, parseWhen, reminderEvent, wallClock, type Occurrence } from "../src/sources/calendar.js";
import { Store } from "../src/store.js";

const ZONE = "Europe/Zurich";
const ICS = [
  "BEGIN:VCALENDAR",
  "PRODID:-//Google Inc//Google Calendar 70.9054//EN",
  "VERSION:2.0",
  "X-WR-TIMEZONE:Europe/Zurich",
  "BEGIN:VEVENT",
  "DTSTART;TZID=Europe/Zurich:20261016T140000",
  "DTEND;TZID=Europe/Zurich:20261016T150000",
  "UID:demo@google.com",
  "SUMMARY:Demo with ACME",
  "LOCATION:https://meet.google.com/abc-defg-hij",
  "DESCRIPTION:Show the new export. Notes: https://docs.example.com/demo",
  "ORGANIZER;CN=Me:mailto:me@gmail.com",
  "ATTENDEE;CN=Ann:mailto:ann@acme.com",
  "ATTENDEE;CN=Me:mailto:me@gmail.com",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "DTSTART;TZID=Europe/Zurich:20261013T090000",
  "DTEND;TZID=Europe/Zurich:20261013T091500",
  "RRULE:FREQ=DAILY;COUNT=10",
  "EXDATE;TZID=Europe/Zurich:20261015T090000",
  "UID:standup@google.com",
  "SUMMARY:Standup",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "DTSTART;TZID=Europe/Zurich:20261016T100000",
  "DTEND;TZID=Europe/Zurich:20261016T101500",
  "RECURRENCE-ID;TZID=Europe/Zurich:20261016T090000",
  "UID:standup@google.com",
  "SUMMARY:Standup (moved)",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "DTSTART;TZID=Europe/Zurich:20261017T090000",
  "DTEND;TZID=Europe/Zurich:20261017T091500",
  "RECURRENCE-ID;TZID=Europe/Zurich:20261017T090000",
  "UID:standup@google.com",
  "STATUS:CANCELLED",
  "SUMMARY:Standup",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "DTSTART;VALUE=DATE:20261018",
  "DTEND;VALUE=DATE:20261019",
  "UID:holiday@google.com",
  "SUMMARY:Day off",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "DTSTART:20261016T160000Z",
  "DTEND:20261016T163000Z",
  "UID:utc@google.com",
  "SUMMARY:Call in UTC",
  "END:VEVENT",
  "END:VCALENDAR",
  "",
].join("\r\n");

const account: CalendarAccount = { account: "me", shared: true, icalUrl: "https://calendar.google.com/x.ics", leadMinutes: [1440], pollMinutes: 5 };
const at = (iso: string) => new Date(iso);

describe("times", () => {
  it("finds the instant of a wall-clock time in a zone, on both sides of a change of offset", () => {
    expect(wallClock(2026, 10, 16, 14, 0, 0, ZONE).toISOString()).toBe("2026-10-16T12:00:00.000Z");
    expect(wallClock(2026, 10, 26, 14, 0, 0, ZONE).toISOString()).toBe("2026-10-26T13:00:00.000Z");
  });

  it("reads a date, a local time and an absolute time", () => {
    expect(parseWhen("2026-10-16", ZONE)!.toISOString()).toBe("2026-10-15T22:00:00.000Z");
    expect(parseWhen("2026-10-16T14:00", ZONE)!.toISOString()).toBe("2026-10-16T12:00:00.000Z");
    expect(parseWhen("2026-10-16T14:00:00Z", ZONE)!.toISOString()).toBe("2026-10-16T14:00:00.000Z");
    expect(parseWhen("next week", ZONE)).toBeUndefined();
  });
});

describe("parseFeed", () => {
  const feed = parseFeed(ICS, ZONE);

  it("gives one day's occurrences in order, with a moved one at its new time", () => {
    const day = feed.expand(at("2026-10-16T00:00:00Z"), at("2026-10-17T00:00:00Z"));
    expect(day.map((o) => [o.title, o.start.toISOString()])).toEqual([
      ["Standup (moved)", "2026-10-16T08:00:00.000Z"],
      ["Demo with ACME", "2026-10-16T12:00:00.000Z"],
      ["Call in UTC", "2026-10-16T16:00:00.000Z"],
    ]);
    expect(day[1]).toMatchObject({ uid: "demo@google.com", end: at("2026-10-16T13:00:00Z"), allDay: false, organizer: "me@gmail.com", guests: ["ann@acme.com"], repeats: false });
    expect(day[0].repeats).toBe(true);
  });

  it("leaves out excluded and cancelled occurrences of a series", () => {
    const standups = feed.expand(at("2026-10-12T00:00:00Z"), at("2026-10-24T00:00:00Z")).filter((o) => o.uid === "standup@google.com");
    expect(standups.map((o) => o.start.toISOString().slice(0, 10))).toEqual(["2026-10-13", "2026-10-14", "2026-10-16", "2026-10-18", "2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22"]);
  });

  it("starts an all-day event at midnight in the user's zone", () => {
    const [holiday] = feed.expand(at("2026-10-18T00:00:00Z"), at("2026-10-19T00:00:00Z")).filter((o) => o.allDay);
    expect(holiday).toMatchObject({ title: "Day off", start: at("2026-10-17T22:00:00Z"), end: at("2026-10-18T22:00:00Z"), allDay: true });
  });
});

describe("reminders", () => {
  const feed = parseFeed(ICS, ZONE);
  const demo = feed.expand(at("2026-10-16T00:00:00Z"), at("2026-10-17T00:00:00Z")).find((o) => o.uid === "demo@google.com")!;

  it("are due once the time before the start is within the lead time, until the event starts", () => {
    expect(dueReminders([demo], [1440], at("2026-10-15T11:00:00Z"))).toEqual([]);
    expect(dueReminders([demo], [1440], at("2026-10-15T12:30:00Z"))).toEqual([{ occurrence: demo, lead: 1440 }]);
    expect(dueReminders([demo], [1440, 60], at("2026-10-16T11:30:00Z"))).toHaveLength(2);
    expect(dueReminders([demo], [1440], at("2026-10-16T12:00:00Z"))).toEqual([]);
  });

  it("say when, in words", () => {
    const now = at("2026-10-15T12:30:00Z");
    expect(describeWhen(demo, ZONE, now)).toBe("tomorrow at 14:00");
    expect(describeWhen(demo, ZONE, at("2026-10-16T08:00:00Z"))).toBe("today at 14:00");
    expect(describeWhen(demo, ZONE, at("2026-10-16T11:30:00Z"))).toBe("in 30 minutes");
    expect(describeWhen(demo, ZONE, at("2026-10-13T08:00:00Z"))).toBe("on Fri 16 Oct at 14:00");
    const holiday: Occurrence = { ...demo, allDay: true, start: at("2026-10-17T22:00:00Z"), end: at("2026-10-18T22:00:00Z") };
    expect(describeWhen(holiday, ZONE, at("2026-10-17T08:00:00Z"))).toBe("tomorrow (all day)");
  });

  it("become one event per occurrence and lead time, with the details in the body", () => {
    const event = reminderEvent(account, demo, 1440, at("2026-10-15T12:30:00Z").getTime(), ZONE);
    expect(event).toMatchObject({
      id: "calendar:me:demo@google.com:2026-10-16T12:00:00.000Z:1440m",
      source: "calendar",
      account: "me",
      kind: "reminder",
      place: "me",
      actor: "me@gmail.com",
      title: "Demo with ACME tomorrow at 14:00",
      url: "",
      ref: "demo@google.com",
      subject: "event:demo@google.com",
      automated: false,
    });
    expect(event.body).toContain("When: Fri 16 Oct 2026, 14:00–15:00 (Europe/Zurich)");
    expect(event.body).toContain("Guests (1): ann@acme.com");
    expect(event.body).toContain("Links: https://meet.google.com/abc-defg-hij, https://docs.example.com/demo");
    expect(event.body).toContain("Show the new export.");
  });

  it("find links", () => {
    expect(linksIn("Join https://meet.google.com/x. Notes (https://d.example/y) and https://meet.google.com/x")).toEqual(["https://meet.google.com/x", "https://d.example/y"]);
  });
});

describe("CalendarFeed", () => {
  let store: Store;
  let delivered: string[];
  let now: number;
  let fetches: number;
  const fetchFn = (async () => {
    fetches += 1;
    return new Response(ICS);
  }) as unknown as typeof fetch;
  const feed = () => new CalendarFeed({ account, timeZone: ZONE, store, deliver: (event) => void delivered.push(event.title), now: () => now, fetchFn });

  beforeEach(() => {
    store = new Store(":memory:");
    delivered = [];
    fetches = 0;
    now = at("2026-10-15T12:30:00Z").getTime();
  });

  it("makes each reminder that is due once, however often it polls", async () => {
    const f = feed();
    await f.poll();
    await f.poll();
    expect(delivered).toEqual(["Standup (moved) tomorrow at 10:00", "Demo with ACME tomorrow at 14:00"]);
  });

  it("makes at startup a reminder that came due while the daemon was down, if its event has not started", async () => {
    // The moved standup (08:00 UTC) has started; the demo starts in a minute; the UTC call is within its 24 hours.
    now = at("2026-10-16T11:59:00Z").getTime();
    await feed().poll();
    expect(delivered).toEqual(["Demo with ACME in 1 minute", "Call in UTC today at 18:00"]);
  });

  it("lists from the last reading while it is fresh, and reads again when it is not", async () => {
    const f = feed();
    await f.list(at("2026-10-16T00:00:00Z"), at("2026-10-17T00:00:00Z"));
    await f.list(at("2026-10-16T00:00:00Z"), at("2026-10-17T00:00:00Z"));
    expect(fetches).toBe(1);
    now += 6 * 60_000;
    expect((await f.list(at("2026-10-16T00:00:00Z"), at("2026-10-17T00:00:00Z"))).map((o) => o.title)).toContain("Demo with ACME");
    expect(fetches).toBe(2);
  });

  it("fails a poll when the feed cannot be read, so the supervisor tries again", async () => {
    const failing = new CalendarFeed({ account, timeZone: ZONE, store, deliver: () => undefined, now: () => now, fetchFn: (async () => new Response("no", { status: 404 })) as unknown as typeof fetch });
    await expect(failing.poll()).rejects.toThrow("404");
  });
});
