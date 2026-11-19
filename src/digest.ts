import { standingNote } from "./agent/prompts.js";
import { mayRunUnderGate } from "./gates.js";
import { formatEvent } from "./events/format.js";
import type { ClotEvent } from "./events/types.js";
import type { InboxRow } from "./store.js";

/** The most events one digest turn holds. */
export const DIGEST_SIZE = 10;
/** An event's body is cut to this many characters in a digest. */
export const DIGEST_BODY = 1500;

export interface DrainPlan {
  /** The row to run now. */
  run?: InboxRow;
  /** Event rows the gate holds back, to be marked as waiting. */
  markGated: string[];
  /** The gate has lifted and two or more events waited: they are gathered, in chunks of at most DIGEST_SIZE, in order. */
  digest?: InboxRow[][];
  /** The gate has lifted and one event waited: it runs as an ordinary investigation. */
  ungate?: string[];
}

/**
 * Decides what a drain does with a Clot's pending rows, oldest first. While a gate holds, the first
 * row that may run does, and the event rows before it wait. Once no gate holds, the events that
 * waited are delivered together at the place of the first of them; anything that arrived before
 * that runs first.
 */
export function planDrain(rows: InboxRow[], holds: boolean): DrainPlan {
  if (holds) {
    const markGated: string[] = [];
    for (const row of rows) {
      if (mayRunUnderGate(row, row.urgent)) return { run: row, markGated };
      if (!row.gated) markGated.push(row.id);
    }
    return { markGated };
  }
  const first = rows[0];
  if (first === undefined || !first.gated) return { run: first, markGated: [] };
  const waiting = rows.filter((row) => row.gated && row.kind === "event");
  if (waiting.length < 2) return { run: first, markGated: [], ungate: waiting.map((row) => row.id) };
  const chunks: InboxRow[][] = [];
  for (let i = 0; i < waiting.length; i += DIGEST_SIZE) chunks.push(waiting.slice(i, i + DIGEST_SIZE));
  return { markGated: [], digest: chunks };
}

export interface DigestEntry {
  event: ClotEvent;
  /** Triage's one line. */
  message: string | null;
  /** The standing rules that match this event, with their text filled in. */
  standing: { name: string; text: string }[];
}

export const DIGEST_HEADER = "These events waited because usage was tight. Deal with each one: nothing to do, a reply, a choice, or work.";

/** One digest turn's text: every event in its own untrusted wrapper, with its arrival time, ID and triage line, and its standing rules. */
export function digestText(entries: DigestEntry[], timeZone: string): string {
  const time = (at: number) => new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit" }).format(new Date(at));
  const sections = entries.map(({ event, message, standing }, i) => {
    const clipped = event.body.length > DIGEST_BODY ? { ...event, body: `${event.body.slice(0, DIGEST_BODY)}\n[truncated]` } : event;
    const rules = standing.length === 0 ? "" : `
${standingNote(standing.map((rule) => ({ name: `${rule.name} (event ${event.id})`, text: rule.text })))}`;
    return `Event ${i + 1} of ${entries.length}, arrived ${time(event.receivedAt)}, id ${event.id}. Triage said: ${message ?? "(no triage line)"}\n${formatEvent(clipped, timeZone)}${rules}`;
  });
  return `${DIGEST_HEADER}\n\n${sections.join("\n\n")}`;
}
