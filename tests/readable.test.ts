import { describe, expect, it } from "vitest";
import { z } from "zod";
import { isSentence, readableIssue, readableText } from "@clots/ui-api-schemas";

const issueOf = (schema: z.ZodType, value: unknown) => {
  const result = schema.safeParse(value);
  if (result.success) throw new Error("expected a refusal");
  return result.error.issues[0]!;
};

describe("readableIssue", () => {
  it("words a validator's refusals as sentences for the field", () => {
    expect(readableIssue(issueOf(z.number().min(1), 0))).toBe("That must be at least 1.");
    expect(readableIssue(issueOf(z.number().max(100), 101))).toBe("That must be at most 100.");
    expect(readableIssue(issueOf(z.string().min(1), ""))).toBe("A value is needed.");
    expect(readableIssue(issueOf(z.number(), "x"))).toMatch(/isn't the kind of value/);
    expect(readableIssue(issueOf(z.url(), "nope"))).toBe("That isn't a valid web address.");
    expect(readableIssue(issueOf(z.email(), "nope"))).toBe("That isn't a valid email address.");
    expect(readableIssue(issueOf(z.number().int(), 1.5))).not.toMatch(/Invalid|expected|Too /);
  });

  it("keeps a sentence the schema's own author wrote", () => {
    expect(readableIssue(issueOf(z.string().refine(() => false, "Use letters and digits only."), "x"))).toBe("Use letters and digits only.");
  });
});

describe("what the daemon sends the UI is a sentence", () => {
  it("accepts the words the daemon wrote for people and refuses the ones it kept for itself", () => {
    for (const text of ["That Clot could not be found.", "That picture is larger than 5 MB.", "Write a message or add a picture first.", "Clots did not accept that request.", "Something went wrong. Try again in a moment."]) expect(isSentence(text)).toBe(true);
    for (const text of ["internal error", "unauthorized", "Failed with 500", "ECONNREFUSED", "Too small: expected number to be >=1"]) expect(isSentence(text)).toBe(false);
  });

  it("never lets a loader's or a library's own words through", () => {
    const fallback = "That could not be saved. Check it and try again.";
    expect(readableText("Unexpected token } in JSON at position 4", fallback)).toBe(fallback);
    expect(readableText("The configuration is not valid JSON at position 4", fallback)).toBe(fallback);
    expect(readableText("sources.composio.0.toolkit: Invalid input", fallback)).toBe(fallback);
    expect(readableText("A value is needed.", fallback)).toBe("A value is needed.");
  });
});
