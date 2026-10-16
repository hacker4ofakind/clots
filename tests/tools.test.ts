import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { SendResult } from "../src/events/github-comment.js";
import type { ClotEvent } from "../src/events/types.js";
import { RuleWriter } from "../src/rule-writer.js";
import { parseRuleFile, Rulebook } from "../src/rulebook.js";
import type { RuleEdit, RuleScope } from "../src/rulebook-edit.js";
import { Store } from "../src/store.js";
import { makeTools, mustPropose, showRules, type DaemonTools, type TurnContext, type TurnKind } from "../src/tools.js";

const Z = "​";

let dir: string;
let rulebook: Rulebook;
let store: Store;
let opened: { clot: string; scope: RuleScope; edit: RuleEdit }[];
let said: string[];
let sent: { event: string; text: string }[];
let sendAnswer: SendResult;
let steered: boolean;
let handed: { from: string; eventId: string; to: string }[];

function issue(overrides: Partial<ClotEvent> = {}): ClotEvent {
  return { id: "d-1", source: "github", kind: "issue_opened", account: "github", place: "octo/widgets", actor: "alice", title: "Issue #7 opened: Login fails", body: "", url: "https://github.com/octo/widgets/issues/7", ref: "7", subject: "issue:7", automated: false, receivedAt: 0, ...overrides };
}

function tools(kind: TurnKind, event?: ClotEvent): DaemonTools {
  const ctx: TurnContext = { clot: "graphite", kind, steered: () => steered, event };
  return makeTools(
    {
      rulebook,
      writer: new RuleWriter({ rulebook, store, commit: () => undefined }),
      proposals: {
        open: async (clot, scope, edit) => {
          opened.push({ clot, scope, edit });
          return "FILED";
        },
      },
      store,
      senders: {
        github_comment: {
          reach: (event) => (event.subject.startsWith("branch:") ? "this event is about a branch, not an issue or a pull request, so there is nowhere to send" : undefined),
          send: async (event, text) => {
            sent.push({ event: event.id, text });
            return sendAnswer;
          },
        },
      },
      say: async (_clot, text) => void said.push(text),
      handOver: async (from, eventId, to) => {
        handed.push({ from, eventId, to });
        return "HANDED";
      },
    },
    ctx,
  );
}

const own = () => parseRuleFile(fs.readFileSync(path.join(dir, "graphite.yaml"), "utf8"));

/** Puts standing rules in the Clot's own file. */
function standing(...rules: string[]): void {
  fs.writeFileSync(path.join(dir, "graphite.yaml"), `standing:\n${rules.join("")}`);
  rulebook.load();
}

const ACK = '  - name: ack-issue\n    trigger: { kind: issue_opened }\n    via: github_comment\n    template: "Thanks for the report, @{actor}. I am looking into it."\n';

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "clots-tools-"));
  rulebook = new Rulebook(dir, ["graphite"], () => undefined);
  rulebook.ensure();
  rulebook.load();
  store = new Store(":memory:");
  opened = [];
  said = [];
  sent = [];
  sendAnswer = { ok: true, url: "https://github.com/octo/widgets/issues/7#issuecomment-1" };
  steered = false;
  handed = [];
});

describe("mustPropose", () => {
  const ctx = (kind: TurnKind, joined = false): TurnContext => ({ clot: "graphite", kind, steered: () => joined });
  const prefilter: RuleEdit = { op: "add_prefilter", rule: { actor: "x" } };
  const line: RuleEdit = { op: "remove_guidance", line: "x" };
  const setStanding: RuleEdit = { op: "set_standing", rule: { name: "a", trigger: { kind: "issue_opened" }, via: "github_comment", template: "x" } };
  const removeStanding: RuleEdit = { op: "remove_standing", name: "a" };

  it("applies at once only a pre-filter or a triage line, in the Clot's own file, in a working turn no steered event has joined", () => {
    expect(mustPropose(ctx("work"), "own", prefilter)).toBe(false);
    expect(mustPropose(ctx("work"), "own", line)).toBe(false);
  });

  it("proposes everything else", () => {
    for (const edit of [prefilter, line]) {
      expect(mustPropose(ctx("work", true), "own", edit)).toBe(true);
      expect(mustPropose(ctx("brainstorm"), "own", edit)).toBe(true);
      expect(mustPropose(ctx("investigation"), "own", edit)).toBe(true);
      expect(mustPropose(ctx("work"), "global", edit)).toBe(true);
    }
    for (const edit of [setStanding, removeStanding]) {
      expect(mustPropose(ctx("work"), "own", edit)).toBe(true);
      expect(mustPropose(ctx("work"), "global", edit)).toBe(true);
    }
  });
});

