import type { ToolkitDef } from "./index.js";

/** Composio's Google Calendar tools, confirmed live. No trigger is used: reminders count lead times that "event starting soon" cannot. */
export const CALENDAR = {
  list: "GOOGLECALENDAR_EVENTS_LIST",
  get: "GOOGLECALENDAR_EVENTS_GET",
  create: "GOOGLECALENDAR_CREATE_EVENT",
  patch: "GOOGLECALENDAR_PATCH_EVENT",
  delete: "GOOGLECALENDAR_DELETE_EVENT",
} as const;

export const calendarDef: ToolkitDef = {
  toolkit: "googlecalendar",
  source: "calendar",
  async triggers() {
    return [];
  },
};
