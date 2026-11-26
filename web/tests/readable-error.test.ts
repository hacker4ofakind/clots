import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ApiFailure } from "@/lib/api-client";
import { DAEMON_UNREACHABLE, readableBuildFailure, readableError, readableReason, readableReasons, readableText, TIMED_OUT } from "@/lib/readable-error";

const failure = (status: number, error: string) => new ApiFailure(status, { error });
const FALLBACK = "That could not be done.";

describe("readableError", () => {
  it("passes on a sentence the daemon wrote for a person", () => {
    expect(readableError(failure(400, "There is a Clot named Home already."), "x")).toBe("There is a Clot named Home already.");
    expect(readableError(failure(409, "That file isn't an image Clots can use. Use an SVG, PNG, JPG, WebP or ICO."), "x")).toContain("isn't an image");
    expect(readableError(failure(502, "Composio could not load the settings for Slack. Try again in a moment."), "x")).toContain("Composio could not load");
  });

  it("never shows codes, status lines, error names, stacks or a library's words", () => {
    for (const raw of ["invalid request", "internal error", "Failed with 400", "TypeError: x is not a function", "Error: boom at file.ts:12:3", "[object Object]", "undefined", "Too small: expected number to be >=1", "Invalid input: expected string, received number", "ECONNREFUSED 127.0.0.1:8787", '{"error":"x"}']) {
      const shown = readableError(failure(400, raw), FALLBACK);
      expect(shown).not.toBe(raw);
      expect(shown).not.toMatch(/Failed with|TypeError|ECONN|\{|undefined|object Object|Too small|Invalid input/);
    }
    expect(readableError(new Error("Unexpected token <"), FALLBACK)).toBe(FALLBACK);
    expect(readableError("oops", FALLBACK)).toBe(FALLBACK);
    expect(readableError(undefined, FALLBACK)).toBe(FALLBACK);
  });

  it("says what kind of failure it was, and what to do, for each status the daemon has no words for", () => {
    expect(readableError(new ApiFailure(0, { error: "network", code: "network" }), "x")).toBe(DAEMON_UNREACHABLE);
    expect(readableError(new ApiFailure(0, { error: "timeout", code: "timeout" }), "x")).toBe(TIMED_OUT);
    expect(readableError(new ApiFailure(502, { error: "The Clots daemon cannot be reached.", code: "daemon-unreachable" }), "x")).toBe(DAEMON_UNREACHABLE);
    expect(readableError(new ApiFailure(502, null), "x")).toMatch(/isn't answering/);
    expect(readableError(new ApiFailure(503, "<html>Service Unavailable</html>"), "x")).toMatch(/isn't answering/);
    expect(readableError(new ApiFailure(504, null), "x")).toBe(TIMED_OUT);
    expect(readableError(new ApiFailure(408, null), "x")).toBe(TIMED_OUT);
    expect(readableError(new ApiFailure(401, null), "x")).toMatch(/Reload it/);
    expect(readableError(new ApiFailure(403, null), "x")).toMatch(/isn't allowed/);
    expect(readableError(new ApiFailure(404, null), "That tool could not be removed.")).toBe("That tool could not be removed. It may already be gone. Reload the page.");
    expect(readableError(failure(409, "conflict"), "That could not be saved.")).toBe("That could not be saved. It changed while you were working. Reload the page and try again.");
    expect(readableError(new ApiFailure(413, null), "x")).toMatch(/too large/);
    expect(readableError(new ApiFailure(415, null), "x")).toMatch(/isn't supported/);
    expect(readableError(new ApiFailure(429, null), "x")).toMatch(/Too many tries/);
    expect(readableError(failure(500, "internal error"), "It did not work.")).toBe("It did not work.");
  });
});

describe("readableText", () => {
  it("shows a sentence and nothing raw", () => {
    expect(readableText("The sign-in was not finished in an hour.", "x")).toBe("The sign-in was not finished in an hour.");
    expect(readableText(undefined, "fallback")).toBe("fallback");
    expect(readableText(42, "fallback")).toBe("fallback");
    expect(readableText("at Object.<anonymous> (file.js:10:5)", "fallback")).toBe("fallback");
  });

  it("turns the failures Composio, GitHub, Docker, git and the network report into plain lines", () => {
    expect(readableText("getaddrinfo ENOTFOUND backend.composio.dev", "x")).toMatch(/connection failed/);
    expect(readableText("connect ECONNREFUSED 127.0.0.1:5432", "x")).toMatch(/connection failed/);
    expect(readableText("request timed out after 30000ms", "x")).toMatch(/too long/);
    expect(readableText("429 Too Many Requests", "x")).toMatch(/limiting requests/);
    expect(readableText("Request failed with status code 401: Invalid API key", "x")).toMatch(/did not accept the sign-in/);
    expect(readableText("403 Forbidden", "x")).toMatch(/isn't allowed to do that/);
    expect(readableText("502 Bad Gateway", "x")).toMatch(/having trouble/);
    expect(readableText("Cannot connect to the Docker daemon at unix:///var/run/docker.sock", "x")).toMatch(/Docker Desktop/);
    expect(readableText("fatal: could not read from remote repository", "x")).toMatch(/repository could not be downloaded/);
    expect(readableText("Too small: expected number to be >=1", "x")).toMatch(/isn't allowed/);
  });

  it("falls back to the caller's own sentence for text it does not know", () => {
    expect(readableText("the model is down", "The connection could not be made. Try again.")).toBe("The connection could not be made. Try again.");
  });
});

describe("readableReasons and readableReason", () => {
  it("joins the reasons that are sentences and drops the rest", () => {
    const error = new ApiFailure(400, { errors: { imap: "Enter the IMAP server.", smtp: "Too small: expected string" } });
    expect(readableReasons(error, FALLBACK)).toBe("Enter the IMAP server.");
    expect(readableReasons(new ApiFailure(400, { errors: ["bad"] }), FALLBACK)).toBe(FALLBACK);
    expect(readableReasons(new ApiFailure(0, { error: "network", code: "network" }), FALLBACK)).toBe(DAEMON_UNREACHABLE);
  });

  it("words a field's reason", () => {
    expect(readableReason("Write the repository as owner/name.")).toBe("Write the repository as owner/name.");
    expect(readableReason("Invalid input: expected number, received string")).not.toMatch(/Invalid input/);
    expect(readableReason(undefined)).toMatch(/isn't valid/);
  });
});

describe("readableBuildFailure", () => {
  it("says what to do for a failure the log shows, and points at the log otherwise", () => {
    expect(readableBuildFailure("Cannot connect to the Docker daemon at npipe:////./pipe/docker_engine")).toMatch(/Docker Desktop.*log below/);
    expect(readableBuildFailure("fatal: Authentication failed for 'https://github.com/o/r.git/'")).toMatch(/repository could not be downloaded/);
    expect(readableBuildFailure("npm ERR! code E404")).toBe("The build did not finish. The log below shows where it stopped.");
    expect(readableBuildFailure(undefined)).toBe("The build did not finish. The log below shows where it stopped.");
  });
});

/** The UI shows what a failure means through lib/readable-error only: none of these may put an exception's or a response's own text on screen. */
describe("no component shows a raw failure", () => {
  const root = path.resolve(__dirname, "..", "components");
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name)) files.push(full);
    }
  };
  walk(root);

  it("never reads an error's message, or prints an error, outside the readable layer", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const text = fs.readFileSync(file, "utf8");
      text.split("\n").forEach((line, i) => {
        if (/\b(e|err|error)\.message\b/.test(line) && !/IconUploadProblem/.test(line)) offenders.push(`${path.relative(root, file)}:${i + 1}: ${line.trim()}`);
        if (/String\((e|err|error|event\.data\.error)\)/.test(line)) offenders.push(`${path.relative(root, file)}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
