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
    expect(event!.repo).toBe(String(recording.payload.repository.full_name).toLowerCase());
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

  it("finds a review's ID in its link, and does not take a person for a bot", () => {
    const recording = JSON.parse(fs.readFileSync(`${DIR}/pull_request_review.submitted.json`, "utf8"));
    const event = normalizeGithub(recording.event, recording.delivery, recording.payload, 0)!;
    expect(reviewIdOf(event)).toBe(String(recording.payload.review.id));
    expect(event.automated).toBe(false);
  });
});
