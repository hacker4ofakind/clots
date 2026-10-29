import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { normalizeGithub } from "../src/events/github.js";
import { reviewIdOf } from "../src/events/review-comments.js";

/** Real deliveries recorded in Task 1 with scripts/capture-webhooks.ts. */
const DIR = "tests/fixtures/github";
const WANTED = {
  "issues.opened": "issue_opened",
  "issue_comment.created": "comment",
  "pull_request_review.submitted": "review",
  "pull_request.opened": "pr_opened",
  "workflow_run.completed.failure": "ci_failed",
} as const;

describe("recorded GitHub deliveries", () => {
  it("has a recording for each of the five kinds", () => {
    const files = fs.existsSync(DIR) ? fs.readdirSync(DIR) : [];
    for (const name of Object.keys(WANTED)) expect(files).toContain(`${name}.json`);
  });

  it.each(Object.entries(WANTED))("turns %s into a %s event", (name, kind) => {
    const recording = JSON.parse(fs.readFileSync(`${DIR}/${name}.json`, "utf8"));
    const event = normalizeGithub(recording.event, recording.delivery, recording.payload, 0);
    expect(event).toBeDefined();
    expect(event).toMatchObject({ id: recording.delivery, source: "github", kind });
    expect(event!.place).toBe(String(recording.payload.repository.full_name).toLowerCase());
    expect(event!.actor).toBe(recording.payload.sender.login);
    expect(event!.title.length).toBeGreaterThan(10);
    expect(event!.url).toMatch(/^https:\/\/github\.com\//);
    expect(event!.ref).not.toBe("");
    expect(event!.subject).toMatch(/^(pr|issue|branch):.+/);
  });

  it("ties a failed CI run to its pull request, and marks it as automated", () => {
    const recording = JSON.parse(fs.readFileSync(`${DIR}/workflow_run.completed.failure.json`, "utf8"));
    const event = normalizeGithub(recording.event, recording.delivery, recording.payload, 0)!;
    expect(event.subject).toBe(`pr:${recording.payload.workflow_run.pull_requests[0].number}`);
    expect(event.automated).toBe(true);
  });

  it("marks an issue as an outsider's unless its author is the owner, a member or a collaborator", () => {
    const recording = JSON.parse(fs.readFileSync(`${DIR}/issues.opened.json`, "utf8"));
    const withAssociation = (association: string) => {
      const payload = { ...recording.payload, issue: { ...recording.payload.issue, author_association: association } };
      return normalizeGithub(recording.event, recording.delivery, payload, 0)!.outsider;
    };
    expect(withAssociation("NONE")).toBe(true);
    expect(withAssociation("CONTRIBUTOR")).toBe(true);
    expect(withAssociation("OWNER")).toBe(false);
    expect(withAssociation("COLLABORATOR")).toBe(false);
    expect(withAssociation("MEMBER")).toBe(false);
  });

  it("marks a pull request as an outsider's by its author's standing, as an issue", () => {
    const recording = JSON.parse(fs.readFileSync(`${DIR}/pull_request.opened.json`, "utf8"));
    const withAssociation = (association: string) => {
      const payload = { ...recording.payload, pull_request: { ...recording.payload.pull_request, author_association: association } };
      return normalizeGithub(recording.event, recording.delivery, payload, 0)!.outsider;
    };
    expect(withAssociation("NONE")).toBe(true);
    expect(withAssociation("COLLABORATOR")).toBe(false);
  });

  it("finds a review's ID in its link, and does not take a person for a bot", () => {
    const recording = JSON.parse(fs.readFileSync(`${DIR}/pull_request_review.submitted.json`, "utf8"));
    const event = normalizeGithub(recording.event, recording.delivery, recording.payload, 0)!;
    expect(reviewIdOf(event)).toBe(String(recording.payload.review.id));
    expect(event.automated).toBe(false);
  });
});
