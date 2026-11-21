import type { Composio } from "../composio/component.js";
import { CALENDAR } from "../composio/toolkits/googlecalendar.js";
import type { CalendarAccount } from "../config.js";
import { offsetMinutes, wallClock } from "../time.js";
import { describeSpan, type Occurrence } from "./calendar.js";

/** An event as Clots shows it and the tools change it. `uid` is Google's event ID (an occurrence's own, for one of a series). */
export interface CalEvent {
  uid: string;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  location: string;
  description: string;
  guests: number;
  repeats: boolean;
  /** Part of a series. */
  recurring?: boolean;
}

/** Whether an event is part of a series. */
export const isRecurring = (event: CalEvent) => event.recurring ?? event.repeats;

export type CalRequest =
  | { action: "create"; title: string; start: string; end: string; allDay?: boolean; description?: string; location?: string }
  | { action: "check"; uid: string }
  | { action: "remove"; uid: string }
  | { action: "update"; uid: string; title?: string; start?: string; end?: string; allDay?: boolean; description?: string; location?: string };

/** What the calendar answered. `reached` is false when it could not be asked: the same request may work later. */
export type CalResult = { ok: true; event: CalEvent } | { ok: false; reason: string; reached: boolean; missing?: true };

/** Whether the answer is that the event is not there, and nothing else went wrong. */
export const isMissing = (result: CalResult) => !result.ok && result.reached && result.missing === true;

/** '"Demo", Fri 16 Oct 2026, 14:00–15:00 (Europe/Zurich), at Room 2, with 1 guest [id: …]' */
export function describeCalEvent(event: CalEvent, timeZone: string): string {
  const parts = [`"${event.title}"`, describeSpan(new Date(event.start), new Date(event.end), event.allDay, timeZone)];
  if (event.location) parts.push(`at ${event.location}`);
  if (event.guests > 0) parts.push(`with ${event.guests} guest${event.guests === 1 ? "" : "s"}`);
  if (event.repeats) parts.push("repeats");
  return `${parts.join(", ")} [id: ${event.uid}]`;
}

/** The user's own calendar: the one the account signed in with. */
const PRIMARY = "primary";

const text = (value: unknown): string => (typeof value === "string" ? value : "");

/** The instant of one of Google's `start`/`end` objects: a date is midnight in the user's zone (never UTC, or it lands a day early east of it). */
function instantOf(when: any, timeZone: string): Date {
  if (typeof when?.dateTime === "string") return new Date(when.dateTime);
  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text(when?.date));
  if (!date) return new Date(Number.NaN);
  return wallClock(Number(date[1]), Number(date[2]), Number(date[3]), 0, 0, 0, timeZone);
}

const address = (value: unknown): string => text(value).toLowerCase();

/** The attendees that are guests: not the organiser, and not the user's own entry. */
function guestsOf(item: any): string[] {
  const organizer = address(item.organizer?.email);
  return (Array.isArray(item.attendees) ? item.attendees : [])
    .filter((a: any) => a?.self !== true && a?.organizer !== true && a?.resource !== true && address(a?.email) !== "" && address(a?.email) !== organizer)
    .map((a: any) => address(a.email));
}

const isRepeating = (item: any) => text(item.recurringEventId) !== "" || Array.isArray(item.recurrence);

/** One mapping from Google's JSON to an occurrence, used for listing. A cancelled item is not one. */
export function toOccurrence(item: any, timeZone: string): Occurrence | undefined {
  if (item?.status === "cancelled" || text(item?.id) === "") return undefined;
  const start = instantOf(item.start, timeZone);
  const end = instantOf(item.end, timeZone);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return undefined;
  const original = item.originalStartTime === undefined ? undefined : instantOf(item.originalStartTime, timeZone);
  return {
    uid: text(item.id),
    icalUid: text(item.iCalUID) || text(item.id),
    title: text(item.summary),
    start,
    ...(original !== undefined && !Number.isNaN(original.getTime()) ? { originalStart: original } : {}),
    end,
    allDay: typeof item.start?.date === "string",
    location: text(item.location),
    description: text(item.description),
    organizer: address(item.organizer?.email),
    guests: guestsOf(item),
    repeats: isRepeating(item),
  };
}

