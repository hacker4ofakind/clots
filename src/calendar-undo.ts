import { describeScriptEvent, type ScriptEvent, type ScriptRequest, type ScriptResult } from "./sources/calendar-script.js";
import type { Store } from "./store.js";

export interface CalendarUndoDeps {
  store: Store;
  /** Calls an account's Apps Script. */
  call(account: string, req: ScriptRequest): Promise<ScriptResult>;
  timeZone: string;
}

/** Answers `&calendar undo`: reverses a Clot's newest calendar change, one at a time per Clot. */
export class CalendarUndo {
  private chains = new Map<string, Promise<unknown>>();

  constructor(private d: CalendarUndoDeps) {}

  undo(clot: string): Promise<string> {
    const result = (this.chains.get(clot) ?? Promise.resolve()).then(() => this.undoOne(clot));
    this.chains.set(clot, result.catch(() => undefined));
    return result;
  }

  private async undoOne(clot: string): Promise<string> {
    const { store } = this.d;
    const change = store.latestCalendarChange(clot);
    // Marked before the script is called, so two quick undos reverse it once.
    if (!change || !store.claimCalendarChange(change.id)) return "Nothing to put back.";
    const before = change.before === null ? undefined : (JSON.parse(change.before) as ScriptEvent);
    const after = change.after === null ? undefined : (JSON.parse(change.after) as ScriptEvent);
    const describe = (event: ScriptEvent) => describeScriptEvent(event, this.d.timeZone);
    let done: ScriptResult;
    let answer: (event: ScriptEvent) => string;
    if (change.op === "create") {
      done = await this.d.call(change.account, { action: "remove", uid: change.uid });
      answer = (event) => `Removed: ${describe(event)}.`;
    } else if (change.op === "update") {
      const b = before!;
      done = await this.d.call(change.account, { action: "update", uid: change.uid, title: b.title, start: b.start, end: b.end, allDay: b.allDay, description: b.description, location: b.location });
      answer = (event) => `Put back: ${describe(event)}.`;
    } else {
      const b = before!;
      done = await this.d.call(change.account, { action: "create", title: b.title, start: b.start, end: b.end, allDay: b.allDay, description: b.description, location: b.location });
      answer = (event) => `Put back: ${describe(event)}.\n(It is a new copy; links to the old event will not find it.)`;
    }
    if (!done.ok && !done.reached) {
      // The script could not be asked: it stays the next one to undo.
      store.releaseCalendarChange(change.id);
      return `Not undone just now: ${done.reason}. Nothing was changed; send the command again.`;
    }
    store.deleteCalendarChange(change.id);
    if (!done.ok) return `Could not undo the change to ${describe(after ?? before!)}: ${done.reason}. It is skipped; send the command again to step further back.`;
    return answer(done.event);
  }
}
