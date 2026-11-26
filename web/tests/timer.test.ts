import { describe, expect, it } from "vitest";
import { countUrgent, timerView } from "@/lib/timer";

const MIN = 60_000;

describe("timerView", () => {
  it("is calm above five minutes, in minutes and hours", () => {
    expect(timerView(8 * MIN, 0)).toMatchObject({ state: "calm", text: "8m" });
    expect(timerView(130 * MIN, 0)).toMatchObject({ state: "calm", text: "2h 10m" });
    expect(timerView(120 * MIN, 0).text).toBe("2h");
  });
  it("is calling from five minutes to one", () => expect(timerView(3 * MIN, 0)).toMatchObject({ state: "calling", text: "3m" }));
  it("is urgent in the last minute, in seconds", () => expect(timerView(45_000, 0)).toMatchObject({ state: "urgent", text: "0:45" }));
  it("reads Closing… from the deadline until the daemon says it closed", () => {
    expect(timerView(1000, 1000)).toMatchObject({ state: "closing", text: "Closing…" });
    expect(timerView(1000, 90_000).state).toBe("closing");
  });
  it("counts the urgent asks", () => expect(countUrgent([{ deadline: 30_000 }, { deadline: 10 * MIN }], 0)).toBe(1));
});
