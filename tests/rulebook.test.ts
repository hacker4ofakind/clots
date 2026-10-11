import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { ClotEvent } from "../src/events/types.js";
import { matchesPrefilter, parseRuleFile, Rulebook } from "../src/rulebook.js";

const event: ClotEvent = {
  id: "d-1",
  source: "github",
  kind: "pr_opened",
  repo: "octo/widgets",
  actor: "dependabot[bot]",
  title: "Pull request #9 opened: Bump lodash from 4.17.20 to 4.17.21",
  body: "",
  url: "https://github.com/octo/widgets/pull/9",
  ref: "9",
  subject: "pr:9",
  automated: true,
  receivedAt: 0,
};

describe("parseRuleFile", () => {
  it("reads pre-filters and triage guidance", () => {
    const file = parseRuleFile('prefilters:\n  - actor: dependabot[bot]\n  - kind: comment\n    titleContains: "[bot]"\ntriage: Ignore typo reports.\n');
    expect(file).toEqual({ prefilters: [{ actor: "dependabot[bot]" }, { kind: "comment", titleContains: "[bot]" }], triage: "Ignore typo reports." });
  });

  it("treats an empty file, or one with only comments, as no rules", () => {
    expect(parseRuleFile("")).toEqual({ prefilters: [], triage: "" });
    expect(parseRuleFile("# nothing yet\n")).toEqual({ prefilters: [], triage: "" });
  });

  it("rejects an unknown kind, an unknown field, a rule that names nothing, and broken YAML", () => {
    expect(() => parseRuleFile("prefilters:\n  - kind: push\n")).toThrow();
    expect(() => parseRuleFile("prefilters:\n  - author: someone\n")).toThrow();
    expect(() => parseRuleFile("prefilters:\n  - {}\n")).toThrow();
    expect(() => parseRuleFile("routing: []\n")).toThrow();
    expect(() => parseRuleFile("prefilters: [\n")).toThrow();
  });
});

describe("matchesPrefilter", () => {
  it("matches when every named field matches, ignoring letter case", () => {
    expect(matchesPrefilter({ actor: "Dependabot[bot]" }, event)).toBe(true);
    expect(matchesPrefilter({ kind: "pr_opened", titleContains: "BUMP" }, event)).toBe(true);
  });

  it("does not match when any named field differs", () => {
    expect(matchesPrefilter({ actor: "dependabot[bot]", kind: "comment" }, event)).toBe(false);
    expect(matchesPrefilter({ titleContains: "security" }, event)).toBe(false);
  });
});

describe("Rulebook", () => {
  let dir: string;
  let invalid: { file: string; problem: string }[];
  let rulebook: Rulebook;
  const write = (name: string, text: string) => fs.writeFileSync(path.join(dir, name), text);

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "clots-rulebook-"));
    invalid = [];
    rulebook = new Rulebook(dir, ["graphite"], (file, problem) => invalid.push({ file, problem }));
  });

  it("creates the folder's starter files, which load as no rules", () => {
    rulebook.ensure();
    rulebook.load();
    expect(fs.readdirSync(dir).filter((f) => f.endsWith(".yaml")).sort()).toEqual(["global.yaml", "graphite.yaml"]);
    expect(rulebook.isDropped("graphite", event)).toBe(false);
    expect(rulebook.guidance("graphite")).toBe("");
    expect(invalid).toEqual([]);
  });

  it("does not overwrite a file that is already there", () => {
    write("global.yaml", "triage: Mine.\n");
    rulebook.ensure();
    expect(fs.readFileSync(path.join(dir, "global.yaml"), "utf8")).toBe("triage: Mine.\n");
  });

  it("applies global rules to every Clot and a Clot's rules to that Clot only", () => {
    write("global.yaml", "prefilters:\n  - actor: dependabot[bot]\ntriage: Global guidance.\n");
    write("graphite.yaml", "prefilters:\n  - titleContains: wip\ntriage: Graphite guidance.\n");
    rulebook.load();
    expect(rulebook.isDropped("graphite", event)).toBe(true);
    expect(rulebook.isDropped("other", event)).toBe(true);
    expect(rulebook.isDropped("graphite", { ...event, actor: "someone", title: "WIP: try a cache" })).toBe(true);
    expect(rulebook.isDropped("other", { ...event, actor: "someone", title: "WIP: try a cache" })).toBe(false);
    expect(rulebook.guidance("graphite")).toBe("Global guidance.\n\nGraphite guidance.");
    expect(rulebook.guidance("other")).toBe("Global guidance.");
  });

  it("keeps the last good version of a file that becomes invalid, and reports it once", () => {
    write("global.yaml", "prefilters:\n  - actor: dependabot[bot]\n");
    rulebook.load();
    write("global.yaml", "prefilters:\n  - kind: push\n");
    rulebook.load();
    rulebook.load();
    expect(rulebook.isDropped("graphite", event)).toBe(true);
    expect(invalid).toHaveLength(1);
    expect(invalid[0].file).toBe("global.yaml");
  });

  it("picks up a corrected file, and reports a new problem again", () => {
    write("global.yaml", "prefilters: [\n");
    rulebook.load();
    write("global.yaml", "prefilters: []\n");
    rulebook.load();
    write("global.yaml", "prefilters:\n  - {}\n");
    rulebook.load();
    expect(invalid).toHaveLength(2);
    expect(rulebook.isDropped("graphite", event)).toBe(false);
  });
});
