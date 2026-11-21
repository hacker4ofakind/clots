import { beforeEach, describe, expect, it } from "vitest";
import { Composio } from "../src/composio/component.js";
import { CALENDAR } from "../src/composio/toolkits/googlecalendar.js";
import type { CalendarAccount } from "../src/config.js";
import { Supervisor } from "../src/listeners.js";
import { CalendarFeed, describeWhen, dueReminders, linksIn, parseWhen, reminderEvent, type Occurrence } from "../src/sources/calendar.js";
import { calendarOverComposio, describeCalEvent, isMissing, isRecurring, toOccurrence } from "../src/sources/calendar-composio.js";
import { Store } from "../src/store.js";
import { wallClock } from "../src/time.js";
import { FakeComposioApi } from "./fake-composio.js";

const ZONE = "Europe/Zurich";
const account: CalendarAccount = { toolkit: "googlecalendar", account: "me", shared: true, audience: "private", triggers: [], leadMinutes: [1440], pollMinutes: 5 };
const at = (iso: string) => new Date(iso);
const zurich = (day: string, time: string) => ({ dateTime: `${day}T${time}:00+02:00`, timeZone: ZONE });

/** Events as Google's list answers them with singleEvents: a repeating event is its occurrences, each with its series' ID. */
const ITEMS: any[] = [
  { id: "demoid", iCalUID: "demo@google.com", status: "confirmed", summary: "Demo with ACME", location: "https://meet.google.com/abc-defg-hij", description: "Show the new export. Notes: https://docs.example.com/demo", organizer: { email: "me@gmail.com", self: true }, attendees: [{ email: "ann@acme.com" }, { email: "me@gmail.com", organizer: true, self: true }], start: zurich("2026-10-16", "14:00"), end: zurich("2026-10-16", "15:00") },
  { id: "standup_20261013T070000Z", iCalUID: "standup@google.com", recurringEventId: "standup", summary: "Standup", start: zurich("2026-10-13", "09:00"), end: zurich("2026-10-13", "09:15"), originalStartTime: zurich("2026-10-13", "09:00") },
  { id: "standup_20261016T070000Z", iCalUID: "standup@google.com", recurringEventId: "standup", summary: "Standup (moved)", start: zurich("2026-10-16", "10:00"), end: zurich("2026-10-16", "10:15"), originalStartTime: zurich("2026-10-16", "09:00") },
  { id: "standup_20261017T070000Z", iCalUID: "standup@google.com", recurringEventId: "standup", status: "cancelled", summary: "Standup", start: zurich("2026-10-17", "09:00"), end: zurich("2026-10-17", "09:15") },
  { id: "holidayid", iCalUID: "holiday@google.com", summary: "Day off", start: { date: "2026-10-18" }, end: { date: "2026-10-19" } },
  { id: "utcid", iCalUID: "utc@google.com", summary: "Call in UTC", start: { dateTime: "2026-10-16T16:00:00Z" }, end: { dateTime: "2026-10-16T16:30:00Z" } },
];
const occurrences = ITEMS.map((i) => toOccurrence(i, ZONE)).filter((o): o is Occurrence => o !== undefined);

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

describe("Google's events as occurrences", () => {
  it("gives a moved occurrence at its new time and keeps where it started, and leaves out a cancelled one", () => {
    expect(occurrences.map((o) => o.uid)).toEqual(["demoid", "standup_20261013T070000Z", "standup_20261016T070000Z", "holidayid", "utcid"]);
    const moved = occurrences.find((o) => o.title === "Standup (moved)")!;
    expect(moved).toMatchObject({ start: at("2026-10-16T08:00:00Z"), originalStart: at("2026-10-16T07:00:00Z"), repeats: true, icalUid: "standup@google.com" });
  });

  it("starts an all-day event at midnight in the user's zone, not in UTC", () => {
    expect(occurrences.find((o) => o.allDay)).toMatchObject({ title: "Day off", start: at("2026-10-17T22:00:00Z"), end: at("2026-10-18T22:00:00Z"), allDay: true });
  });

  it("counts as guests the attendees other than the organiser, and takes the organiser's address", () => {
    expect(occurrences[0]).toMatchObject({ organizer: "me@gmail.com", guests: ["ann@acme.com"], repeats: false });
    expect(occurrences[4]).toMatchObject({ organizer: "", guests: [] });
  });
});