/** The same mapping for reading and changing one event. */
export function toCalEvent(item: any, timeZone: string): CalEvent | undefined {
  const o = toOccurrence(item, timeZone);
  return o && { uid: o.uid, title: o.title, start: o.start.toISOString(), end: o.end.toISOString(), allDay: o.allDay, location: o.location, description: o.description, guests: o.guests.length, repeats: o.repeats, recurring: o.repeats };
}

const pad = (n: number) => String(n).padStart(2, "0");

/** The wall-clock reading of an instant in a zone: "2026-11-25T09:00:00". */
function wall(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(at).replace(" ", "T");
}
const dateOf = (at: Date, timeZone: string) => wall(at, timeZone).slice(0, 10);
/** An instant as RFC 3339 in a zone: "2026-11-25T09:00:00+02:00". */
function rfc3339(at: Date, timeZone: string): string {
  const minutes = offsetMinutes(at.getTime(), timeZone);
  const sign = minutes < 0 ? "-" : "+";
  return `${wall(at, timeZone)}${sign}${pad(Math.floor(Math.abs(minutes) / 60))}:${pad(Math.abs(minutes) % 60)}`;
}

/** What a failed tool says when the event is not there: Google's 404 and 410. */
const NOT_THERE = /\b(404|410)\b|not found|has been deleted|gone/i;

/**
 * A Google Calendar over Composio's tools, on the account's own connection. `call` has the contract the
 * Apps Script had: `create`, `check`, `update` and `remove`, answering with the event or why not, and whether
 * the calendar could be asked (`reached`) or the event is simply not there (`missing`).
 */