describe("the rulebook tools", () => {
  it("apply an edit at once in a working turn, and the daemon tells the user", async () => {
    const reply = await tools("work").prefilter({ action: "add", file: "own", rule: { actor: "dependabot[bot]" } });
    expect(reply).toContain("Applied");
    expect(own().prefilters).toEqual([{ actor: "dependabot[bot]" }]);
    expect(said).toEqual(["Rule change in `graphite.yaml`: Drop events where actor is `dependabot[bot]`"]);
    expect(opened).toEqual([]);

    await tools("work").guidance({ action: "add", file: "own", line: "Billing is urgent." });
    await tools("work").prefilter({ action: "remove", file: "own", rule: { actor: "dependabot[bot]" } });
    expect(own()).toMatchObject({ prefilters: [], triage: ["Billing is urgent."] });
  });

  it("file a proposal instead in a locked turn, and once a steered event has joined the turn", async () => {
    expect(await tools("investigation", issue()).prefilter({ action: "add", file: "own", rule: { actor: "a" } })).toBe("FILED");
    expect(await tools("brainstorm").guidance({ action: "add", file: "own", line: "b" })).toBe("FILED");
    steered = true;
    expect(await tools("work").prefilter({ action: "add", file: "own", rule: { actor: "c" } })).toBe("FILED");
    expect(opened.map((p) => p.edit.op)).toEqual(["add_prefilter", "add_guidance", "add_prefilter"]);
    expect(own()).toMatchObject({ prefilters: [], triage: [] });
    expect(said).toEqual([]);
  });

  it("always file a proposal for the global file and for a standing rule", async () => {
    const t = tools("work");
    await t.guidance({ action: "add", file: "global", line: "x" });
    await t.standing({ action: "set", file: "own", name: "ack-issue", trigger: { kind: "issue_opened" }, template: "Thanks, @{actor}." });
    await t.standing({ action: "remove", file: "own", name: "ack-issue" });
    expect(opened).toEqual([
      { clot: "graphite", scope: "global", edit: { op: "add_guidance", line: "x" } },
      { clot: "graphite", scope: "own", edit: { op: "set_standing", rule: { name: "ack-issue", trigger: { kind: "issue_opened" }, via: "github_comment", template: "Thanks, @{actor}." } } },
      { clot: "graphite", scope: "own", edit: { op: "remove_standing", name: "ack-issue" } },
    ]);
  });

  it("say why an edit was not made", async () => {
    expect(await tools("work").prefilter({ action: "remove", file: "own", rule: { actor: "nobody" } })).toContain("Not applied: there is no such pre-filter");
    expect(await tools("work").standing({ action: "set", file: "own", name: "ack-issue" })).toContain("needs a trigger and a template");
    expect(said).toEqual([]);
  });

  it("show the rules in force and the open proposals", async () => {
    fs.writeFileSync(path.join(dir, "global.yaml"), "prefilters:\n  - actor: dependabot[bot]\ntriage:\n  - Billing is urgent.\n");
    standing(ACK);
    store.createProposal({ clot: "graphite", channelId: "ch-9", channelName: "graphite-rule", scope: "own", edit: "{}", summary: "Drop events where kind is `comment`\nmore" });
    const shown = await tools("work").show();
    expect(shown).toBe(showRules({ rulebook, store }, "graphite"));
    expect(shown).toContain("Rules in force for graphite");
    expect(shown).toContain("- [global] actor is `dependabot[bot]`");
    expect(shown).toContain("- [global] Billing is urgent.");
    expect(shown).toContain("- [graphite] `ack-issue`: when kind is `issue_opened`, send via github_comment:");
    expect(shown).toContain("- Drop events where kind is `comment`");
    expect(shown).not.toContain("more");
    expect(showRules({ rulebook, store }, "other")).toContain("Standing rules:\n- none");
  });
});

