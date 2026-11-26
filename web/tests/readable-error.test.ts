import { describe, expect, it } from "vitest";
import { ApiFailure } from "@/lib/api-client";
import { readableError } from "@/lib/readable-error";

const failure = (status: number, error: string) => new ApiFailure(status, { error });

describe("readableError", () => {
  it("passes on a sentence the daemon wrote for a person", () => {
    expect(readableError(failure(400, "There is a Clot named Home already."), "x")).toBe("There is a Clot named Home already.");
    expect(readableError(failure(409, "That file couldn't be read as an image. Try another one."), "x")).toContain("couldn't be read");
  });

  it("never shows codes, status lines, error names or stacks", () => {
    for (const raw of ["invalid request", "internal error", "no such icon", "Failed with 400", "TypeError: x is not a function", "Error: boom at file.ts:12:3", "network"]) {
      expect(readableError(failure(400, raw), "That could not be done.")).toBe("That could not be done.");
    }
    expect(readableError(new Error("Unexpected token <"), "That could not be done.")).toBe("That could not be done.");
    expect(readableError("oops", "That could not be done.")).toBe("That could not be done.");
  });

  it("says what kind of failure it was when the daemon had no words for it", () => {
    expect(readableError(new ApiFailure(0, { error: "network" }), "x")).toMatch(/can't be reached/);
    expect(readableError(new ApiFailure(502, null), "x")).toMatch(/can't be reached/);
    expect(readableError(new ApiFailure(403, null), "x")).toMatch(/isn't allowed/);
    expect(readableError(new ApiFailure(413, null), "x")).toMatch(/too large/);
    expect(readableError(failure(500, "Something exploded in the daemon."), "It did not work.")).toBe("It did not work.");
  });
});