describe("reminders", () => {
  const demo = occurrences[0];

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
    expect(describeWhen(occurrences[3], ZONE, at("2026-10-17T08:00:00Z"))).toBe("tomorrow (all day)");
  });

  it("are an outsider's when someone else organised the event", () => {
    const when = at("2026-10-15T12:30:00Z").getTime();
    expect(reminderEvent(account, demo, 1440, when, ZONE, ["Me@gmail.com"]).outsider).toBe(false);
    expect(reminderEvent(account, demo, 1440, when, ZONE, ["other@gmail.com"]).outsider).toBe(true);
    expect(reminderEvent(account, { ...demo, organizer: "" }, 1440, when, ZONE, []).outsider).toBe(false);
  });

  it("become one event per occurrence and lead time, with the iCalendar UID's ID that stage 2c made, and the details in the body", () => {
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

  it("name a moved occurrence by where it started, so a reminder made before it moved is not made again", () => {
    const moved = occurrences.find((o) => o.title === "Standup (moved)")!;
    expect(reminderEvent(account, moved, 1440, at("2026-10-15T12:30:00Z").getTime(), ZONE).id).toBe("calendar:me:standup@google.com:2026-10-16T07:00:00.000Z:1440m");
  });

  it("find links", () => {
    expect(linksIn("Join https://meet.google.com/x. Notes (https://d.example/y) and https://meet.google.com/x")).toEqual(["https://meet.google.com/x", "https://d.example/y"]);
  });
});

describe("CalendarFeed", () => {
  let store: Store;
  let delivered: string[];
  let now: number;
  let reads: { from: number; to: number }[];
  let failing = false;
  const source = {
    async list(from: Date, to: Date) {
      reads.push({ from: from.getTime(), to: to.getTime() });
      if (failing) throw new Error("the calendar could not be read");
      return occurrences.filter((o) => o.start < to && o.end > from).sort((a, b) => a.start.getTime() - b.start.getTime());
    },
  };
  const feed = () => new CalendarFeed({ account, timeZone: ZONE, store, deliver: (event) => void delivered.push(event.title), now: () => now, source });

  beforeEach(() => {
    store = new Store(":memory:");
    delivered = [];
    reads = [];
    failing = false;
    now = at("2026-10-15T12:30:00Z").getTime();
  });

  it("makes each reminder that is due once, however often it polls", async () => {
    const f = feed();
    await f.poll();
    await f.poll();
    expect(delivered).toEqual(["Standup (moved) tomorrow at 10:00", "Demo with ACME tomorrow at 14:00"]);
  });

  it("reads the coming 31 days and the longest lead time", async () => {
    await feed().poll();
    expect(reads[0].from).toBe(now);
    expect(reads[0].to).toBe(now + 31 * 86_400_000 + 1440 * 60_000);
  });

  it("makes at startup a reminder that came due while the daemon was down, if its event has not started", async () => {
    // The moved standup (08:00 UTC) has started; the demo starts in a minute; the UTC call is within its 24 hours.
    now = at("2026-10-16T11:59:00Z").getTime();
    await feed().poll();
    expect(delivered).toEqual(["Demo with ACME in 1 minute", "Call in UTC today at 18:00"]);
  });

  it("lists from the last reading while it is fresh and covers the range, and reads again when it is older, or the range is beyond it", async () => {
    const f = feed();
    await f.poll();
    expect(reads).toHaveLength(1);
    expect((await f.list(at("2026-10-16T00:00:00Z"), at("2026-10-17T00:00:00Z"))).map((o) => o.title)).toContain("Demo with ACME");
    expect(reads).toHaveLength(1);
    await f.list(at("2026-12-20T00:00:00Z"), at("2026-12-21T00:00:00Z"));
    expect(reads).toHaveLength(2);
    now += 6 * 60_000;
    await f.list(at("2026-12-20T00:00:00Z"), at("2026-12-21T00:00:00Z"));
    expect(reads).toHaveLength(3);
  });

  it("fails a poll when the calendar cannot be read, so the supervisor tries again", async () => {
    failing = true;
    await expect(feed().poll()).rejects.toThrow("could not be read");
  });
});