describe("send_from_template", () => {
  it("sends the filled-in template on the event's thread, records it, and shows the user", async () => {
    standing(ACK);
    const reply = await tools("investigation", issue()).send({ rule: "ack-issue" });
    expect(sent).toEqual([{ event: "d-1", text: "Thanks for the report, @alice. I am looking into it." }]);
    expect(reply).toContain("Sent");
    expect(said).toEqual(["Sent under standing rule `ack-issue`: Thanks for the report, @alice. I am looking into it. <https://github.com/octo/widgets/issues/7#issuecomment-1>"]);
    expect(store.hasSend("d-1", "ack-issue")).toBe(true);
  });

  it("accepts the Clot's wording within five words, and lets its words mention nobody", async () => {
    standing(ACK);
    await tools("investigation", issue()).send({ rule: "ack-issue", text: "Thanks for the report, @alice. I am looking into it now, @bob." });
    expect(sent[0].text).toBe(`Thanks for the report, @alice. I am looking into it now, @${Z}bob.`);
  });

  it("refuses outside an investigation, and for a rule that does not apply to this event", async () => {
    standing(ACK);
    expect(await tools("work").send({ rule: "ack-issue" })).toContain("Refused");
    expect(await tools("brainstorm").send({ rule: "ack-issue" })).toContain("Refused");
    expect(await tools("investigation", issue({ kind: "pr_opened", subject: "pr:7" })).send({ rule: "ack-issue" })).toContain('no standing rule named "ack-issue" applies');
    expect(await tools("investigation", issue()).send({ rule: "unknown" })).toContain("applies");
    expect(sent).toEqual([]);
  });

  it("refuses when the event has no thread, when the rule was already sent, and when too many words differ", async () => {
    standing(ACK, '  - name: ci-note\n    trigger: { kind: ci_failed }\n    via: github_comment\n    template: "Looking at the failure."\n');
    expect(await tools("investigation", issue({ kind: "ci_failed", subject: "branch:main" })).send({ rule: "ci-note" })).toContain("about a branch");

    const t = tools("investigation", issue());
    expect(await t.send({ rule: "ack-issue", text: "Hello there alice, we will get back to you soon." })).toContain("at most 5");
    expect(await t.send({ rule: "ack-issue", text: "x ".repeat(3000) })).toContain("too long");
    expect(sent).toEqual([]);
    await t.send({ rule: "ack-issue" });
    expect(await t.send({ rule: "ack-issue" })).toContain("already been sent");
    expect(sent).toHaveLength(1);
  });

  it("can be tried again after a definite refusal, and not after an uncertain failure", async () => {
    standing(ACK);
    const t = tools("investigation", issue());
    sendAnswer = { ok: false, refused: true, reason: "GitHub answered 403" };
    expect(await t.send({ rule: "ack-issue" })).toBe("Not sent: GitHub answered 403.");
    expect(store.hasSend("d-1", "ack-issue")).toBe(false);

    sendAnswer = { ok: false, refused: false, reason: "GitHub answered 502" };
    expect(await t.send({ rule: "ack-issue" })).toContain("may or may not have been posted");
    expect(await t.send({ rule: "ack-issue" })).toContain("already been sent");
    expect(said).toEqual([]);
  });

  it("matches a batch through its reports and fills the template from the one that matched", async () => {
    standing('  - name: rebase\n    trigger: { kind: pr_opened, actor: "dependabot[bot]" }\n    via: github_comment\n    template: "@{actor} rebase"\n');
    const part = (id: string, overrides: Partial<ClotEvent>) => issue({ id, ref: "14", subject: "pr:14", automated: true, ...overrides });
    store.insertEvent(part("d-2", { kind: "comment", actor: "vercel[bot]" }));
    store.insertEvent(part("d-3", { kind: "pr_opened", actor: "dependabot[bot]" }));
    const batch = part("batch:d-2", { kind: "batch", actor: "vercel[bot], dependabot[bot]" });
    store.recordRelease({ event: batch, clot: "graphite", isNew: true, absorbed: ["d-2", "d-3"] });

    await tools("investigation", batch).send({ rule: "rebase" });
    expect(sent).toEqual([{ event: "d-3", text: "@dependabot[bot] rebase" }]);
    expect(store.hasSend("batch:d-2", "rebase")).toBe(true);
  });
});

