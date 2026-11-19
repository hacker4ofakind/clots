import { clockLabel, localDayAt, localParts, weekdayAfter, type Weekday } from "./time.js";

/** A window in minutes after local midnight: from `start` up to, not including, `end`. */
export interface Span {
  start: number;
  end: number;
}

export type Windows = Partial<Record<Weekday, Span>>;

export interface GateConfig {
  scarce: Windows;
  leadIn: Windows;
  leadInPercent: number;
}

/** One window of the account's usage: a percentage, when it resets (ms) and when it was read (ms). */
export interface Reading {
  percent: number;
  resetsAt: number;
  readAt: number;
}

export interface UsageSnapshot {
  fiveHour?: Reading;
  sevenDay?: Reading;
}

export interface GateState {
  holds: null | "scarce" | "leadIn";
  /** The earliest moment at which the gate would let an item run, when it holds. */
  until?: number;
  /** The five-hour utilization, when a lead-in holds. */
  percent?: number;
}

const WINDOW = /^(\d\d):(\d\d)-(\d\d):(\d\d)$/;

/** "15:00-18:00" as minutes after midnight, or a message saying what is wrong. */
export function parseSpan(text: string): Span | string {
  const m = WINDOW.exec(text);
  if (!m) return `"${text}" is not a window like 15:00-18:00`;
  const [h1, m1, h2, m2] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  if (h1 > 23 || h2 > 23 || m1 > 59 || m2 > 59) return `"${text}" is not a time of day`;
  const span = { start: h1 * 60 + m1, end: h2 * 60 + m2 };
  return span.start < span.end ? span : `"${text}" must start before it ends`;
}

/** Whether `now` is inside the weekday's window. A window starts and ends on the same day. */
function inWindows(now: number, windows: Windows, timeZone: string): boolean {
  const p = localParts(now, timeZone);
  const span = windows[p.weekday];
  return span !== undefined && p.minutes >= span.start && p.minutes < span.end;
}

export function inLeadIn(now: number, cfg: GateConfig, timeZone: string): boolean {
  return inWindows(now, cfg.leadIn, timeZone);
}

/** The reading counts only until its five-hour window resets. */
function validReading(usage: UsageSnapshot, at: number): Reading | undefined {
  const r = usage.fiveHour;
  return r !== undefined && at < r.resetsAt ? r : undefined;
}

function evaluate(now: number, cfg: GateConfig, timeZone: string, usage: UsageSnapshot): GateState {
  if (inWindows(now, cfg.scarce, timeZone)) return { holds: "scarce" };
  const reading = validReading(usage, now);
  if (inWindows(now, cfg.leadIn, timeZone) && reading !== undefined && reading.percent >= cfg.leadInPercent) return { holds: "leadIn", percent: reading.percent };
  return { holds: null };
}

/**
 * Every moment in the next days at which the answer could change: each window's start and end,
 * and the five-hour reset. The reading is assumed to stay as it is until then.
 */
function edges(now: number, cfg: GateConfig, timeZone: string, usage: UsageSnapshot): number[] {
  const times: number[] = [];
  for (let day = 0; day <= 8; day++) {
    const weekday = weekdayAfter(now, day, timeZone);
    for (const windows of [cfg.scarce, cfg.leadIn]) {
      const span = windows[weekday];
      if (span) times.push(localDayAt(now, day, span.start, timeZone), localDayAt(now, day, span.end, timeZone));
    }
  }
  if (usage.fiveHour) times.push(usage.fiveHour.resetsAt);
  return [...new Set(times.filter((t) => t > now))].sort((a, b) => a - b);
}

/** What the scarce and lead-in gates say at `now`. The usage-limit pause is the Clot's own and is not asked here. */
export function gateAt(now: number, cfg: GateConfig, timeZone: string, usage: UsageSnapshot): GateState {
  const state = evaluate(now, cfg, timeZone, usage);
  if (state.holds === null) return state;
  const lifts = edges(now, cfg, timeZone, usage).find((t) => evaluate(t, cfg, timeZone, usage).holds === null);
  return lifts === undefined ? state : { ...state, until: lifts };
}

/**
 * Whether an inbox row runs while a gate holds. The user's messages, workers' reports and choices
 * run; a digest only exists once its gate has lifted; a resume row continues a turn that was cut
 * off. An event runs when triage marked it urgent.
 */
export function mayRunUnderGate(row: { id: string; kind: "message" | "event" | "worker" | "choice" | "digest" }, urgent: boolean): boolean {
  if (row.id.startsWith("resume-")) return true;
  return row.kind === "event" ? urgent : true;
}

/** "scarce mode until 18:00" or "the five-hour window is at 54%". */
export function describeGate(g: GateState, timeZone: string, now: number): string {
  if (g.holds === "scarce") return g.until === undefined ? "scarce mode" : `scarce mode until ${clockLabel(g.until, now, timeZone)}`;
  if (g.holds === "leadIn") return `the five-hour window is at ${Math.round(g.percent ?? 0)}%`;
  return "none";
}

/** The text after "waiting": "until 18:00", or "until Mon 10:00" on another day. */
export function waitingUntil(g: GateState, timeZone: string, now: number): string {
  return g.until === undefined ? "" : ` (waiting until ${clockLabel(g.until, now, timeZone)})`;
}