export function calendarOverComposio(c: Composio, account: CalendarAccount, timeZone: string): { call(req: CalRequest): Promise<CalResult>; list(from: Date, to: Date): Promise<Occurrence[]> } {
  /** One tool call; a failure is told as `reached` (the calendar answered no) or not (it could not be asked). */
  async function tool(slug: string, args: Record<string, unknown>): Promise<{ ok: true; data: any } | Extract<CalResult, { ok: false }>> {
    const r = await c.runChecked(account, slug, args);
    if (r.ok) return r as { ok: true; data: any };
    // A shape that drifted is not "the event is not there": it is a refusal, and the daily check tells the user.
    const missing = r.reason === "refused" && r.drift !== true && NOT_THERE.test(r.error);
    return { ok: false, reason: missing ? "there is no event with that ID" : r.error, reached: r.reason === "refused", ...(missing ? { missing: true as const } : {}) };
  }

  /** An event by ID. A cancelled event is not there. */
  async function get(uid: string): Promise<{ ok: true; item: any } | Extract<CalResult, { ok: false }>> {
    const r = await tool(CALENDAR.get, { calendar_id: PRIMARY, event_id: uid });
    if (!r.ok) return r;
    if (r.data?.status === "cancelled") return { ok: false, reason: "there is no event with that ID (it was removed)", reached: true, missing: true };
    return { ok: true, item: r.data };
  }

  async function call(req: CalRequest): Promise<CalResult> {
    if (req.action === "check") {
      const found = await get(req.uid);
      if (!found.ok) return found;
      const event = toCalEvent(found.item, timeZone);
      return event ? { ok: true, event } : { ok: false, reason: "the calendar gave an event this daemon could not read", reached: true };
    }

    if (req.action === "create") {
      const start = new Date(req.start);
      const end = new Date(req.end);
      const when = req.allDay === true ? { start_date: dateOf(start, timeZone), end_date: dateOf(end, timeZone) } : { start_datetime: wall(start, timeZone), end_datetime: wall(end, timeZone), timezone: timeZone };
      // No Meet link, no guests (the organiser is not added as one), no notifications: what the Clots add is the user's own entry.
      const made = await tool(CALENDAR.create, { calendar_id: PRIMARY, summary: req.title, ...when, ...(req.description ? { description: req.description } : {}), ...(req.location ? { location: req.location } : {}), create_meeting_room: false, exclude_organizer: true, send_updates: "none" });
      if (!made.ok) return made;
      const event = toCalEvent(made.data?.response_data ?? made.data, timeZone);
      return event ? { ok: true, event } : { ok: false, reason: "the calendar did not describe the event it made", reached: true };
    }

    const found = await get(req.uid);
    if (!found.ok) return found;
    const current = toCalEvent(found.item, timeZone);
    if (!current) return { ok: false, reason: "the calendar gave an event this daemon could not read", reached: true };

    if (req.action === "remove") {
      // As the script did: never one with guests (they would be told), never one of a series (an undo could not bring it back).
      if (current.guests > 0) return { ok: false, reason: "the event has guests, and removing it would notify them", reached: true };
      if (isRecurring(current)) return { ok: false, reason: "the event repeats, and an undo could not bring the series back", reached: true };
      const gone = await tool(CALENDAR.delete, { calendar_id: PRIMARY, event_id: req.uid, send_updates: "none" });
      if (!gone.ok) return gone;
      return { ok: true, event: current };
    }

    // update. An occurrence of a series changes the series, as the script's did: its own times move the series by the same amount.
    const series = text(found.item.recurringEventId);
    let target = req.uid;
    let base = found.item;
    if (series !== "") {
      const master = await get(series);
      if (!master.ok) return master;
      target = series;
      base = master.item;
    }
    const patch: Record<string, unknown> = { calendar_id: PRIMARY, event_id: target, send_updates: "none", timezone: timeZone };
    if (req.title !== undefined) patch.summary = req.title;
    if (req.description !== undefined) patch.description = req.description;
    if (req.location !== undefined) patch.location = req.location;
    if (req.start !== undefined && req.end !== undefined) {
      const wantStart = new Date(req.start);
      const wantEnd = new Date(req.end);
      const allDay = req.allDay ?? typeof base.start?.date === "string";
      const curStart = new Date(current.start);
      const curEnd = new Date(current.end);
      const baseStart = instantOf(base.start, timeZone);
      const baseEnd = instantOf(base.end, timeZone);
      const newStart = series === "" ? wantStart : new Date(baseStart.getTime() + (wantStart.getTime() - curStart.getTime()));
      const newEnd = series === "" ? wantEnd : new Date(baseEnd.getTime() + (wantEnd.getTime() - curEnd.getTime()));
      patch.start_time = allDay ? dateOf(newStart, timeZone) : rfc3339(newStart, timeZone);
      patch.end_time = allDay ? dateOf(newEnd, timeZone) : rfc3339(newEnd, timeZone);
    }
    const changed = await tool(CALENDAR.patch, patch);
    if (!changed.ok) return changed;
    // Read back what the occurrence is now: a series' answer is its first occurrence, not the one the user meant.
    const after = await get(req.uid);
    if (!after.ok) return after;
    const event = toCalEvent(after.item, timeZone);
    return event ? { ok: true, event } : { ok: false, reason: "the calendar did not describe the event it changed", reached: true };
  }

  async function list(from: Date, to: Date): Promise<Occurrence[]> {
    const out: Occurrence[] = [];
    let token: string | undefined;
    do {
      const r = await tool(CALENDAR.list, { calendarId: PRIMARY, singleEvents: true, orderBy: "startTime", timeMin: from.toISOString(), timeMax: to.toISOString(), maxResults: 2500, timeZone, ...(token ? { pageToken: token } : {}) });
      if (!r.ok) throw new Error(`the calendar could not be read (${r.reason})`);
      for (const item of r.data?.items ?? []) {
        const o = toOccurrence(item, timeZone);
        if (o) out.push(o);
      }
      token = text(r.data?.nextPageToken) || undefined;
    } while (token);
    return out.sort((a, b) => a.start.getTime() - b.start.getTime());
  }

  return { call, list };
}