describe("routing tools", () => {
  it("always propose a routing rule, in the global file", async () => {
    const rule = { source: "email", place: "me+shop@gmail.com", clot: "graphite" };
    expect(await tools("work").routing({ action: "add", rule })).toBe("FILED");
    expect(opened).toEqual([{ clot: "graphite", scope: "global", edit: { op: "add_routing", rule } }]);
  });

  it("hand an event over only in a working turn", async () => {
    expect(await tools("work").routeCorrect({ event: "d-1", clot: "shop" })).toBe("HANDED");
    expect(handed).toEqual([{ from: "graphite", eventId: "d-1", to: "shop" }]);
    for (const kind of ["investigation", "brainstorm"] as const) expect(await tools(kind, issue()).routeCorrect({ event: "d-1", clot: "shop" })).toContain("Refused");
    expect(handed).toHaveLength(1);
  });
});

describe("email_draft", () => {
  const account = { account: "gmail", shared: true, address: "me@gmail.com", addresses: [], password: "p", imap: { host: "i", port: 993 }, smtp: { host: "s", port: 465 }, mailboxes: ["Clots"] };
  let saved: any[];
  const emailTools = (kind: TurnKind) => {
    saved = [];
    const t = makeTools(
      {
        rulebook,
        writer: new RuleWriter({ rulebook, store, commit: () => undefined }),
        proposals: { open: async () => "FILED" },
        store,
        senders: {},
        say: async (_clot, text) => void said.push(text),
        handOver: async () => "",
        email: {
          accounts: [account],
          save: async (_account, mail) => {
            saved.push(mail);
            return { mailbox: "[Gmail]/Drafts" };
          },
        },
      },
      { clot: "graphite", kind, steered: () => false },
    );
    return t.emailDraft!;
  };

  beforeEach(() => {
    store.insertEvent({ ...issue(), id: "email:gmail:<m2@x.com>", source: "email", account: "gmail", kind: "email", place: "me+shop@gmail.com", actor: "jane@x.com", title: "Order 7", ref: "<m2@x.com>", subject: "thread:<m2@x.com>" });
    store.setEventClot("email:gmail:<m2@x.com>", "graphite");
    store.setState("email-meta:email:gmail:<m2@x.com>", JSON.stringify({ messageId: "<m2@x.com>", replyTo: "", references: [], subject: "Order 7" }));
  });

  it("saves a reply to an email event in the Drafts folder and shows it in the channel", async () => {
    expect(await emailTools("work")({ event: "email:gmail:<m2@x.com>", text: "We are checking." })).toContain("Saved in [Gmail]/Drafts");
    expect(saved[0]).toMatchObject({ from: "me+shop@gmail.com", to: ["jane@x.com"], subject: "Re: Order 7", text: "We are checking." });
    expect(said[0]).toContain("Draft saved in gmail");
    expect(said[0]).toContain("We are checking.");
    expect(JSON.parse(store.getState("pending-drafts:graphite")!)).toMatchObject([{ account: "gmail", messageId: saved[0].messageId, subject: "Re: Order 7", to: ["jane@x.com"] }]);
  });

  it("saves a new message from an account the Clot may use", async () => {
    await emailTools("work")({ account: "gmail", to: ["lukas@tady.ch"], subject: "Rebooking", text: "Can we move it?" });
    expect(saved[0]).toMatchObject({ from: "me@gmail.com", to: ["lukas@tady.ch"], subject: "Rebooking" });
  });

  it("refuses under the lock, for an event that is not an email of this Clot, and without what a new message needs", async () => {
    expect(await emailTools("investigation")({ event: "email:gmail:<m2@x.com>", text: "x" })).toContain("Refused");
    expect(await emailTools("work")({ event: "d-1", text: "x" })).toContain("Refused");
    expect(await emailTools("work")({ account: "gmail", text: "x" })).toContain("Refused");
    expect(await emailTools("work")({ account: "nope", to: ["a@b.c"], subject: "s", text: "x" })).toContain("Refused");
    expect(saved).toEqual([]);
  });
});