/** A small Google Calendar behind Composio's tools, keeping events by ID as Google answers them. */
function googleCalendar(api: FakeComposioApi, items: Record<string, any>) {
  const calls: { slug: string; args: any }[] = [];
  const failure = (status: number, message: string) => ({ ok: false as const, error: message, reason: (status >= 500 ? "unreachable" : "refused") as "unreachable" | "refused" });
  api.answers.set(CALENDAR.get, (args: any) => {
    calls.push({ slug: CALENDAR.get, args });
    return items[args.event_id] ? { ok: true, data: items[args.event_id] } : failure(404, "Not Found (404): the event could not be found");
  });
  api.answers.set(CALENDAR.create, (args: any) => {
    calls.push({ slug: CALENDAR.create, args });
    const id = `new${Object.keys(items).length}`;
    const start = args.start_date ? { date: args.start_date } : { dateTime: `${args.start_datetime}+02:00`, timeZone: args.timezone };
    const end = args.end_date ? { date: args.end_date } : { dateTime: `${args.end_datetime}+02:00`, timeZone: args.timezone };
    items[id] = { id, iCalUID: `${id}@google.com`, summary: args.summary, description: args.description, location: args.location, organizer: { email: "me@gmail.com", self: true }, start, end };
    return { ok: true, data: { response_data: items[id] } };
  });
  api.answers.set(CALENDAR.patch, (args: any) => {
    calls.push({ slug: CALENDAR.patch, args });
    const item = items[args.event_id];
    if (!item) return failure(404, "Not Found (404)");
    if (args.summary !== undefined) item.summary = args.summary;
    if (args.description !== undefined) item.description = args.description;
    if (args.location !== undefined) item.location = args.location;
    if (args.start_time !== undefined) item.start = /^\d{4}-\d{2}-\d{2}$/.test(args.start_time) ? { date: args.start_time } : { dateTime: args.start_time };
    if (args.end_time !== undefined) item.end = /^\d{4}-\d{2}-\d{2}$/.test(args.end_time) ? { date: args.end_time } : { dateTime: args.end_time };
    // Instances of a series follow it.
    for (const other of Object.values(items)) {
      if (other.recurringEventId === args.event_id) {
        if (args.summary !== undefined) other.summary = args.summary;
      }
    }
    return { ok: true, data: item };
  });
  api.answers.set(CALENDAR.delete, (args: any) => {
    calls.push({ slug: CALENDAR.delete, args });
    if (!items[args.event_id]) return failure(410, "Google returned 410 Gone: Resource has been deleted");
    items[args.event_id] = { ...items[args.event_id], status: "cancelled" };
    return { ok: true, data: {} };
  });
  api.answers.set(CALENDAR.list, (args: any) => {
    calls.push({ slug: CALENDAR.list, args });
    const all = Object.values(items);
    if (!args.pageToken) return { ok: true, data: { items: all.slice(0, 2), nextPageToken: "page2" } };
    return { ok: true, data: { items: all.slice(2) } };
  });
  return calls;
}

