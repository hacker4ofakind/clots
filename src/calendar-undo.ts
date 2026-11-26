import { describeCalEvent, isMissing, type CalEvent, type CalRequest, type CalResult } from "./sources/calendar-composio.js";
import type { Store } from "./store.js";

export interface CalendarUndoDeps {
  store: Store;
  /** Calls an account's calendar through Composio. */
  call(account: string, req: CalRequest): Promise<CalResult>;
  timeZone: string;
}

/** Answers `/calendar undo`: reverses a Clot's newest calendar change, one at a time per Clot. */
export class CalendarUndo {
  private chains = new Map<string, Promise<unknown>>();

  constructor(private d: CalendarUndoDeps) {}

  /** The user's zone, changed in the configuration. */
  setTimeZone(timeZone: string): void {
    this.d.timeZone = timeZone;
  }

  undo(clot: string): Promise<string> {
    const result = (this.chains.get(clot) ?? Promise.resolve()).then(() => this.undoOne(clot));
    this.chains.set(clot, result.catch(() => undefined));
    return result;
  }

  private async undoOne(clot: string): Promise<string> {
    const { store } = this.d;
    const change = store.latestCalendarChange(clot);
    // Marked before the calendar is called, so two quick undos reverse it once.
    if (!change || !store.claimCalendarChange(change.id)) return "Nothing to put back.";
    const before = change.before === null ? undefined : (JSON.parse(change.before) as CalEvent);
    const after = change.after === null ? undefined : (JSON.parse(change.after) as CalEvent);
    const describe = (event: CalEvent) => describeCalEvent(event, this.d.timeZone);
    let done: CalResult;
    let answer: (event: CalEvent) => string;
    if (change.op === "create") {
      done = await this.d.call(change.account, { action: "remove", uid: change.uid });
      answer = (event) => `Removed: ${describe(event)}.`;
    } else if (change.op === "update") {
      const b = before!;
      done = await this.d.call(change.account, { action: "update", uid: change.uid, title: b.title, start: b.start, end: b.end, allDay: b.allDay, description: b.description, location: b.location });
      answer = (event) => `Put back: ${describe(event)}.`;
    } else {
      const b = before!;
      // A removal whose answer was lost may not have happened: an event still there is not made twice.
      // One the calendar confirmed is gone needs no check.
      if (!change.confirmed) {
        const still = await this.d.call(change.account, { action: "check", uid: change.uid });
        if (still.ok) {
          store.deleteCalendarChange(change.id);
          return `Nothing to put back: ${describe(still.event)} is still in the calendar.`;
        }
        // Created again only once the calendar has said the event is not there; any other answer could hide it.
        if (!isMissing(still)) {
          store.releaseCalendarChange(change.id);
          return `Not undone just now: ${still.reason}. Nothing was changed; send the command again.`;
        }
      }
      done = await this.d.call(change.account, { action: "create", title: b.title, start: b.start, end: b.end, allDay: b.allDay, description: b.description, location: b.location });
      if (!done.ok) {
        // The kept copy is the only one left: it stays the next one to undo.
        store.releaseCalendarChange(change.id);
        return `Not undone: ${done.reason}. The copy of ${describe(b)} is kept; send the command again.`;
      }
      answer = (event) => `Put back: ${describe(event)}.\n(It is a new copy; links to the old event will not find it.)`;
    }
    if (!done.ok && !done.reached) {
      // The calendar could not be asked: it stays the next one to undo.
      store.releaseCalendarChange(change.id);
      return `Not undone just now: ${done.reason}. Nothing was changed; send the command again.`;
    }
    if (!done.ok) {
      store.deleteCalendarChange(change.id);
      return `Could not undo the change to ${describe(after ?? before!)}: ${done.reason}. It is skipped; send the command again to step further back.`;
    }
    // Kept as the state the undo left, for calendar_list: the feed can be hours behind.
    const left = JSON.stringify(done.event);
    if (change.op === "create") store.settleCalendarChange(change.id, { op: "remove", uid: change.uid, before: left, after: null, restored: true });
    else store.settleCalendarChange(change.id, { op: change.op === "update" ? "update" : "create", uid: done.event.uid, before: null, after: left, restored: true });
    return answer(done.event);
  }
}
