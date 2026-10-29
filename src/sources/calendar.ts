import ICAL from "ical.js";
import type { CalendarAccount } from "../config.js";
import { clip } from "../events/body.js";
import type { ClotEvent } from "../events/types.js";
import type { Store } from "../store.js";

type IcalTime = InstanceType<typeof ICAL.Time>;
type IcalEvent = InstanceType<typeof ICAL.Event>;
type IcalComponent = InstanceType<typeof ICAL.Component>;

/** One occurrence of an event: a single event, or one instance of a repeating one. */
export interface Occurrence {
  /** The event's iCal UID, the same for every occurrence of a series. */
  uid: string;
  title: string;
  start: Date;
  end: Date;
  allDay: boolean;
  location: string;
  description: string;
  organizer: string;
  /** Guests other than the organiser. */
  guests: string[];
  repeats: boolean;
}

/** A zone's offset from UTC at an instant, in minutes. */
function offsetMinutes(at: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(at));
  const get = (type: string) => Number(parts.find((part) => part.type === type)!.value);
  return (Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second")) - at) / 60_000;
}

/** The instant at which a wall-clock time happens in a zone. */
export function wallClock(year: number, month: number, day: number, hour: number, minute: number, second: number, timeZone: string): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute, second);
  // Twice: the offset at the guess may differ from the offset at the answer, across a change of offset.
  let at = guess - offsetMinutes(guess, timeZone) * 60_000;
  at = guess - offsetMinutes(at, timeZone) * 60_000;
  return new Date(at);
}