describe("the calendar over Composio", () => {
  let api: FakeComposioApi;
  let composio: Composio;
  let items: Record<string, any>;
  let calls: { slug: string; args: any }[];
  const cal = () => calendarOverComposio(composio, account, ZONE);

  beforeEach(async () => {
    api = new FakeComposioApi();
    composio = new Composio({ api, store: new Store(":memory:"), accounts: [account], publicUrl: "https://x.example", tell: async () => {}, tellHome: async () => {}, now: () => 0, schedule: () => () => {}, supervisor: new Supervisor({ schedule: () => () => {} }), log: () => {} });
    items = {
      demoid: { ...ITEMS[0] },
      standup: { id: "standup", iCalUID: "standup@google.com", summary: "Standup", recurrence: ["RRULE:FREQ=DAILY"], start: zurich("2026-10-13", "09:00"), end: zurich("2026-10-13", "09:15") },
      standup_20261016T070000Z: { ...ITEMS[2], summary: "Standup", start: zurich("2026-10-16", "09:00"), end: zurich("2026-10-16", "09:15") },
      solo: { id: "solo", iCalUID: "solo@google.com", summary: "Solo", start: zurich("2026-10-20", "11:00"), end: zurich("2026-10-20", "12:00"), organizer: { email: "me@gmail.com", self: true } },
      gone: { id: "gone", status: "cancelled", summary: "Gone", start: zurich("2026-10-21", "11:00"), end: zurich("2026-10-21", "12:00") },
    };
    calls = googleCalendar(api, items);
  });

  it("checks an event, and tells a removed one, or one that never was, from a calendar that could not be asked", async () => {
    const found = await cal().call({ action: "check", uid: "solo" });
    expect(found).toMatchObject({ ok: true, event: { uid: "solo", title: "Solo", guests: 0, repeats: false, allDay: false } });
    const cancelled = await cal().call({ action: "check", uid: "gone" });
    expect(cancelled).toMatchObject({ ok: false, reached: true, missing: true });
    expect(isMissing(cancelled)).toBe(true);
    expect(isMissing(await cal().call({ action: "check", uid: "never" }))).toBe(true);
    api.answers.set(CALENDAR.get, { ok: false, error: "fetch failed", reason: "unreachable" });
    const down = await cal().call({ action: "check", uid: "solo" });
    expect(down).toMatchObject({ ok: false, reached: false });
    expect(isMissing(down)).toBe(false);
  });

  it("refuses to read the calendar, remove or change an event, or take a created one, when an answer is not Google's shape, and never calls it a missing event", async () => {
    const drifted = { ok: true as const, data: { data: { id: "solo" } } };
    api.answers.set(CALENDAR.get, drifted);
    const check = await cal().call({ action: "check", uid: "solo" });
    expect(check).toMatchObject({ ok: false, reached: true, reason: expect.stringContaining("unexpected shape") });
    expect(isMissing(check)).toBe(false);
    expect(await cal().call({ action: "remove", uid: "solo" })).toMatchObject({ ok: false, reached: true });
    expect(await cal().call({ action: "update", uid: "solo", title: "x" })).toMatchObject({ ok: false, reached: true });
    expect(calls.filter((c) => c.slug === CALENDAR.delete || c.slug === CALENDAR.patch)).toEqual([]);

    api.answers.set(CALENDAR.create, { ok: true, data: { response_data: { summary: "no id" } } });
    expect(await cal().call({ action: "create", title: "x", start: "2026-11-25T07:00:00.000Z", end: "2026-11-25T08:00:00.000Z" })).toMatchObject({ ok: false, reason: expect.stringContaining("unexpected shape") });

    api.answers.set(CALENDAR.list, { ok: true, data: { events: [] } });
    await expect(cal().list(new Date("2026-10-01T00:00:00Z"), new Date("2026-11-01T00:00:00Z"))).rejects.toThrow(/could not be read.*unexpected shape/);
  });

  it("creates a timed event in the user's zone without a Meet link, without guests, and without telling anyone", async () => {
    const made = await cal().call({ action: "create", title: "Composio check", start: "2026-11-25T07:00:00.000Z", end: "2026-11-25T08:00:00.000Z", description: "d", location: "Room 2" });
    expect(calls.at(-1)!.args).toEqual({ calendar_id: "primary", summary: "Composio check", start_datetime: "2026-11-25T08:00:00", end_datetime: "2026-11-25T09:00:00", timezone: ZONE, description: "d", location: "Room 2", create_meeting_room: false, exclude_organizer: true, send_updates: "none" });
    expect(made).toMatchObject({ ok: true, event: { title: "Composio check", guests: 0, allDay: false } });
  });

  it("creates an all-day event by its dates in the user's zone", async () => {
    await cal().call({ action: "create", title: "Off", start: "2026-10-17T22:00:00.000Z", end: "2026-10-18T22:00:00.000Z", allDay: true });
    expect(calls.at(-1)!.args).toMatchObject({ start_date: "2026-10-18", end_date: "2026-10-19" });
    expect(calls.at(-1)!.args.start_datetime).toBeUndefined();
  });

  it("removes an event with no guests, and refuses one with guests and one of a series, as the script did", async () => {
    const removed = await cal().call({ action: "remove", uid: "solo" });
    expect(removed).toMatchObject({ ok: true, event: { uid: "solo" } });
    expect(calls.at(-1)).toEqual({ slug: CALENDAR.delete, args: { calendar_id: "primary", event_id: "solo", send_updates: "none" } });
    const withGuests = await cal().call({ action: "remove", uid: "demoid" });
    expect(withGuests).toMatchObject({ ok: false, reached: true, reason: expect.stringContaining("guests") });
    const series = await cal().call({ action: "remove", uid: "standup_20261016T070000Z" });
    expect(series).toMatchObject({ ok: false, reached: true, reason: expect.stringContaining("repeats") });
    expect(calls.filter((c) => c.slug === CALENDAR.delete)).toHaveLength(1);
    // A second removal finds it cancelled: it is missing, which is what an undo needs to know before it makes the event again.
    expect(isMissing(await cal().call({ action: "remove", uid: "solo" }))).toBe(true);
  });

  it("changes a single event's title and times", async () => {
    const changed = await cal().call({ action: "update", uid: "solo", title: "Solo 2", start: "2026-10-20T10:00:00.000Z", end: "2026-10-20T11:30:00.000Z" });
    expect(calls.find((c) => c.slug === CALENDAR.patch)!.args).toEqual({ calendar_id: "primary", event_id: "solo", send_updates: "none", timezone: ZONE, summary: "Solo 2", start_time: "2026-10-20T12:00:00+02:00", end_time: "2026-10-20T13:30:00+02:00" });
    expect(changed).toMatchObject({ ok: true, event: { uid: "solo", title: "Solo 2", start: "2026-10-20T10:00:00.000Z", end: "2026-10-20T11:30:00.000Z" } });
  });

  it("changes the series when it is told to change one of its occurrences, moving the series by the occurrence's own change", async () => {
    // The occurrence of 16 October moves from 09:00 to 10:00 and grows by 30 minutes: the series' 13 October 09:00 start becomes 10:00.
    const changed = await cal().call({ action: "update", uid: "standup_20261016T070000Z", start: "2026-10-16T08:00:00.000Z", end: "2026-10-16T08:45:00.000Z" });
    const patch = calls.find((c) => c.slug === CALENDAR.patch)!.args;
    expect(patch.event_id).toBe("standup");
    expect(patch.start_time).toBe("2026-10-13T10:00:00+02:00");
    expect(patch.end_time).toBe("2026-10-13T10:45:00+02:00");
    expect(changed.ok && isRecurring(changed.event)).toBe(true);
  });

  it("leaves the times alone when only the text changes, and changes a series' text through any occurrence", async () => {
    const changed = await cal().call({ action: "update", uid: "standup_20261016T070000Z", title: "Daily sync" });
    const patch = calls.find((c) => c.slug === CALENDAR.patch)!.args;
    expect(patch).toEqual({ calendar_id: "primary", event_id: "standup", send_updates: "none", timezone: ZONE, summary: "Daily sync" });
    expect(changed).toMatchObject({ ok: true, event: { title: "Daily sync", uid: "standup_20261016T070000Z" } });
  });

  it("changes an all-day event by its dates", async () => {
    items.off = { id: "off", iCalUID: "off@google.com", summary: "Off", start: { date: "2026-10-18" }, end: { date: "2026-10-19" } };
    await cal().call({ action: "update", uid: "off", start: "2026-10-18T22:00:00.000Z", end: "2026-10-19T22:00:00.000Z", allDay: true });
    expect(calls.find((c) => c.slug === CALENDAR.patch)!.args).toMatchObject({ start_time: "2026-10-19", end_time: "2026-10-20" });
  });

  it("refuses to change what is not there", async () => {
    const result = await cal().call({ action: "update", uid: "gone", title: "x" });
    expect(isMissing(result)).toBe(true);
    expect(calls.some((c) => c.slug === CALENDAR.patch)).toBe(false);
  });

  it("lists occurrences across pages, without the cancelled, oldest first", async () => {
    // With singleEvents Google answers a series by its occurrences, not by the series itself.
    delete items.standup;
    const list = await cal().list(at("2026-10-01T00:00:00Z"), at("2026-12-01T00:00:00Z"));
    expect(list.map((o) => o.uid)).toEqual(["standup_20261016T070000Z", "demoid", "solo"]);
    const asked = calls.filter((c) => c.slug === CALENDAR.list);
    expect(asked).toHaveLength(2);
    expect(asked[0].args).toMatchObject({ calendarId: "primary", singleEvents: true, maxResults: 2500, timeMin: "2026-10-01T00:00:00.000Z", timeMax: "2026-12-01T00:00:00.000Z", timeZone: ZONE });
    expect(asked[1].args.pageToken).toBe("page2");
  });

  it("fails a list when the calendar cannot be read", async () => {
    api.answers.set(CALENDAR.list, { ok: false, error: "fetch failed", reason: "unreachable" });
    await expect(cal().list(at("2026-10-01T00:00:00Z"), at("2026-10-02T00:00:00Z"))).rejects.toThrow("could not be read");
  });

  it("describes an event for the Clot, with its ID", () => {
    expect(describeCalEvent({ uid: "solo", title: "Solo", start: "2026-10-20T09:00:00.000Z", end: "2026-10-20T10:00:00.000Z", allDay: false, location: "Room 2", description: "", guests: 1, repeats: true }, ZONE)).toBe('"Solo", Tue 20 Oct 2026, 11:00–12:00 (Europe/Zurich), at Room 2, with 1 guest, repeats [id: solo]');
  });
});
