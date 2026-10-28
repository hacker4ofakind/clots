import { describe, expect, it } from "vitest";
import type { ClotEvent } from "../src/events/types.js";
import { ROUTING_EFFORT, ROUTING_MODEL } from "../src/routing-call.js";
import { buildTriagePrompt, fallbackTriage, parseTriage, TRIAGE_EFFORT, TRIAGE_MODEL, TRIAGE_SYSTEM_PROMPT, type TriageInput } from "../src/triage.js";

const event: ClotEvent = {
  id: "d-1",
  source: "github",
  kind: "issue_opened",
  account: "github", place: "octo/widgets",
  actor: "someone",
  title: "Issue #7 opened: Login fails",
  body: "Steps to reproduce...",
  url: "https://github.com/octo/widgets/issues/7",
  ref: "7",
  subject: "issue:7",
  automated: false,
  outsider: false,
  receivedAt: 0,
};
const input: TriageInput = { event, guidance: "" };
const answer = { needsAction: true, message: "Someone reported that login fails.", urgent: false, suspicious: false };

describe("parseTriage", () => {
  it("accepts a complete answer, which has no relevance to a running turn", () => {
    expect(parseTriage({ ...answer, relevantNow: true }, input)).toEqual(answer);
  });

  it("puts the message on one line and falls back to the title when it is empty", () => {
    expect(parseTriage({ ...answer, message: "Login\nfails.\n" }, input).message).toBe("Login fails.");
    expect(parseTriage({ ...answer, message: "   " }, input).message).toBe("Issue #7 opened: Login fails");
  });

  it("delivers the event when the answer is missing or malformed", () => {
    expect(parseTriage(undefined, input)).toEqual(fallbackTriage(event));
    expect(parseTriage({ ...answer, urgent: "no" }, input)).toEqual(fallbackTriage(event));
    expect(fallbackTriage(event)).toEqual({ needsAction: true, message: "Issue #7 opened: Login fails", urgent: false, suspicious: false });
  });
});

describe("buildTriagePrompt", () => {
  it("includes the event and no conversation", () => {
    const prompt = buildTriagePrompt(input);
    expect(prompt).toContain("title: Issue #7 opened: Login fails");
    expect(prompt).not.toContain("<guidance>");
    expect(prompt).not.toContain("<conversation>");
  });

  it("includes the guidance when there is any", () => {
    expect(buildTriagePrompt({ ...input, guidance: "Ignore typo reports." })).toContain("<guidance>\nIgnore typo reports.\n</guidance>");
  });
});

describe("the triage prompt", () => {
  it("is about more than code, and names email as a carrier of instructions", () => {
    expect(TRIAGE_SYSTEM_PROMPT).toContain("payments");
    expect(TRIAGE_SYSTEM_PROMPT).toContain("Email is where such attempts most often come from.");
    expect(TRIAGE_SYSTEM_PROMPT).not.toContain("relevantNow");
  });
});

describe("models", () => {
  it("runs triage and the routing call on Haiku 5.5 at medium", () => {
    expect([TRIAGE_MODEL, TRIAGE_EFFORT]).toEqual(["claude-haiku-5-5", "medium"]);
    expect([ROUTING_MODEL, ROUTING_EFFORT]).toEqual(["claude-haiku-5-5", "medium"]);
  });
});