function isZone(name: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

/** "2026-10-16" (midnight in the zone), "2026-10-16T14:00" (in the zone), or a time with Z or an offset. */
export function parseWhen(text: string, timeZone: string): Date | undefined {
  const local = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(text.trim());
  if (local) {
    const [, y, mo, d, h = "0", mi = "0", s = "0"] = local;
    return wallClock(Number(y), Number(mo), Number(d), Number(h), Number(mi), Number(s), timeZone);
  }
  const absolute = Date.parse(text);
  return /[zZ]|[+-]\d{2}:?\d{2}$/.test(text.trim()) && !Number.isNaN(absolute) ? new Date(absolute) : undefined;
}

/**
 * The instant of an iCal time. A time in UTC is that instant; a time with a time-zone ID (as
 * Google writes them) is that wall-clock time in that zone; a date or a floating time is in the
 * user's zone. The zones come from the system's own database, not the feed's VTIMEZONE blocks.
 */
function instant(time: IcalTime, zoneId: string | undefined, timeZone: string): Date {
  if (!time.isDate && (time.zone?.tzid === "UTC" || time.toString().endsWith("Z"))) return new Date(Date.UTC(time.year, time.month - 1, time.day, time.hour, time.minute, time.second));
  const zone = !time.isDate && zoneId !== undefined && isZone(zoneId) ? zoneId : timeZone;
  return wallClock(time.year, time.month, time.day, time.isDate ? 0 : time.hour, time.isDate ? 0 : time.minute, time.isDate ? 0 : time.second, zone);
}

const zoneOf = (component: IcalComponent, property: string): string | undefined => {
  const value = component.getFirstProperty(property)?.getParameter("tzid");
  return typeof value === "string" ? value : undefined;
};

const mailto = (value: unknown): string => String(value ?? "").replace(/^mailto:/i, "").toLowerCase();

function occurrence(event: IcalEvent, start: IcalTime, end: IcalTime, repeats: boolean, timeZone: string): Occurrence | undefined {
  const component = event.component;
  if (String(component.getFirstPropertyValue("status") ?? "").toUpperCase() === "CANCELLED") return undefined;
  const organizer = mailto(component.getFirstPropertyValue("organizer"));
  const guests = component
    .getAllProperties("attendee")
    .map((property) => mailto(property.getFirstValue()))
    .filter((address) => address !== "" && address !== organizer);
  const startZone = zoneOf(component, "dtstart");
  return {
    uid: event.uid,
    title: event.summary ?? "",
    start: instant(start, startZone, timeZone),
    end: instant(end, zoneOf(component, "dtend") ?? startZone, timeZone),
    allDay: start.isDate,
    location: event.location ?? "",
    description: event.description ?? "",
    organizer,
    guests,
    repeats,
  };
}

/** A calendar as read from its feed. */
export interface Feed {
  /** The occurrences that overlap a range, in order of start. */
  expand(from: Date, to: Date): Occurrence[];
}

/** The longest a series is followed, so a malformed one cannot run on for ever. */
const MAX_STEPS = 20_000;

export function parseFeed(ics: string, timeZone: string): Feed {
  const root = new ICAL.Component(ICAL.parse(ics));
  const series = new Map<string, IcalEvent>();
  const exceptions: IcalEvent[] = [];
  for (const component of root.getAllSubcomponents("vevent")) {
    const event = new ICAL.Event(component);
    if (event.isRecurrenceException()) exceptions.push(event);
    else series.set(event.uid, event);
  }
  for (const exception of exceptions) {
    try {
      series.get(exception.uid)?.relateException(exception);
    } catch {
      // An exception that does not fit its series is left out.
    }
  }
  return {
    expand(from, to) {
      const out: Occurrence[] = [];
      const keep = (found: Occurrence | undefined) => {
        if (found && found.start < to && found.end > from) out.push(found);
      };
      for (const event of series.values()) {
        if (!event.isRecurring()) {
          keep(occurrence(event, event.startDate, event.endDate, false, timeZone));
          continue;
        }
        const zone = zoneOf(event.component, "dtstart");
        const steps = event.iterator();
        let step = 0;
        for (let next = steps.next(); next && step < MAX_STEPS; next = steps.next(), step += 1) {
          if (instant(next, zone, timeZone) >= to) break;
          const details = event.getOccurrenceDetails(next);
          keep(occurrence(details.item, details.startDate, details.endDate, true, timeZone));
        }
      }
      return out.sort((a, b) => a.start.getTime() - b.start.getTime());
    },
  };
}

/** The reminders due now: for each lead time, once the time before the start is within it, until the event starts. */
export function dueReminders(occurrences: Occurrence[], leadMinutes: number[], now: Date): { occurrence: Occurrence; lead: number }[] {
  const at = now.getTime();
  return occurrences.flatMap((occurrence) => leadMinutes.filter((lead) => occurrence.start.getTime() > at && occurrence.start.getTime() - lead * 60_000 <= at).map((lead) => ({ occurrence, lead })));
}

const dayKey = (date: Date, timeZone: string) => new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
const hhmm = (date: Date, timeZone: string) => new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit" }).format(date);
const shortDay = (date: Date, timeZone: string) => new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "short", day: "numeric", month: "short" }).format(date).replace(",", "");
const longDay = (date: Date, timeZone: string) => new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "short", day: "numeric", month: "short", year: "numeric" }).format(date).replace(",", "");

/** "in 30 minutes", "today at 14:00", "tomorrow at 14:00", "on Fri 16 Oct at 14:00", or "... (all day)". */
export function describeWhen(o: Occurrence, timeZone: string, now: Date): string {
  const minutes = Math.round((o.start.getTime() - now.getTime()) / 60_000);
  if (!o.allDay && minutes >= 0 && minutes < 60) return `in ${minutes} minute${minutes === 1 ? "" : "s"}`;
  const day = dayKey(o.start, timeZone);
  const label = day === dayKey(now, timeZone) ? "today" : day === dayKey(new Date(now.getTime() + 86_400_000), timeZone) ? "tomorrow" : `on ${shortDay(o.start, timeZone)}`;
  return o.allDay ? `${label} (all day)` : `${label} at ${hhmm(o.start, timeZone)}`;
}

/** "Fri 16 Oct 2026, 14:00–15:00 (Europe/Zurich)", or "Sun 18 Oct 2026 (all day)". */
export function describeSpan(start: Date, end: Date, allDay: boolean, timeZone: string): string {
  return allDay ? `${longDay(start, timeZone)} (all day)` : `${longDay(start, timeZone)}, ${hhmm(start, timeZone)}–${hhmm(end, timeZone)} (${timeZone})`;
}