describe("calendar_list", () => {
  const occurrence = { uid: "demo@google.com", title: "Demo with ACME", start: new Date("2026-10-16T12:00:00Z"), end: new Date("2026-10-16T13:00:00Z"), allDay: false, location: "Room 2", description: "Show the export.", organizer: "me@gmail.com", guests: ["ann@acme.com"], repeats: false };
  let asked: { account: string; from: string; to: string }[];
  let calls: { account: string; req: any }[] = [];
  let removals: { clot: string; removal: any }[] = [];
  const scriptAnswers: Record<string, any> = {};
  const allCalendarTools = (kind: TurnKind, joined = false) =>
    makeTools(
      {
        rulebook,
        writer: new RuleWriter({ rulebook, store, commit: () => undefined }),
        proposals: {
          open: async () => "FILED",
          openRemoval: async (clot, removal) => {
            removals.push({ clot, removal });
            return "ASKED";
          },
        },
        store,
        senders: {},
        say: async (_clot, text) => void said.push(text),
        handOver: async () => "",
        calendar: {
          call: async (account, req) => {
            calls.push({ account, req });
            return scriptAnswers[req.action] ?? { ok: false, reason: "no answer set", reached: true };
          },
          accounts: [{ account: "me", shared: true, icalUrl: "u", script: { url: "s", secret: "x" }, leadMinutes: [1440], pollMinutes: 5 }],
          timeZone: "Europe/Zurich",
          now: () => new Date("2026-10-15T12:30:00Z").getTime(),
          list: async (account, from, to) => {
            asked.push({ account, from: from.toISOString(), to: to.toISOString() });
            return [occurrence];
          },
        },
      },
      { clot: "graphite", kind, steered: () => joined },
    );
  const calendarTools = (kind: TurnKind) => allCalendarTools(kind).calendarList!;

  beforeEach(() => {
    asked = [];
    calls = [];
    removals = [];
    for (const key of Object.keys(scriptAnswers)) delete scriptAnswers[key];
  });

  const scriptEvent = { uid: "demo@google.com", title: "Demo with ACME", start: "2026-10-16T12:00:00.000Z", end: "2026-10-16T13:00:00.000Z", allDay: false, location: "", description: "", guests: 0, repeats: false };

  it("adds an event in a working turn, and says so in the channel", async () => {
    scriptAnswers.create = { ok: true, event: scriptEvent };
    const text = await allCalendarTools("work").calendarWrite!({ action: "create", title: "Demo with ACME", start: "2026-10-16T14:00", end: "2026-10-16T15:00" });
    expect(calls[0]).toEqual({ account: "me", req: { action: "create", title: "Demo with ACME", start: "2026-10-16T12:00:00.000Z", end: "2026-10-16T13:00:00.000Z", allDay: false } });
    expect(text).toContain("Added");
    expect(said.at(-1)).toContain('Calendar (me): added "Demo with ACME", Fri 16 Oct 2026, 14:00–15:00');
  });

  it("moves an event after checking it, refuses one with guests, and changes a repeating one as a series", async () => {
    scriptAnswers.check = { ok: true, event: scriptEvent };
    scriptAnswers.update = { ok: true, event: { ...scriptEvent, start: "2026-10-16T13:00:00.000Z", end: "2026-10-16T14:00:00.000Z" } };
    await allCalendarTools("work").calendarWrite!({ action: "update", uid: "demo@google.com", start: "2026-10-16T15:00", end: "2026-10-16T16:00" });
    expect(calls.map((c) => c.req.action)).toEqual(["check", "update"]);
    expect(said.at(-1)).toContain("15:00–16:00");
    scriptAnswers.check = { ok: true, event: { ...scriptEvent, guests: 2 } };
    expect(await allCalendarTools("work").calendarWrite!({ action: "update", uid: "demo@google.com", title: "x" })).toContain("guests");
    scriptAnswers.check = { ok: true, event: { ...scriptEvent, repeats: true } };
    scriptAnswers.update = { ok: true, event: { ...scriptEvent, title: "x", repeats: true } };
    expect(await allCalendarTools("work").calendarWrite!({ action: "update", uid: "demo@google.com", title: "x" })).toContain("Changed");
    expect(said.at(-1)).toContain("every occurrence");
  });

  it("refuses to write under the lock, and once a steered event has joined the turn", async () => {
    for (const kind of ["investigation", "brainstorm"] as const) expect(await allCalendarTools(kind).calendarWrite!({ action: "create", title: "x", start: "2026-10-16", end: "2026-10-17", allDay: true })).toContain("Refused");
    expect(await allCalendarTools("work", true).calendarWrite!({ action: "create", title: "x", start: "2026-10-16", end: "2026-10-17", allDay: true })).toContain("Refused");
    expect(calls).toEqual([]);
  });

  it("refuses to make an event all-day, or not, without its new start and end", async () => {
    scriptAnswers.check = { ok: true, event: scriptEvent };
    expect(await allCalendarTools("work").calendarWrite!({ action: "update", uid: "demo@google.com", allDay: true })).toContain("start and end");
    expect(calls).toEqual([]);
  });

  it("puts a removal to the user only in a working turn the user started with no steered event", async () => {
    expect(await allCalendarTools("work").calendarRemove!({ uid: "demo@google.com" })).toBe("ASKED");
    expect(removals).toEqual([{ clot: "graphite", removal: { account: "me", uid: "demo@google.com" } }]);
    expect(await allCalendarTools("work", true).calendarRemove!({ uid: "demo@google.com" })).toContain("Refused");
    expect(await allCalendarTools("investigation").calendarRemove!({ uid: "demo@google.com" })).toContain("Refused");
    expect(removals).toHaveLength(1);
  });

  it("lists the coming week by default, with each event's id, also under the lock", async () => {
    const text = await calendarTools("investigation")({});
    expect(asked).toEqual([{ account: "me", from: "2026-10-15T12:30:00.000Z", to: "2026-10-22T12:30:00.000Z" }]);
    expect(text).toContain("Fri 16 Oct 2026, 14:00–15:00  Demo with ACME  [id: demo@google.com]");
    expect(text).toContain("Room 2");
    expect(text).toContain("1 guest");
  });

  it("reads the range it is given, and refuses one longer than 31 days", async () => {
    await calendarTools("work")({ from: "2026-10-16", to: "2026-10-17" });
    expect(asked[0]).toMatchObject({ from: "2026-10-15T22:00:00.000Z", to: "2026-10-16T22:00:00.000Z" });
    expect(await calendarTools("work")({ from: "2026-10-01", to: "2026-12-01" })).toContain("at most 31 days");
    expect(await calendarTools("work")({ from: "soon" })).toContain("Refused");
  });
});

