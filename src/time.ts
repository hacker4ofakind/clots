/** Time-zone arithmetic, DST-safe: everything works from instants and the system's own zone database. */

export type Weekday = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";
export const WEEKDAYS: Weekday[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

/** A zone's offset from UTC at an instant, in minutes. */
export function offsetMinutes(at: number, timeZone: string): number {
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

export const dayKey = (date: Date, timeZone: string) => new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
export const hhmm = (date: Date, timeZone: string) => new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit" }).format(date);
export const shortDay = (date: Date, timeZone: string) => new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "short", day: "numeric", month: "short" }).format(date).replace(",", "");
export const longDay = (date: Date, timeZone: string) => new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "short", day: "numeric", month: "short", year: "numeric" }).format(date).replace(",", "");

/** The local calendar date and time of day of an instant. */
export function localParts(at: number, timeZone: string): { year: number; month: number; day: number; weekday: Weekday; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short" }).formatToParts(new Date(at));
  const get = (type: string) => parts.find((part) => part.type === type)!.value;
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    weekday: get("weekday").toLowerCase().slice(0, 3) as Weekday,
    minutes: Number(get("hour")) * 60 + Number(get("minute")),
  };
}

/** The instant at which the local day `days` days after the one containing `at` starts a given number of minutes in. */
export function localDayAt(at: number, days: number, minutes: number, timeZone: string): number {
  const p = localParts(at, timeZone);
  // A calendar date plus days, worked out in UTC where days are always 24 hours.
  const date = new Date(Date.UTC(p.year, p.month - 1, p.day + days));
  return wallClock(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), Math.floor(minutes / 60), minutes % 60, 0, timeZone).getTime();
}

/** The weekday `days` days after the one containing `at`. */
export function weekdayAfter(at: number, days: number, timeZone: string): Weekday {
  return WEEKDAYS[(WEEKDAYS.indexOf(localParts(at, timeZone).weekday) + days) % 7]!;
}

/** Monday 00:00 of the week containing `at`, in the zone. */
export function weekStart(at: number, timeZone: string): number {
  return localDayAt(at, -WEEKDAYS.indexOf(localParts(at, timeZone).weekday), 0, timeZone);
}

/** "18:00" when `at` is on the same local day as `now`, otherwise "Mon 10:00". */
export function clockLabel(at: number, now: number, timeZone: string): string {
  const time = hhmm(new Date(at), timeZone);
  if (dayKey(new Date(at), timeZone) === dayKey(new Date(now), timeZone)) return time;
  const weekday = new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "short" }).format(new Date(at));
  return `${weekday} ${time}`;
}
