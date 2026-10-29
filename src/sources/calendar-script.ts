import { describeSpan } from "./calendar.js";

/** An event as the Apps Script describes it. */
export interface ScriptEvent {
  uid: string;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  location: string;
  description: string;
  guests: number;
  repeats: boolean;
  /** Part of a series. A script deployed before this field gives only `repeats`, which says the same. */
  recurring?: boolean;
}

/** Whether an event is part of a series. */
export const isRecurring = (event: ScriptEvent) => event.recurring ?? event.repeats;

export type ScriptRequest =
  | { action: "create"; title: string; start: string; end: string; allDay?: boolean; description?: string; location?: string }
  | { action: "check" | "remove"; uid: string }
  | { action: "update"; uid: string; title?: string; start?: string; end?: string; allDay?: boolean; description?: string; location?: string };

/** What the script answered. `reached` is false when it could not be asked: the same request may work later. */
export type ScriptResult = { ok: true; event: ScriptEvent } | { ok: false; reason: string; reached: boolean; missing?: true };

/** Whether the script answered that the event is not there, and nothing else went wrong. A script deployed before `missing` says it only in words. */
export const isMissing = (result: ScriptResult) => !result.ok && result.reached && (result.missing === true || result.reason.startsWith("there is no event with that ID"));

/**
 * The daemon's side of setup/calendar.gs. Apps Script cannot read a request's headers, so the
 * secret travels in the JSON body, over HTTPS. Google answers a web app's POST with a redirect to
 * where the answer is; it is followed.
 */
export function calendarScript(o: { url: string; secret: string }, fetchFn: typeof fetch = fetch): { call(req: ScriptRequest): Promise<ScriptResult> } {
  return {
    async call(req) {
      let text: string;
      try {
        const response = await fetchFn(o.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ secret: o.secret, ...req }), redirect: "follow" });
        text = await response.text();
      } catch (error) {
        return { ok: false, reason: `the calendar script could not be reached (${error instanceof Error ? error.message : String(error)})`, reached: false };
      }
      let answer: any;
      try {
        answer = JSON.parse(text);
      } catch {
        return { ok: false, reason: "the calendar script answered with a web page instead of an answer; its deployment must run as the user and be open to anyone", reached: true };
      }
      if (answer?.ok === true && typeof answer.event?.uid === "string") return { ok: true, event: answer.event as ScriptEvent };
      return { ok: false, reason: typeof answer?.reason === "string" ? answer.reason : "the calendar script gave no reason", reached: true, ...(answer?.missing === true ? { missing: true as const } : {}) };
    },
  };
}

/** '"Demo", Fri 16 Oct 2026, 14:00–15:00 (Europe/Zurich), at Room 2, with 1 guest [id: …]' */
export function describeScriptEvent(event: ScriptEvent, timeZone: string): string {
  const parts = [`"${event.title}"`, describeSpan(new Date(event.start), new Date(event.end), event.allDay, timeZone)];
  if (event.location) parts.push(`at ${event.location}`);
  if (event.guests > 0) parts.push(`with ${event.guests} guest${event.guests === 1 ? "" : "s"}`);
  if (event.repeats) parts.push("repeats");
  return `${parts.join(", ")} [id: ${event.uid}]`;
}
