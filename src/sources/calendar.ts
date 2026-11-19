import type { CalendarAccount } from "../config.js";
import { clip } from "../events/body.js";
import type { ClotEvent } from "../events/types.js";
import type { Store } from "../store.js";
import { dayKey, hhmm, longDay, shortDay, wallClock } from "../time.js";

/** One occurrence of an event: a single event, or one instance of a repeating one. */
export interface Occurrence {
  /** Google's event ID: an instance's own, so it names this occurrence; use it to read or change the event. */
  uid: string;
  /** The event's iCalendar UID, the same for every occurrence of a series. Reminders are keyed on it. */
  icalUid: string;
  title: string;
  start: Date;
  /** Where the occurrence started before it was moved; absent for one never moved. */
  originalStart?: Date;
  end: Date;
  allDay: boolean;
  location: string;
  description: string;
  organizer: string;
  /** Guests other than the organiser. */
  guests: string[];
  repeats: boolean;
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

/** The reminders due now: for each lead time, once the time before the start is within it, until the event starts. */
export function dueReminders(occurrences: Occurrence[], leadMinutes: number[], now: Date): { occurrence: Occurrence; lead: number }[] {
  const at = now.getTime();
  return occurrences.flatMap((occurrence) => leadMinutes.filter((lead) => occurrence.start.getTime() > at && occurrence.start.getTime() - lead * 60_000 <= at).map((lead) => ({ occurrence, lead })));
}

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
    // The iCalendar UID and the occurrence's original start, as before 2e, so a reminder made before the upgrade is not made again.
    id: `calendar:${account.account}:${o.icalUid}:${(o.originalStart ?? o.start).toISOString()}:${lead}m`,
    source: "calendar",
    account: account.account,
    kind: "reminder",
    place: account.account,
    actor: o.organizer || "calendar",
    title: `${o.title || "(no title)"} ${describeWhen(o, timeZone, new Date(receivedAt))}`,
    body: clip(lines.join("\n")),
    url: "",
    ref: o.icalUid,
    subject: `event:${o.icalUid}`,
    automated: false,
    // An invitation's text is its organiser's. An event with no organiser is one the user made.
    outsider: o.organizer !== "" && !own.includes(o.organizer.toLowerCase()),
    receivedAt,
  };
}

/** Where a calendar's occurrences come from: Composio's Google Calendar tools. */
export interface OccurrenceSource {
  /** The occurrences that overlap a range, in order of start. Throws when the calendar cannot be read. */
  list(from: Date, to: Date): Promise<Occurrence[]>;
}

export interface CalendarFeedDeps {
  account: CalendarAccount;
  /** The user's zone, for all-day events, and the words of a reminder. */
  timeZone: string;
  store: Store;
  /** Hands a stored reminder on. */
  deliver: (event: ClotEvent) => void;
  now: () => number;
  source: OccurrenceSource;
  /** The user's own addresses: an event organised from any other is an outsider's. */
  ownAddresses?: string[];
}

/** How far ahead the calendar is read, beyond the longest lead time. */
const READ_DAYS = 31;

/** One calendar: polled for reminders, and read for `calendar_list`. */
export class CalendarFeed {
  private latest?: { at: number; from: number; to: number; occurrences: Occurrence[] };

  constructor(private d: CalendarFeedDeps) {}

  /** One poll, for the supervisor: reads the coming days and makes the reminders that are due. Throws when the calendar cannot be read. */
  async poll(): Promise<void> {
    const now = this.d.now();
    const longest = Math.max(...this.d.account.leadMinutes);
    const coming = await this.read(now, now + READ_DAYS * 86_400_000 + longest * 60_000);
    const ahead = coming.filter((o) => o.start.getTime() < now + longest * 60_000 + 1).sort((a, b) => a.start.getTime() - b.start.getTime());
    for (const { occurrence, lead } of dueReminders(ahead, this.d.account.leadMinutes, new Date(now))) {
      const event = reminderEvent(this.d.account, occurrence, lead, now, this.d.timeZone, this.d.ownAddresses);
      if (this.d.store.insertEvent(event)) this.d.deliver(event);
    }
  }

  /** The occurrences in a range: from the last reading while it is younger than the poll interval and covers the range, else read again. */
  async list(from: Date, to: Date): Promise<Occurrence[]> {
    const l = this.latest;
    const fresh = l !== undefined && this.d.now() - l.at < this.d.account.pollMinutes * 60_000 && l.from <= from.getTime() && l.to >= to.getTime();
    const all = fresh ? l.occurrences : await this.read(from.getTime(), to.getTime());
    return all.filter((o) => o.start < to && o.end > from);
  }

  private async read(from: number, to: number): Promise<Occurrence[]> {
    const occurrences = await this.d.source.list(new Date(from), new Date(to));
    this.latest = { at: this.d.now(), from, to, occurrences };
    return occurrences;
  }
}