describe("mcp_list", () => {
  it("gives the hub's description, in any kind of turn", async () => {
    const t = makeTools(
      { rulebook, writer: new RuleWriter({ rulebook, store, commit: () => undefined }), proposals: { open: async () => "" }, store, senders: {}, say: async () => undefined, handOver: async () => "", mcp: { describe: async () => "notion: connected" } },
      { clot: "graphite", kind: "investigation", steered: () => false, event: issue() },
    );
    expect(await t.mcpList!()).toContain("notion: connected");
  });
});

describe("watch recipe tools", () => {
  const recipe = { name: "notion-feedback", server: "notion", tool: "search", arguments: {}, items: "results", id: "id", ignore: [], every: 5, report: "added" as const };

  it("always propose a recipe, and try one with a read-only tool even under the lock", async () => {
    const t = makeTools(
      {
        rulebook,
        writer: new RuleWriter({ rulebook, store, commit: () => undefined }),
        proposals: { open: async (clot, scope, edit) => (opened.push({ clot, scope, edit }), "FILED") },
        store,
        senders: {},
        say: async () => undefined,
        handOver: async () => "",
        mcp: { describe: async () => "", listTools: async () => [{ name: "search", description: "", readOnly: true }], callTool: async () => ({ text: '{"results":[{"id":"p1"}]}', isError: false }) },
      },
      { clot: "graphite", kind: "investigation", steered: () => false, event: issue() },
    );
    expect(await t.watch({ action: "set", file: "own", recipe })).toBe("FILED");
    expect(opened[0]).toMatchObject({ scope: "own", edit: { op: "set_watch", recipe } });
    expect(await t.watchTry!(recipe)).toContain("1 item");
  });
});

describe("rulebook_webhook", () => {
  it("always proposes, and refuses a recipe that does not fit", async () => {
    const recipe = { name: "tracker", verify: { scheme: "token", header: "X-Token", secret: "RECIPE_TRACKER" }, kinds: [{ kind: "ping", when: {} }], event: { title: "{t}" } } as never;
    expect(await tools("work").webhook({ action: "set", file: "global", recipe })).toBe("FILED");
    expect(opened.at(-1)).toMatchObject({ scope: "global", edit: { op: "set_webhook" } });
    expect(await tools("work").webhook({ action: "set", file: "own", recipe: { name: "x" } as never })).toContain("Not proposed");
  });
});
