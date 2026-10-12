import { describe, expect, it } from "vitest";
import { DAEMON_TOOL_PREFIX, lockDecision, lockHookAnswer } from "../src/agent/command-check.js";

describe("the lock and the daemon's tools", () => {
  it("approves every tool of the daemon's own server", () => {
    expect(DAEMON_TOOL_PREFIX).toBe("mcp__clots__");
    for (const name of ["rulebook_show", "rulebook_prefilter", "rulebook_guidance", "rulebook_standing", "send_from_template"]) {
      expect(lockDecision(`mcp__clots__${name}`, {})).toEqual({ ok: true });
      expect(lockHookAnswer(`mcp__clots__${name}`, {})).toEqual({});
    }
  });

  it("still refuses the tools of any other server", () => {
    expect(lockDecision("mcp__github__create_issue", {}).ok).toBe(false);
    expect(lockDecision("mcp__clotsx__rulebook_show", {}).ok).toBe(false);
    expect(lockHookAnswer("mcp__docs__create", {}).hookSpecificOutput?.permissionDecision).toBe("deny");
  });
});
