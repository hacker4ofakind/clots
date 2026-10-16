import { describe, expect, it } from "vitest";
import type { ClotEvent } from "../src/events/types.js";
import { buildExplainerPrompt, fallbackExplanation } from "../src/explainer.js";
import { buildTriagePrompt, fallbackTriage, parseTriage, TRIAGE_SYSTEM_PROMPT, type TriageInput } from "../src/triage.js";

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
  receivedAt: 0,
};
const idle: TriageInput = { event, guidance: "", tail: null };
const busy: TriageInput = { event, guidance: "", tail: [{ role: "user", text: "fix the login page" }] };
const answer = { needsAction: true, message: "Someone reported that login fails.", urgent: false, suspicious: false, relevantNow: true };

describe("parseTriage", () => {
  it("accepts a complete answer", () => {
    expect(parseTriage(answer, busy)).toEqual(answer);
  });

  it("never reports relevance to a turn when none is running", () => {
    expect(parseTriage(answer, idle).relevantNow).toBe(false);
  });

  it("puts the message on one line and falls back to the title when it is empty", () => {
    expect(parseTriage({ ...answer, message: "Login\nfails.\n" }, busy).message).toBe("Login fails.");
    expect(parseTriage({ ...answer, message: "   " }, busy).message).toBe("Issue #7 opened: Login fails");
  });

  it("delivers the event when the answer is missing or malformed", () => {
    expect(parseTriage(undefined, busy)).toEqual(fallbackTriage(event));
    expect(parseTriage({ ...answer, urgent: "no" }, busy)).toEqual(fallbackTriage(event));
    expect(fallbackTriage(event)).toEqual({ needsAction: true, message: "Issue #7 opened: Login fails", urgent: false, suspicious: false, relevantNow: false });
  });
});

describe("buildTriagePrompt", () => {
  it("includes the event, and says the agent is idle when no turn is running", () => {
    const prompt = buildTriagePrompt(idle);
    expect(prompt).toContain("title: Issue #7 opened: Login fails");
    expect(prompt).toContain("The agent is idle.");
    expect(prompt).not.toContain("<guidance>");
    expect(prompt).not.toContain("<conversation>");
  });

  it("includes the guidance and the conversation when there are any", () => {
    const prompt = buildTriagePrompt({ ...busy, guidance: "Ignore typo reports." });
    expect(prompt).toContain("<guidance>\nIgnore typo reports.\n</guidance>");
    expect(prompt).toContain("<conversation>\nuser: fix the login page\n</conversation>");
  });
});

describe("explainer", () => {
  it("builds a prompt from the event, the first reading and the conversation", () => {
    const prompt = buildExplainerPrompt({ event, message: "Login fails.", tail: [{ role: "clot", text: "Editing login.ts" }] });
    expect(prompt).toContain("title: Issue #7 opened: Login fails");
    expect(prompt).toContain("A first reading of the event: Login fails.");
    expect(prompt).toContain("clot: Editing login.ts");
  });

  it("falls back to the bare facts", () => {
    expect(fallbackExplanation(event, "Login fails.")).toBe("Login fails.\nIssue #7 opened: Login fails\n<https://github.com/octo/widgets/issues/7>");
  });
});

describe("the triage prompt", () => {
  it("is about more than code, and names email as a carrier of instructions", () => {
    expect(TRIAGE_SYSTEM_PROMPT).toContain("payments");
    expect(TRIAGE_SYSTEM_PROMPT).toContain("Email is where such attempts most often come from.");
  });
});
