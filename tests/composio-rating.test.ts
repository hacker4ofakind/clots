import { describe, expect, it } from "vitest";
import { isDestructive, onFixedList, rateComposioCall, type Audience } from "../src/composio/rating.js";

/** Composio's own tag sets, as the live catalog gave them. */
const READ = ["readOnlyHint", "openWorldHint"];
const CREATE = ["createHint", "openWorldHint"];
const UPDATE = ["updateHint", "openWorldHint"];
const DESTRUCTIVE = ["destructiveHint", "openWorldHint"];
const NONE = ["openWorldHint", "important"];

const tool = (slug: string, tags: string[]) => ({ slug, toolkit: slug.split("_")[0].toLowerCase(), tags });
const rate = (slug: string, tags: string[], audience: Audience = "private", outsiderTurn = false, created: boolean | "unknown" = "unknown") => rateComposioCall(tool(slug, tags), audience, outsiderTurn, created);

describe("rateComposioCall", () => {
  it("runs a read in every audience and turn, and calls it a read", () => {
    for (const audience of ["private", "team", "public"] as const) {
      for (const outsiderTurn of [false, true]) expect(rate("LINEAR_GET_LINEAR_ISSUE", READ, audience, outsiderTurn)).toMatchObject({ rating: "run", reason: "it only reads" });
    }
    expect(rate("GMAIL_LIST_MESSAGES", READ, "public", true).rating).toBe("run");
    // The slug's own words never override a read tag: LIST_ARCHIVED is not an archive.
    expect(rate("LINEAR_LIST_ARCHIVED_ISSUES", READ, "public").rating).toBe("run");
  });

  it("runs a create-only tool in a private or team account, as an ordinary write", () => {
    expect(rate("LINEAR_CREATE_LINEAR_ISSUE", CREATE, "private").rating).toBe("run");
    expect(rate("LINEAR_CREATE_LINEAR_ISSUE", CREATE, "team").rating).toBe("run");
    expect(rate("LINEAR_UPDATE_ISSUE", UPDATE, "team").rating).toBe("run");
  });

  it("sends a public account's every write to the user, and says why", () => {
    expect(rate("LINEAR_CREATE_LINEAR_ISSUE", CREATE, "public")).toEqual({ rating: "ask", reason: "this account is public" });
    expect(rate("LINEAR_DELETE_LINEAR_ISSUE", UPDATE, "public").rating).toBe("ask");
  });

  it("sends a team account's destructive write, and its untagged write, to the reviewer", () => {
    expect(rate("NOTION_ARCHIVE_NOTION_PAGE", DESTRUCTIVE, "team")).toMatchObject({ rating: "review" });
    expect(rate("LINEAR_DELETE_LINEAR_ISSUE", UPDATE, "team").rating).toBe("review");
    expect(rate("SOME_WIDGET_FROB", NONE, "team").rating).toBe("review");
    expect(rate("NOTION_ARCHIVE_NOTION_PAGE", DESTRUCTIVE, "private").rating).toBe("run");
  });

  it("takes the worst of a read tag and a destructive tag", () => {
    expect(isDestructive(tool("X_GET_THING", [...READ, "destructiveHint"]))).toBe(true);
    expect(rate("X_GET_THING", [...READ, "destructiveHint"], "team").rating).toBe("review");
  });

  it("does not trust a read tag on a tool whose slug starts with a write", () => {
    // Composio tags these readOnlyHint; they create a query or a report.
    expect(rate("NOTION_CREATE_VIEW_QUERY", READ, "public").rating).toBe("ask");
    expect(rate("LINEAR_CREATE_ANYTHING", READ, "team").rating).toBe("run");
    expect(rate("NOTION_CREATE_VIEW_QUERY", READ, "private", true).rating).toBe("review");
    for (const verb of ["CREATE", "ADD", "UPDATE", "EDIT", "SET", "DELETE", "REMOVE", "ARCHIVE", "SEND", "POST", "INVITE", "SHARE", "PUBLISH", "MOVE", "MERGE", "CANCEL"]) {
      expect(rate(`X_${verb}_THING`, READ, "public").rating, verb).toBe("ask");
    }
  });

  it("rates a passthrough tool destructive, whatever its tags say", () => {
    for (const slug of ["LINEAR_RUN_QUERY_OR_MUTATION", "X_GRAPHQL", "X_PROXY_EXECUTE", "X_FETCH_RAW", "X_MAKE_REQUEST", "X_EXECUTE_THING", "COMPOSIO_MULTI_EXECUTE_TOOL", "COMPOSIO_SEARCH_TOOLS"]) {
      expect(isDestructive(tool(slug, READ)), slug).toBe(true);
      expect(rate(slug, READ, "team").rating, slug).toBe("review");
      expect(rate(slug, UPDATE, "public").rating, slug).toBe("ask");
    }
  });

  it("asks about the fixed list in every audience", () => {
    expect(rate("LINEAR_CREATE_WEBHOOK", CREATE, "private")).toMatchObject({ rating: "ask", reason: "it changes who or what can reach the workspace" });
    expect(rate("STRIPE_UPDATE_CUSTOMER", UPDATE, "private")).toMatchObject({ rating: "ask", reason: "it moves money" });
    expect(rate("STRIPE_CREATE_CUSTOMER", CREATE, "team").rating).toBe("ask");
    expect(rate("GMAIL_SEND_EMAIL", CREATE, "private")).toMatchObject({ rating: "ask", reason: "it reaches people outside the workspace" });
    expect(rate("SLACK_SEND_MESSAGE", CREATE, "team").rating).toBe("ask");
    expect(rate("NOTION_SHARE_PAGE", UPDATE, "private").rating).toBe("ask");
    expect(rate("X_CREATE_REFUND", CREATE, "private").rating).toBe("ask");
    expect(rate("X_UPDATE_ROLE", UPDATE, "private").rating).toBe("ask");
    expect(rate("X_CREATE_API_KEY", CREATE, "private").rating).toBe("ask");
  });

  it("does not ask about the fixed list for a read, or for a word that is only part of another", () => {
    expect(rate("STRIPE_RETRIEVE_CUSTOMER", READ, "public").rating).toBe("run");
    expect(rate("GMAIL_LIST_EMAILS", READ, "public").rating).toBe("run");
    expect(rate("LINEAR_CREATE_LINEAR_COMMENT", CREATE, "private").rating).toBe("run");
    expect(rate("LINEAR_CREATE_PROJECT_UPDATE", CREATE, "private").rating).toBe("run");
    expect(rate("X_CREATE_REMEMBER", CREATE, "private").rating).toBe("run");
  });

  it("matches slug words, not parts of words", () => {
    expect(isDestructive(tool("LINEAR_ARCHIVE_ISSUE", UPDATE))).toBe(true);
    expect(isDestructive(tool("LINEAR_ARCHIVED_ISSUES", UPDATE))).toBe(false);
    expect(isDestructive(tool("X_CANCELLATION_LIST", CREATE))).toBe(false);
    expect(onFixedList(tool("NOTION_SHARE_PAGE", UPDATE))).toBe("people");
    expect(onFixedList(tool("NOTION_SHAREPOINT_THING", UPDATE))).toBeUndefined();
    expect(onFixedList(tool("X_CREATE_INVOICES", CREATE))).toBe("money");
    expect(onFixedList(tool("X_GET_INVOICE", READ))).toBeUndefined();
    for (const word of ["DELETE", "ARCHIVE", "REMOVE", "REVOKE", "CANCEL", "REASSIGN", "TRANSFER"]) expect(isDestructive(tool(`X_${word}_Y`, CREATE)), word).toBe(true);
  });

  it("counts a tool with none of the four tags as destructive", () => {
    expect(isDestructive(tool("X_FROB_WIDGET", NONE))).toBe(true);
    expect(isDestructive(tool("X_FROB_WIDGET", CREATE))).toBe(false);
  });

  describe("in a turn an outsider's text started", () => {
    it("asks about a destructive write on something no Clot made, and for a deletion whose target is unknown", () => {
      for (const audience of ["private", "team"] as const) {
        expect(rate("LINEAR_DELETE_LINEAR_ISSUE", UPDATE, audience, true, false).rating).toBe("ask");
        expect(rate("LINEAR_DELETE_LINEAR_ISSUE", UPDATE, audience, true, "unknown").rating).toBe("ask");
      }
    });

    it("sends a destructive write on something a Clot made to the reviewer", () => {
      expect(rate("LINEAR_DELETE_LINEAR_ISSUE", UPDATE, "private", true, true)).toMatchObject({ rating: "review" });
      expect(rate("LINEAR_ARCHIVE_ISSUE", UPDATE, "team", true, true).rating).toBe("review");
    });

    it("sends every other write to the reviewer, even in a private account", () => {
      expect(rate("LINEAR_CREATE_LINEAR_ISSUE", CREATE, "private", true).rating).toBe("review");
      expect(rate("LINEAR_CREATE_LINEAR_ISSUE", CREATE, "team", true).rating).toBe("review");
      expect(rate("LINEAR_UPDATE_ISSUE", UPDATE, "team", true, true).rating).toBe("review");
    });

    it("still asks first for a public account, the fixed list, and still runs a read", () => {
      expect(rate("LINEAR_CREATE_LINEAR_ISSUE", CREATE, "public", true).reason).toBe("this account is public");
      expect(rate("STRIPE_UPDATE_CUSTOMER", UPDATE, "private", true).reason).toBe("it moves money");
      expect(rate("LINEAR_GET_LINEAR_ISSUE", READ, "private", true).rating).toBe("run");
    });
  });
});
