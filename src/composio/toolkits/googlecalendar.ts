import { z } from "zod";
import type { ToolkitDef } from "./index.js";

/** Composio's Google Calendar tools, confirmed live. No trigger is used: reminders count lead times that "event starting soon" cannot. */
export const CALENDAR = {
  list: "GOOGLECALENDAR_EVENTS_LIST",
  get: "GOOGLECALENDAR_EVENTS_GET",
  create: "GOOGLECALENDAR_CREATE_EVENT",
  patch: "GOOGLECALENDAR_PATCH_EVENT",
  delete: "GOOGLECALENDAR_DELETE_EVENT",
} as const;

const text = z.string().nullish();
const when = z.looseObject({ date: text, dateTime: text }).nullish();
/** One event as Google gives it. Only the ID is required (a cancelled one carries little else); the rest has the type the mapping assumes. */
export const CalendarItem = z.looseObject({
  id: z.string().min(1),
  status: text,
  summary: text,
  start: when,
  end: when,
  originalStartTime: when,
  recurringEventId: text,
  recurrence: z.array(z.string()).nullish(),
  attendees: z.array(z.looseObject({})).nullish(),
});

export const calendarDef: ToolkitDef = {
  toolkit: "googlecalendar",
  source: "calendar",
  async triggers() {
    return [];
  },
  // The patch and delete answers are not read: a patch is read back with `get`, and a delete is confirmed by the call succeeding.
  responseChecks: {
    [CALENDAR.list]: z.looseObject({ items: z.array(CalendarItem), nextPageToken: text }),
    [CALENDAR.get]: CalendarItem,
    // The created event, as Google gives it, either at the top or under `response_data`.
    [CALENDAR.create]: z.union([z.looseObject({ response_data: CalendarItem }), CalendarItem]),
  },
};
