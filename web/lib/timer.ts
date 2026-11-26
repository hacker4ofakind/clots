export type TimerState = "calm" | "calling" | "urgent" | "closing";

const MINUTE = 60_000;

/** What a countdown to an ask's deadline looks like at a moment: its state, and its text ("8m", "2h 10m", "0:45"). */
export function timerView(deadline: number, now: number): { state: TimerState; text: string; ms: number } {
  const ms = deadline - now;
  if (ms <= 0) return { state: "closing", text: "Closing…", ms };
  if (ms < MINUTE) {
    const seconds = Math.ceil(ms / 1000);
    return { state: "urgent", text: `0:${String(seconds).padStart(2, "0")}`, ms };
  }
  const minutes = Math.ceil(ms / MINUTE);
  const state = ms <= 5 * MINUTE ? "calling" : "calm";
  if (minutes < 60) return { state, text: `${minutes}m`, ms };
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return { state, text: rest === 0 ? `${hours}h` : `${hours}h ${rest}m`, ms };
}

/** How many asks of a list are urgent (under a minute left), for the summary line. */
export function countUrgent(asks: { deadline: number }[], now: number): number {
  return asks.filter((a) => a.deadline - now < MINUTE).length;
}
