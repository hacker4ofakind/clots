import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { ClotEvent } from "../src/events/types.js";
import { matchesPrefilter, parsePrefilter, parseRouting, parseRuleFile, parseStanding, problemText, Rulebook } from "../src/rulebook.js";

/** What the pipeline checks for a Clot: the global pre-filters, then the Clot's own. */
const isDroppedFor = (rulebook: Rulebook, clot: string, event: ClotEvent) => rulebook.dropsIn("global", event) || rulebook.dropsIn(clot, event);

const event: ClotEvent = {
  id: "d-1",
  source: "github",
  kind: "pr_opened",
  account: "github", place: "octo/widgets",
  actor: "dependabot[bot]",
  title: "Pull request #9 opened: Bump lodash from 4.17.20 to 4.17.21",
  body: "",
  url: "https://github.com/octo/widgets/pull/9",
  ref: "9",
  subject: "pr:9",
  automated: true,
  outsider: false,
  receivedAt: 0,
};

describe("parseRuleFile", () => {
  it("reads pre-filters and triage guidance", () => {
    const file = parseRuleFile('prefilters:\n  - actor: dependabot[bot]\n  - kind: comment\n    titleContains: "[bot]"\ntriage: Ignore typo reports.\n');
    expect(file).toMatchObject({ prefilters: [{ actor: "dependabot[bot]" }, { kind: "comment", titleContains: "[bot]" }], triage: ["Ignore typo reports."], standing: [], routing: [] });
  });

  it("treats an empty file, or one with only comments, as no rules", () => {
    expect(parseRuleFile("")).toMatchObject({ prefilters: [], triage: [], standing: [], routing: [] });
    expect(parseRuleFile("# nothing yet\n")).toMatchObject({ prefilters: [], triage: [], standing: [], routing: [] });
  });

  it("reads rules that name a source, an account and a place", () => {
    const file = parseRuleFile("prefilters:\n  - source: email\n    account: gmail\n    place: me+news@gmail.com\n");
    expect(file.prefilters).toEqual([{ source: "email", account: "gmail", place: "me+news@gmail.com" }]);
  });

  it("takes any kind when no source is named, and only that source's kinds when one is", () => {
    expect(() => parseRuleFile("prefilters:\n  - kind: payment_failed\n")).not.toThrow();
    expect(() => parseRuleFile("prefilters:\n  - kind: item_added\n")).not.toThrow();
    expect(() => parseRuleFile("prefilters:\n  - source: stripe\n    kind: payment_failed\n")).not.toThrow();
    expect(() => parseRuleFile("prefilters:\n  - source: stripe\n    kind: issue_opened\n")).toThrow();
    expect(() => parseRuleFile("prefilters:\n  - kind: batch\n")).toThrow();
    expect(() => parseRuleFile("prefilters:\n  - kind: Payment Failed\n")).toThrow();
    expect(() => parseRuleFile("prefilters:\n  - source: email\n    repo: octo/widgets\n")).toThrow();
  });

  it("reads watch recipes, with their defaults", () => {
    const file = parseRuleFile('watches:\n  - name: notion-feedback\n    server: notion\n    tool: search\n    arguments: { query: Feedback }\n    items: results\n    id: id\n    title: "{title}"\n');
    expect(file.watches).toEqual([{ name: "notion-feedback", server: "notion", tool: "search", arguments: { query: "Feedback" }, items: "results", id: "id", title: "{title}", ignore: [], every: 5, report: "added" }]);
    expect(() => parseRuleFile("watches:\n  - name: email\n    server: s\n    tool: t\n    items: x\n    id: id\n")).toThrow("built-in source");
    expect(() => parseRuleFile("watches:\n  - name: w\n    server: s\n    tool: t\n    items: x\n    id: id\n    every: 0\n")).toThrow();
  });

  it("reads routing rules", () => {
    const file = parseRuleFile("routing:\n  - source: email\n    place: nicholas+encryptify@tady.ch\n    clot: encryptify\n");
    expect(file.routing).toEqual([{ source: "email", place: "nicholas+encryptify@tady.ch", clot: "encryptify" }]);
    expect(() => parseRuleFile("routing:\n  - clot: encryptify\n")).toThrow();
    expect(() => parseRuleFile("routing:\n  - source: email\n")).toThrow();
    expect(parseRouting({ source: "linear", place: "ENC", clot: "home" })).toEqual({ source: "linear", place: "ENC", clot: "home" });
  });

  it("checks that a standing rule's way of sending fits its trigger's source", () => {
    const rule = (trigger: string, via: string) => `standing:\n  - name: ack\n    trigger: ${trigger}\n    via: ${via}\n    template: "Thanks."\n`;
    expect(() => parseRuleFile(rule("{ kind: issue_opened }", "github_comment"))).not.toThrow();
    expect(() => parseRuleFile(rule("{ source: email, kind: email }", "email_reply"))).not.toThrow();
    expect(() => parseRuleFile(rule("{ source: linear, kind: comment }", "linear_comment"))).not.toThrow();
    expect(() => parseRuleFile(rule("{ kind: email }", "email_reply"))).toThrow();
    expect(() => parseRuleFile(rule("{ source: email, kind: email }", "github_comment"))).toThrow();
    expect(() => parseRuleFile(rule("{ source: stripe, kind: payment_failed }", "github_comment"))).toThrow();
  });

  it("accepts {place} in a template, and {repo} as the same thing", () => {
    expect(() => parseStanding({ name: "a", trigger: { kind: "issue_opened" }, via: "github_comment", template: "In {place} and {repo}." })).not.toThrow();
  });

  it("reads triage guidance as a list of lines, and a single block of text as one line", () => {
    expect(parseRuleFile("triage:\n  - Typos need no action.\n  - Billing is urgent.\n").triage).toEqual(["Typos need no action.", "Billing is urgent."]);
    expect(parseRuleFile("triage: |\n  Typos need no action.\n  Billing is urgent.\n").triage).toEqual(["Typos need no action.\nBilling is urgent."]);
    expect(parseRuleFile('triage: ""\n').triage).toEqual([]);
  });

  it("reads a standing rule", () => {
    const file = parseRuleFile('standing:\n  - name: ack-issue\n    trigger: { kind: issue_opened, repo: octo/widgets }\n    via: github_comment\n    template: "Thanks, @{actor}. Re: {title} ({url})"\n');
    expect(file.standing).toEqual([{ name: "ack-issue", trigger: { kind: "issue_opened", repo: "octo/widgets" }, via: "github_comment", template: "Thanks, @{actor}. Re: {title} ({url})" }]);
  });

  it("rejects a standing rule with no kind, an unknown way of sending, an unknown field, a bad name, or a repeated name", () => {
    const rule = (overrides: string) => `standing:\n  - name: ack\n    trigger: { kind: issue_opened }\n    via: github_comment\n    template: "Thanks."\n${overrides}`;
    expect(() => parseRuleFile(rule(""))).not.toThrow();
    expect(() => parseRuleFile('standing:\n  - name: ack\n    trigger: { actor: someone }\n    via: github_comment\n    template: "Thanks."\n')).toThrow();
    expect(() => parseRuleFile('standing:\n  - name: ack\n    trigger: { kind: batch }\n    via: github_comment\n    template: "Thanks."\n')).toThrow();
    expect(() => parseRuleFile('standing:\n  - name: ack\n    trigger: { kind: issue_opened }\n    via: email\n    template: "Thanks."\n')).toThrow();
    expect(() => parseRuleFile('standing:\n  - name: ack\n    trigger: { kind: issue_opened }\n    via: github_comment\n    template: "Thanks, {username}."\n')).toThrow();
    expect(() => parseRuleFile('standing:\n  - name: Ack Issue\n    trigger: { kind: issue_opened }\n    via: github_comment\n    template: "Thanks."\n')).toThrow();
    expect(() => parseRuleFile(rule('  - name: ack\n    trigger: { kind: pr_opened }\n    via: github_comment\n    template: "Again."\n'))).toThrow();
  });

  it("rejects an unknown kind, an unknown field, a rule that names nothing, and broken YAML", () => {
    expect(() => parseRuleFile("prefilters:\n  - source: github\n    kind: push\n")).toThrow();
    expect(() => parseRuleFile("prefilters:\n  - author: someone\n")).toThrow();
    expect(() => parseRuleFile("prefilters:\n  - {}\n")).toThrow();
    expect(() => parseRuleFile("schedules: []\n")).toThrow();
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

  it("matches a repository, ignoring letter case", () => {
    expect(matchesPrefilter({ repo: "Octo/Widgets" }, event)).toBe(true);
    expect(matchesPrefilter({ repo: "octo/other", actor: "dependabot[bot]" }, event)).toBe(false);
  });

  it("matches the source, the account and the place, ignoring letter case", () => {
    const mail = { ...event, source: "email", account: "gmail", kind: "email", place: "me+shop@gmail.com" };
    expect(matchesPrefilter({ source: "Email", place: "ME+shop@gmail.com" }, mail)).toBe(true);
    expect(matchesPrefilter({ account: "tady" }, mail)).toBe(false);
    expect(matchesPrefilter({ source: "github" }, mail)).toBe(false);
    // repo means GitHub: an email whose place looks like a repository is not matched by it.
    expect(matchesPrefilter({ repo: "me+shop@gmail.com" }, mail)).toBe(false);
  });
});

describe("parsePrefilter and parseStanding", () => {
  it("accept what fits and throw on what does not, with a readable problem", () => {
    expect(parsePrefilter({ actor: "dependabot[bot]" })).toEqual({ actor: "dependabot[bot]" });
    expect(() => parsePrefilter({})).toThrow();
    expect(parseStanding({ name: "ack", trigger: { kind: "issue_opened" }, via: "github_comment", template: "Thanks." }).name).toBe("ack");
    let problem = "";
    try {
      parseStanding({ name: "ack", trigger: { kind: "issue_opened" }, via: "github_comment", template: "Hi {username}" });
    } catch (error) {
      problem = problemText(error);
    }
    expect(problem).toContain("{actor}");
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
    expect(isDroppedFor(rulebook, "graphite",event)).toBe(false);
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
    expect(isDroppedFor(rulebook, "graphite",event)).toBe(true);
    expect(isDroppedFor(rulebook, "other",event)).toBe(true);
    expect(isDroppedFor(rulebook, "graphite",{ ...event, actor: "someone", title: "WIP: try a cache" })).toBe(true);
    expect(isDroppedFor(rulebook, "other",{ ...event, actor: "someone", title: "WIP: try a cache" })).toBe(false);
    expect(rulebook.guidance("graphite")).toBe("Global guidance.\nGraphite guidance.");
    expect(rulebook.guidance("other")).toBe("Global guidance.");
  });

  it("gives the standing rules in force: the global ones, then the Clot's own, which win on a shared name", () => {
    const standing = (name: string, template: string) => `  - name: ${name}\n    trigger: { kind: issue_opened }\n    via: github_comment\n    template: "${template}"\n`;
    write("global.yaml", `standing:\n${standing("ack", "Global thanks.")}${standing("triaged", "Triaged.")}`);
    write("graphite.yaml", `standing:\n${standing("ack", "Graphite thanks.")}`);
    rulebook.load();
    expect(rulebook.standingFor("graphite").map((r) => [r.name, r.template])).toEqual([["triaged", "Triaged."], ["ack", "Graphite thanks."]]);
    expect(rulebook.standingFor("other").map((r) => r.template)).toEqual(["Global thanks.", "Triaged."]);
    expect(rulebook.file("graphite").standing).toHaveLength(1);
    expect(rulebook.pathOf("global")).toBe(path.join(dir, "global.yaml"));
  });

  it("keeps the last good version of a file that becomes invalid, and reports it once", () => {
    write("global.yaml", "prefilters:\n  - actor: dependabot[bot]\n");
    rulebook.load();
    write("global.yaml", "prefilters:\n  - source: github\n    kind: push\n");
    rulebook.load();
    rulebook.load();
    expect(isDroppedFor(rulebook, "graphite",event)).toBe(true);
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
    expect(isDroppedFor(rulebook, "graphite",event)).toBe(false);
  });

  it("gives every watch recipe with its file, binds a recipe by its file, and tells listeners after each load", () => {
    rulebook = new Rulebook(dir, ["graphite"], (file, problem) => invalid.push({ file, problem }));
    const watch = (name: string) => `watches:\n  - name: ${name}\n    server: s\n    tool: t\n    items: x\n    id: id\n`;
    write("global.yaml", watch("shared-one"));
    write("graphite.yaml", watch("mine"));
    let loads = 0;
    rulebook.onLoad(() => void (loads += 1));
    rulebook.load();
    expect(rulebook.watches().map((w) => [w.recipe.name, w.file])).toEqual([["shared-one", "global"], ["mine", "graphite"]]);
    expect(rulebook.recipeBinding("mine")).toEqual({ clot: "graphite" });
    expect(rulebook.recipeBinding("shared-one")).toBe("shared");
    expect(rulebook.recipeBinding("nothing")).toBeUndefined();
    expect(loads).toBe(1);
  });

  it("finds a webhook recipe by name and binds it by its file", () => {
    write("graphite.yaml", 'webhooks:\n  - name: tracker\n    verify: { scheme: token, header: X-Token, secret: RECIPE_TRACKER }\n    kinds: [{ kind: ping, when: {} }]\n    event: { title: "{t}" }\n');
    rulebook.load();
    expect(rulebook.webhook("tracker")?.verify.secret).toBe("RECIPE_TRACKER");
    expect(rulebook.recipeBinding("tracker")).toEqual({ clot: "graphite" });
    expect(rulebook.webhook("nothing")).toBeUndefined();
  });

  it("uses only the first of two recipes with one name, and says so", () => {
    const watch = (name: string) => `watches:\n  - name: ${name}\n    server: s\n    tool: t\n    items: x\n    id: id\n`;
    write("global.yaml", watch("same"));
    write("graphite.yaml", watch("same"));
    rulebook.load();
    expect(rulebook.watches().map((w) => w.file)).toEqual(["global"]);
    expect(invalid).toContainEqual({ file: "graphite.yaml", problem: 'the recipe "same" has the name of another recipe, so it is ignored' });
  });

  it("checks one file's pre-filters at a time", () => {
    write("global.yaml", "prefilters:\n  - actor: dependabot[bot]\n");
    write("graphite.yaml", "prefilters:\n  - titleContains: wip\n");
    rulebook.load();
    expect(rulebook.dropsIn("global", event)).toBe(true);
    expect(rulebook.dropsIn("graphite", event)).toBe(false);
    expect(rulebook.dropsIn("graphite", { ...event, title: "WIP: x" })).toBe(true);
  });

  it("gives the routing rules of the global file that name a Clot that exists, and reports the others once", () => {
    rulebook = new Rulebook(dir, ["home", "graphite"], (file, problem) => invalid.push({ file, problem }));
    write("global.yaml", "routing:\n  - place: a@x.ch\n    clot: graphite\n  - place: b@x.ch\n    clot: nobody\n  - place: c@x.ch\n    clot: home\n");
    write("graphite.yaml", "routing:\n  - place: d@x.ch\n    clot: graphite\n");
    rulebook.load();
    rulebook.load();
    expect(rulebook.routing().map((rule) => rule.place)).toEqual(["a@x.ch", "c@x.ch"]);
    expect(invalid).toEqual([
      { file: "global.yaml", problem: 'the routing rule for "nobody" names no Clot that exists, so it is ignored' },
      { file: "graphite.yaml", problem: "routing rules belong in global.yaml; the ones in this file are ignored" },
    ]);
  });
});