/** The web links in a text, each once, without trailing punctuation. */
export function linksIn(text: string): string[] {
  return [...new Set([...text.matchAll(/https?:\/\/[^\s<>"')]+/g)].map((m) => m[0].replace(/[.,;:!?]+$/, "")))];
}

/** A reminder as the common event. Its ID names the occurrence and the lead time, so it is made once. */
export function reminderEvent(account: CalendarAccount, o: Occurrence, lead: number, receivedAt: number, timeZone: string, ownAddresses: string[] = []): ClotEvent {
  const own = ownAddresses.map((address) => address.toLowerCase());
  const links = linksIn(`${o.location}\n${o.description}`);
  const lines = [
    `When: ${describeSpan(o.start, o.end, o.allDay, timeZone)}`,
    ...(o.location ? [`Where: ${o.location}`] : []),
    ...(o.organizer ? [`Organiser: ${o.organizer}`] : []),
    ...(o.guests.length > 0 ? [`Guests (${o.guests.length}): ${o.guests.join(", ")}`] : []),
    ...(o.repeats ? ["Repeats: yes"] : []),
    ...(links.length > 0 ? [`Links: ${links.join(", ")}`] : []),
    "",
    o.description.trim() || "(no description)",
  ];
  return {
    id: `calendar:${account.account}:${o.uid}:${o.start.toISOString()}:${lead}m`,
    source: "calendar",
    account: account.account,
    kind: "reminder",
    place: account.account,
    actor: o.organizer || "calendar",
    title: `${o.title || "(no title)"} ${describeWhen(o, timeZone, new Date(receivedAt))}`,
    body: clip(lines.join("\n")),
    url: "",
    ref: o.uid,
    subject: `event:${o.uid}`,
    automated: false,
    // An invitation's text is its organiser's. An event with no organiser is one the user made.
    outsider: o.organizer !== "" && !own.includes(o.organizer.toLowerCase()),
    receivedAt,
  };
}

export interface CalendarFeedDeps {
  account: CalendarAccount;
  /** The user's zone, for all-day events, floating times and the words of a reminder. */
  timeZone: string;
  store: Store;
  /** Hands a stored reminder on. */
  deliver: (event: ClotEvent) => void;
  now: () => number;
  fetchFn?: typeof fetch;
  /** The user's own addresses: an event organised from any other is an outsider's. */
  ownAddresses?: string[];
}

/** One calendar's feed: polled for reminders, and read for `calendar_list`. */
export class CalendarFeed {
  private latest?: { at: number; feed: Feed };

  constructor(private d: CalendarFeedDeps) {}

  /** One poll, for the supervisor: reads the feed and makes the reminders that are due. Throws when the feed cannot be read. */
  async poll(): Promise<void> {
    const feed = await this.read();
    const now = this.d.now();
    const longest = Math.max(...this.d.account.leadMinutes);
    const coming = feed.expand(new Date(now), new Date(now + longest * 60_000 + 1));
    for (const { occurrence, lead } of dueReminders(coming, this.d.account.leadMinutes, new Date(now))) {
      const event = reminderEvent(this.d.account, occurrence, lead, now, this.d.timeZone, this.d.ownAddresses);
      if (this.d.store.insertEvent(event)) this.d.deliver(event);
    }
  }

  /** The occurrences in a range, read again when the last reading is older than the poll interval. */
  async list(from: Date, to: Date): Promise<Occurrence[]> {
    const fresh = this.latest !== undefined && this.d.now() - this.latest.at < this.d.account.pollMinutes * 60_000;
    return (fresh ? this.latest!.feed : await this.read()).expand(from, to);
  }

  private async read(): Promise<Feed> {
    const response = await (this.d.fetchFn ?? fetch)(this.d.account.icalUrl);
    if (!response.ok) throw new Error(`the calendar feed answered ${response.status}`);
    const feed = parseFeed(await response.text(), this.d.timeZone);
    this.latest = { at: this.d.now(), feed };
    return feed;
  }
}
