import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AskResult } from "@clots/ui-api-schemas";
import { AskOutcome } from "@/components/clots/ask-card";
import { endedOutcomes, type Item } from "@/components/clots/chat-items";

const html = (result?: AskResult) => renderToStaticMarkup(<AskOutcome text="Done." result={result} />);

/** Each result's icon is a different drawing, so the markup of each differs from every other. */
describe("an ended ask's icon", () => {
  const results: AskResult[] = ["approved", "declined", "timed_out", "failed", "feedback", "withdrawn"];

  it("is a different icon for every result, and says the result", () => {
    const drawn = results.map((r) => html(r).match(/<svg.*<\/svg>/)![0]);
    expect(new Set(drawn).size).toBe(results.length);
    for (const r of results) expect(html(r)).toContain(`data-ask-result="${r}"`);
  });

  it("keeps the check mark for a row closed before results were kept", () => {
    expect(html(undefined)).toContain('data-ask-result="approved"');
    expect(html(undefined).match(/<svg.*<\/svg>/)![0]).toBe(html("approved").match(/<svg.*<\/svg>/)![0]);
  });
});

describe("endedOutcomes", () => {
  const item = (id: number, ask?: Item["ask"]): Item => ({ message: { id: `m${id}`, kind: "ask", ref: String(id) } as Item["message"], ask });

  it("takes the result from the stream, then from the card the page carried, and leaves it absent for an old row", () => {
    const items = [item(1), item(2, { id: 2, state: "closed", outcome: "Declined.", result: "declined" }), item(3, { id: 3, state: "closed", outcome: "Old." })];
    const ended = endedOutcomes(items, { 1: { text: "Timed out.", result: "timed_out" } });
    expect(ended.get(1)).toEqual({ text: "Timed out.", result: "timed_out" });
    expect(ended.get(2)).toEqual({ text: "Declined.", result: "declined" });
    expect(ended.get(3)).toEqual({ text: "Old.", result: undefined });
  });
});
