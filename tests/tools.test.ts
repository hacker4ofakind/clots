import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { SendResult } from "../src/events/github-comment.js";
import type { ClotEvent } from "../src/events/types.js";
import { CalendarUndo } from "../src/calendar-undo.js";
import { RuleWriter } from "../src/rule-writer.js";
import { parseRuleFile, Rulebook } from "../src/rulebook.js";
import type { RuleEdit, RuleScope } from "../src/rulebook-edit.js";
import { Store } from "../src/store.js";
import { describeEmailAccounts, makeTools, showRules, UNDONE_REFUSAL, type DaemonTools, type ToolDeps, type TurnContext, type TurnKind } from "../src/tools.js";

const Z = "​";

let dir: string;
let rulebook: Rulebook;
let store: Store;
let opened: { clot: string; scope: RuleScope; edit: RuleEdit }[];
let said: string[];
let sent: { event: string; text: string }[];
let sendAnswer: SendResult;
let handed: { from: string; eventId: string; to: string; byRequest: boolean }[];

function issue(overrides: Partial<ClotEvent> = {}): ClotEvent {
  return { id: "d-1", source: "github", kind: "issue_opened", account: "github", place: "octo/widgets", actor: "alice", title: "Issue #7 opened: Login fails", body: "", url: "https://github.com/octo/widgets/issues/7", ref: "7", subject: "issue:7", automated: false, outsider: false, receivedAt: 0, ...overrides };
}

let writer: RuleWriter;

function tools(kind: TurnKind, event?: ClotEvent, outsider = event?.outsider === true): DaemonTools {
  const ctx: TurnContext = { clot: "graphite", kind, event, outsider };
  return makeTools(
    {
      rulebook,
      writer,
      asks: {
        rule: async (clot, scope, edit) => {
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
      handOver: async (from, eventId, to, byRequest) => {
        handed.push({ from, eventId, to, byRequest });
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
  writer = new RuleWriter({ rulebook, store, commit: () => undefined });
  opened = [];
  said = [];
  sent = [];
  sendAnswer = { ok: true, url: "https://github.com/octo/widgets/issues/7#issuecomment-1" };
  handed = [];
});

describe("the rulebook tools", () => {
  it("apply an edit at once in a working turn, and the daemon tells the user with the undo", async () => {
    const reply = await tools("chat").prefilter({ action: "add", file: "own", rule: { actor: "dependabot[bot]" } });
    expect(reply).toContain("Applied");
    expect(own().prefilters).toEqual([{ actor: "dependabot[bot]" }]);
    expect(said).toEqual(["Rule change in `graphite.yaml`: Drop events where actor is `dependabot[bot]`\n`&rules undo` takes it back."]);
    expect(opened).toEqual([]);

    await tools("chat").guidance({ action: "add", file: "own", line: "Billing is urgent." });
    await tools("chat").prefilter({ action: "remove", file: "own", rule: { actor: "dependabot[bot]" } });
    expect(own()).toMatchObject({ prefilters: [], triage: ["Billing is urgent."] });
  });

  it("apply at once in an event's turn whose event is not an outsider's, in a worker's turn, and in the global file", async () => {
    expect(await tools("event", issue()).prefilter({ action: "add", file: "own", rule: { actor: "a" } })).toContain("Applied");
    expect(await tools("worker").guidance({ action: "add", file: "own", line: "b" })).toContain("Applied");
    expect(await tools("chat").guidance({ action: "add", file: "global", line: "x" })).toContain("Applied");
    expect(own()).toMatchObject({ prefilters: [{ actor: "a" }], triage: ["b"] });
    expect(opened).toEqual([]);
  });

  it("put every edit to the user in a turn an outsider's text started", async () => {
    const t = tools("event", issue({ outsider: true }));
    const reply = await t.prefilter({ action: "add", file: "own", rule: { kind: "ci_failed" } });
    expect(reply).toBe("Put to the user, because this turn came from an outsider's text: FILED");
    await t.routing({ action: "add", rule: { source: "email", clot: "graphite" } });
    await t.watch({ action: "set", file: "own", recipe: { name: "feed", server: "notion", tool: "search", arguments: {}, items: "results", id: "id", ignore: [], every: 5, report: "added" } as never });
    expect(opened.map((p) => p.edit.op)).toEqual(["add_prefilter", "add_routing", "set_watch"]);
    expect(own().prefilters).toEqual([]);
    expect(said).toEqual([]);
  });

  it("do not add again, outside the user's own turn, a rule the user undid", async () => {
    await tools("chat").prefilter({ action: "add", file: "own", rule: { actor: "a" } });
    expect(writer.undo("graphite").ok).toBe(true);
    expect(await tools("worker").prefilter({ action: "add", file: "own", rule: { actor: "a" } })).toBe(UNDONE_REFUSAL);
    expect(await tools("event", issue({ outsider: true })).prefilter({ action: "add", file: "own", rule: { actor: "a" } })).toBe(UNDONE_REFUSAL);
    expect(own().prefilters).toEqual([]);
    expect(await tools("chat").prefilter({ action: "add", file: "own", rule: { actor: "a" } })).toContain("Applied");
  });

  it("always put a standing rule to the user", async () => {
    const t = tools("chat");
    await t.standing({ action: "set", file: "own", name: "ack-issue", trigger: { kind: "issue_opened" }, template: "Thanks, @{actor}." });
    await t.standing({ action: "remove", file: "own", name: "ack-issue" });
    expect(opened).toEqual([
      { clot: "graphite", scope: "own", edit: { op: "set_standing", rule: { name: "ack-issue", trigger: { kind: "issue_opened" }, via: "github_comment", template: "Thanks, @{actor}." } } },
      { clot: "graphite", scope: "own", edit: { op: "remove_standing", name: "ack-issue" } },
    ]);
  });

  it("say why an edit was not made", async () => {
    expect(await tools("chat").prefilter({ action: "remove", file: "own", rule: { actor: "nobody" } })).toContain("Not applied: there is no such pre-filter");
    expect(await tools("chat").standing({ action: "set", file: "own", name: "ack-issue" })).toContain("needs a trigger and a template");
    expect(said).toEqual([]);
  });

  it("show the rules in force and the open rule asks", async () => {
    fs.writeFileSync(path.join(dir, "global.yaml"), "prefilters:\n  - actor: dependabot[bot]\ntriage:\n  - Billing is urgent.\n");
    standing(ACK);
    store.createAsk({ kind: "rule", clot: "graphite", channelId: "ch-9", channelName: "graphite-rule", payload: {}, summary: "Drop events where kind is `comment`\nmore", openedAt: 0, deadline: null, dedupe: "x", outsider: false });
    store.createAsk({ kind: "email", clot: "graphite", channelId: "ch-10", channelName: "graphite-mail", payload: {}, summary: "An email", openedAt: 0, deadline: null, dedupe: "y", outsider: false });
    const shown = await tools("chat").show();
    expect(shown).toBe(showRules({ rulebook, store }, "graphite"));
    expect(shown).toContain("Rules in force for graphite");
    expect(shown).toContain("- [global] actor is `dependabot[bot]`");
    expect(shown).toContain("- [global] Billing is urgent.");
    expect(shown).toContain("- [graphite] `ack-issue`: when kind is `issue_opened`, send via github_comment:");
    expect(shown).toContain("- Drop events where kind is `comment`");
    expect(shown).not.toContain("more");
    expect(shown).not.toContain("An email");
    expect(showRules({ rulebook, store }, "other")).toContain("Standing rules:\n- none");
  });
});

describe("send_from_template", () => {
  it("sends the filled-in template on the event's thread, records it, and shows the user", async () => {
    standing(ACK);
    const reply = await tools("event", issue()).send({ rule: "ack-issue" });
    expect(sent).toEqual([{ event: "d-1", text: "Thanks for the report, @alice. I am looking into it." }]);
    expect(reply).toContain("Sent");
    expect(said).toEqual(["Sent under standing rule `ack-issue`: Thanks for the report, @alice. I am looking into it. <https://github.com/octo/widgets/issues/7#issuecomment-1>"]);
    expect(store.hasSend("d-1", "ack-issue")).toBe(true);
  });

  it("accepts the Clot's wording within five words, and lets its words mention nobody", async () => {
    standing(ACK);
    await tools("event", issue()).send({ rule: "ack-issue", text: "Thanks for the report, @alice. I am looking into it now, @bob." });
    expect(sent[0].text).toBe(`Thanks for the report, @alice. I am looking into it now, @${Z}bob.`);
  });

  it("refuses outside an investigation, and for a rule that does not apply to this event", async () => {
    standing(ACK);
    expect(await tools("chat").send({ rule: "ack-issue" })).toContain("Refused");
    expect(await tools("worker").send({ rule: "ack-issue" })).toContain("Refused");
    expect(await tools("event", issue({ kind: "pr_opened", subject: "pr:7" })).send({ rule: "ack-issue" })).toContain('no standing rule named "ack-issue" applies');
    expect(await tools("event", issue()).send({ rule: "unknown" })).toContain("applies");
    expect(sent).toEqual([]);
  });

  it("refuses when the event has no thread, when the rule was already sent, and when too many words differ", async () => {
    standing(ACK, '  - name: ci-note\n    trigger: { kind: ci_failed }\n    via: github_comment\n    template: "Looking at the failure."\n');
    expect(await tools("event", issue({ kind: "ci_failed", subject: "branch:main" })).send({ rule: "ci-note" })).toContain("about a branch");

    const t = tools("event", issue());
    expect(await t.send({ rule: "ack-issue", text: "Hello there alice, we will get back to you soon." })).toContain("at most 5");
    expect(await t.send({ rule: "ack-issue", text: "x ".repeat(3000) })).toContain("too long");
    expect(sent).toEqual([]);
    await t.send({ rule: "ack-issue" });
    expect(await t.send({ rule: "ack-issue" })).toContain("already been sent");
    expect(sent).toHaveLength(1);
  });

  it("can be tried again after a definite refusal, and not after an uncertain failure", async () => {
    standing(ACK);
    const t = tools("event", issue());
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

    await tools("event", batch).send({ rule: "rebase" });
    expect(sent).toEqual([{ event: "d-3", text: "@dependabot[bot] rebase" }]);
    expect(store.hasSend("batch:d-2", "rebase")).toBe(true);
  });
});

describe("a digest turn", () => {
  const digestTools = (events: ClotEvent[], outsider = false) =>
    makeTools(
      {
        rulebook,
        writer,
        asks: { rule: async () => "FILED" },
        store,
        senders: { github_comment: { reach: () => undefined, send: async (event, text) => (sent.push({ event: event.id, text }), sendAnswer) } },
        say: async (_clot, text) => void said.push(text),
        handOver: async () => "",
      },
      { clot: "graphite", kind: "event", digest: events, outsider },
    );

  it("sends from a template only for a named event that is in the digest", async () => {
    standing(ACK);
    const inside = issue({ id: "d-1" });
    const other = issue({ id: "d-2", subject: "issue:8", ref: "8" });
    const t = digestTools([inside, other]);
    expect(await t.send({ rule: "ack-issue" })).toBe("Refused: name the event, this turn holds several.");
    expect(await t.send({ rule: "ack-issue", event: "d-9" })).toBe("Refused: that event is not in this turn.");
    expect(sent).toEqual([]);
    expect(await t.send({ rule: "ack-issue", event: "d-2" })).toContain("Sent");
    expect(sent).toEqual([{ event: "d-2", text: "Thanks for the report, @alice. I am looking into it." }]);
    expect(store.hasSend("d-2", "ack-issue")).toBe(true);
    expect(store.hasSend("d-1", "ack-issue")).toBe(false);
  });

  it("ignores the event argument outside a digest", async () => {
    standing(ACK);
    await tools("event", issue()).send({ rule: "ack-issue", event: "anything" });
    expect(sent).toHaveLength(1);
  });
});

describe("routing tools", () => {
  it("apply a routing rule at once, in the global file", async () => {
    const rule = { source: "email", place: "me+shop@gmail.com", clot: "graphite" };
    expect(await tools("chat").routing({ action: "add", rule })).toContain("Applied");
    expect(rulebook.routing()).toEqual([rule]);
    expect(opened).toEqual([]);
  });

  it("hand an event over in any turn, and outside the user's own turn only once", async () => {
    expect(await tools("chat").routeCorrect({ event: "d-1", clot: "shop" })).toBe("HANDED");
    expect(await tools("event", issue()).routeCorrect({ event: "d-2", clot: "shop" })).toBe("HANDED");
    expect(handed).toEqual([
      { from: "graphite", eventId: "d-1", to: "shop", byRequest: true },
      { from: "graphite", eventId: "d-2", to: "shop", byRequest: false },
    ]);
    store.setState("handed-over:d-2", "graphite");
    expect(await tools("worker").routeCorrect({ event: "d-2", clot: "home" })).toContain("already been handed over once");
    expect(handed).toHaveLength(2);
  });
});

describe("email_draft", () => {
  const account = { account: "gmail", shared: true, address: "me@gmail.com", addresses: [], password: "p", imap: { host: "i", port: 993 }, smtp: { host: "s", port: 465 }, mailboxes: ["Clots"], tellAddress: true };
  let saved: any[];
  const emailTools = (kind: TurnKind) => {
    saved = [];
    const t = makeTools(
      {
        rulebook,
        writer: new RuleWriter({ rulebook, store, commit: () => undefined }),
        asks: { rule: async () => "FILED" },
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
      { clot: "graphite", kind, outsider: false },
    );
    return t.emailDraft!;
  };

  beforeEach(() => {
    store.insertEvent({ ...issue(), id: "email:gmail:<m2@x.com>", source: "email", account: "gmail", kind: "email", place: "me+shop@gmail.com", actor: "jane@x.com", title: "Order 7", ref: "<m2@x.com>", subject: "thread:<m2@x.com>" });
    store.setEventClot("email:gmail:<m2@x.com>", "graphite");
    store.setState("email-meta:email:gmail:<m2@x.com>", JSON.stringify({ messageId: "<m2@x.com>", replyTo: "", references: [], subject: "Order 7" }));
  });

  it("saves a reply to an email event in the Drafts folder and shows it in the channel", async () => {
    expect(await emailTools("chat")({ event: "email:gmail:<m2@x.com>", text: "We are checking." })).toContain("Saved in [Gmail]/Drafts");
    expect(saved[0]).toMatchObject({ from: "me+shop@gmail.com", to: ["jane@x.com"], subject: "Re: Order 7", text: "We are checking." });
    expect(said[0]).toContain("Draft saved in gmail");
    expect(said[0]).toContain("We are checking.");
    expect(JSON.parse(store.getState("pending-drafts:graphite")!)).toMatchObject([{ account: "gmail", messageId: saved[0].messageId, subject: "Re: Order 7", to: ["jane@x.com"] }]);
  });

  it("saves a new message from an account the Clot may use", async () => {
    await emailTools("chat")({ account: "gmail", to: ["lukas@tady.ch"], subject: "Rebooking", text: "Can we move it?" });
    expect(saved[0]).toMatchObject({ from: "me@gmail.com", to: ["lukas@tady.ch"], subject: "Rebooking" });
  });

  it("saves in any kind of turn", async () => {
    expect(await emailTools("event")({ event: "email:gmail:<m2@x.com>", text: "x" })).toContain("Saved");
    expect(await emailTools("worker")({ event: "email:gmail:<m2@x.com>", text: "x" })).toContain("Saved");
  });

  it("refuses for an event that is not an email of this Clot, and without what a new message needs", async () => {
    expect(await emailTools("chat")({ event: "d-1", text: "x" })).toContain("Refused");
    expect(await emailTools("chat")({ account: "gmail", text: "x" })).toContain("Refused");
    expect(await emailTools("chat")({ account: "nope", to: ["a@b.c"], subject: "s", text: "x" })).toContain("Refused");
    expect(saved).toEqual([]);
  });

  it("tells the Clot the accounts it may write from, with their addresses unless they are kept from it", () => {
    const tady = { ...account, account: "tady", address: "me@tady.ch", addresses: ["support@tady.ch"] };
    expect(describeEmailAccounts([account, tady])).toBe("The email accounts you may write from are the user's own: gmail (me@gmail.com), tady (me@tady.ch; mail to support@tady.ch also arrives there).");
    expect(describeEmailAccounts([{ ...tady, tellAddress: false }])).toBe("The email accounts you may write from are the user's own: tady (its address is not shown to you).");
    expect(describeEmailAccounts([])).toContain("no email account");
    expect(makeTools({ rulebook, writer: new RuleWriter({ rulebook, store, commit: () => undefined }), asks: { rule: async () => "" }, store, senders: {}, say: async () => undefined, handOver: async () => "", email: { accounts: [account, { ...tady, clot: "other", shared: false }], save: async () => ({ mailbox: "" }) } }, { clot: "graphite", kind: "chat", outsider: false }).emailAccounts).toContain("gmail (me@gmail.com).");
  });

  describe("email_send", () => {
    let reviews: { clot: string; req: any }[];
    const sendTools = (kind: TurnKind, event?: ClotEvent, review = true) => {
      reviews = [];
      const t = makeTools(
        {
          rulebook,
          writer: new RuleWriter({ rulebook, store, commit: () => undefined }),
          asks: { rule: async () => "FILED", ...(review ? { email: async (clot: string, req: any) => (reviews.push({ clot, req }), "FILED FOR REVIEW") } : {}) },
          store,
          senders: {},
          say: async (_clot, text) => void said.push(text),
          handOver: async () => "",
          email: {
            accounts: [account],
            save: async () => ({ mailbox: "Drafts" }),
          },
        },
        { clot: "graphite", kind, event, outsider: event?.outsider === true },
      );
      return t.emailSend;
    };
    const mailEvent = () => store.getEvent("email:gmail:<m2@x.com>")! as unknown as ClotEvent;

    it("puts a reply or a new message to the user, and sends nothing itself", async () => {
      expect(await sendTools("chat")!({ event: "email:gmail:<m2@x.com>", text: "We are checking." })).toBe("FILED FOR REVIEW");
      expect(reviews[0]).toMatchObject({ clot: "graphite", req: { account: "gmail", event: "email:gmail:<m2@x.com>", mail: { from: "me+shop@gmail.com", to: ["jane@x.com"], subject: "Re: Order 7", text: "We are checking." } } });
      expect(await sendTools("chat")!({ account: "gmail", to: ["lukas@tady.ch"], subject: "Rebooking", text: "Can we move it?" })).toBe("FILED FOR REVIEW");
      expect(reviews[0].req).toMatchObject({ account: "gmail", event: undefined, mail: { from: "me@gmail.com", to: ["lukas@tady.ch"] } });
      expect(said).toEqual([]);
    });

    it("lets an outsider's turn answer only the email it is looking into, and any other turn ask freely", async () => {
      const outsiders = { ...mailEvent(), outsider: true };
      expect(await sendTools("event", outsiders)!({ event: "email:gmail:<m2@x.com>", text: "Thanks." })).toBe("FILED FOR REVIEW");
      reviews = [];
      expect(await sendTools("event", outsiders)!({ account: "gmail", to: ["a@b.c"], subject: "s", text: "x" })).toContain("only ask to answer the email you are looking into");
      expect(await sendTools("event", { ...issue(), id: "d-1", outsider: true } as ClotEvent)!({ event: "email:gmail:<m2@x.com>", text: "x" })).toContain("Refused");
      expect(reviews).toEqual([]);
      expect(await sendTools("worker")!({ account: "gmail", to: ["a@b.c"], subject: "s", text: "x" })).toBe("FILED FOR REVIEW");
      expect(await sendTools("event", mailEvent())!({ account: "gmail", to: ["a@b.c"], subject: "s", text: "x" })).toBe("FILED FOR REVIEW");
    });

    it("takes the email to answer by ID in a digest turn, and refuses one the digest does not hold", async () => {
      const t = (events: ClotEvent[], outsider = false) => {
        reviews = [];
        return makeTools(
          { rulebook, writer: new RuleWriter({ rulebook, store, commit: () => undefined }), asks: { rule: async () => "FILED", email: async (clot: string, req: any) => (reviews.push({ clot, req }), "FILED FOR REVIEW") }, store, senders: {}, say: async () => undefined, handOver: async () => "", email: { accounts: [account], save: async () => ({ mailbox: "Drafts" }) } },
          { clot: "graphite", kind: "event", digest: events, outsider },
        ).emailSend!;
      };
      const mail = mailEvent();
      expect(await t([mail, issue()])({ text: "x" })).toBe("Refused: name the event, this turn holds several.");
      expect(await t([issue()])({ event: "email:gmail:<m2@x.com>", text: "x" })).toBe("Refused: that event is not in this turn.");
      expect(reviews).toEqual([]);
      expect(await t([mail, issue()])({ event: "email:gmail:<m2@x.com>", text: "Thanks." })).toBe("FILED FOR REVIEW");
      expect(await t([{ ...mail, outsider: true }, issue()], true)({ event: "email:gmail:<m2@x.com>", text: "Thanks." })).toBe("FILED FOR REVIEW");
    });

    it("refuses what a draft refuses, and is not offered when send review is off", async () => {
      expect(await sendTools("chat")!({ event: "d-1", text: "x" })).toContain("Refused");
      expect(await sendTools("chat")!({ account: "gmail", text: "x" })).toContain("Refused");
      expect(reviews).toEqual([]);
      expect(sendTools("chat", undefined, false)).toBeUndefined();
    });
  });
});

describe("calendar_list", () => {
  const occurrence = { uid: "demo@google.com", icalUid: "demo@google.com", title: "Demo with ACME", start: new Date("2026-10-16T12:00:00Z"), end: new Date("2026-10-16T13:00:00Z"), allDay: false, location: "Room 2", description: "Show the export.", organizer: "me@gmail.com", guests: ["ann@acme.com"], repeats: false };
  let asked: { account: string; from: string; to: string }[];
  let calls: { account: string; req: any }[] = [];
  const scriptAnswers: Record<string, any> = {};
  const allCalendarTools = (kind: TurnKind, outsider = false) =>
    makeTools(
      {
        rulebook,
        writer: new RuleWriter({ rulebook, store, commit: () => undefined }),
        asks: { rule: async () => "FILED" },
        store,
        senders: {},
        say: async (_clot, text) => void said.push(text),
        handOver: async () => "",
        calendar: {
          call: async (account, req) => {
            calls.push({ account, req });
            return scriptAnswers[req.action] ?? { ok: false, reason: "no answer set", reached: true };
          },
          accounts: [{ toolkit: "googlecalendar", account: "me", shared: true, audience: "private", triggers: [], selfIsUser: false, leadMinutes: [1440], pollMinutes: 5 }],
          timeZone: "Europe/Zurich",
          now: () => new Date("2026-10-15T12:30:00Z").getTime(),
          list: async (account, from, to) => {
            asked.push({ account, from: from.toISOString(), to: to.toISOString() });
            return [occurrence];
          },
        },
      },
      { clot: "graphite", kind, outsider },
    );
  const calendarTools = (kind: TurnKind) => allCalendarTools(kind).calendarList!;
  const undo = () => new CalendarUndo({ store, timeZone: "Europe/Zurich", call: async (account, req) => (calls.push({ account, req }), scriptAnswers[req.action] ?? { ok: false, reason: "no answer set", reached: true }) }).undo("graphite");

  beforeEach(() => {
    asked = [];
    calls = [];
    for (const key of Object.keys(scriptAnswers)) delete scriptAnswers[key];
  });

  const scriptEvent = { uid: "demo@google.com", title: "Demo with ACME", start: "2026-10-16T12:00:00.000Z", end: "2026-10-16T13:00:00.000Z", allDay: false, location: "", description: "", guests: 0, repeats: false };

  it("adds an event in a working turn, and says so in the channel", async () => {
    scriptAnswers.create = { ok: true, event: scriptEvent };
    const text = await allCalendarTools("chat").calendarWrite!({ action: "create", title: "Demo with ACME", start: "2026-10-16T14:00", end: "2026-10-16T15:00" });
    expect(calls[0]).toEqual({ account: "me", req: { action: "create", title: "Demo with ACME", start: "2026-10-16T12:00:00.000Z", end: "2026-10-16T13:00:00.000Z", allDay: false } });
    expect(text).toContain("Added");
    expect(said.at(-1)).toContain('Calendar (me): added "Demo with ACME", Fri 16 Oct 2026, 14:00–15:00');
  });

  it("moves an event after checking it, refuses one with guests, and changes a repeating one as a series", async () => {
    scriptAnswers.check = { ok: true, event: scriptEvent };
    scriptAnswers.update = { ok: true, event: { ...scriptEvent, start: "2026-10-16T13:00:00.000Z", end: "2026-10-16T14:00:00.000Z" } };
    await allCalendarTools("chat").calendarWrite!({ action: "update", uid: "demo@google.com", start: "2026-10-16T15:00", end: "2026-10-16T16:00" });
    expect(calls.map((c) => c.req.action)).toEqual(["check", "update"]);
    expect(said.at(-1)).toContain("15:00–16:00");
    scriptAnswers.check = { ok: true, event: { ...scriptEvent, guests: 2 } };
    expect(await allCalendarTools("chat").calendarWrite!({ action: "update", uid: "demo@google.com", title: "x" })).toContain("guests");
    scriptAnswers.check = { ok: true, event: { ...scriptEvent, repeats: true } };
    scriptAnswers.update = { ok: true, event: { ...scriptEvent, title: "x", repeats: true } };
    expect(await allCalendarTools("chat").calendarWrite!({ action: "update", uid: "demo@google.com", title: "x" })).toContain("Changed");
    expect(said.at(-1)).toContain("every occurrence");
  });

  it("adds an event in a chat, an event's and a worker's turn", async () => {
    scriptAnswers.create = { ok: true, event: scriptEvent };
    for (const kind of ["chat", "event", "worker"] as const) expect(await allCalendarTools(kind).calendarWrite!({ action: "create", title: "x", start: "2026-10-16", end: "2026-10-17", allDay: true })).toContain("Added");
    expect(calls).toHaveLength(3);
  });

  it("refuses to make an event all-day, or not, without its new start and end", async () => {
    scriptAnswers.check = { ok: true, event: scriptEvent };
    expect(await allCalendarTools("chat").calendarWrite!({ action: "update", uid: "demo@google.com", allDay: true })).toContain("start and end");
    expect(calls).toEqual([]);
  });

  it("removes an event without guests at once, keeps a copy first, and posts the line with its undo", async () => {
    scriptAnswers.check = { ok: true, event: scriptEvent };
    scriptAnswers.remove = { ok: true, event: scriptEvent };
    expect(await allCalendarTools("event").calendarRemove!({ uid: "demo@google.com" })).toContain("Removed");
    expect(calls.map((c) => c.req.action)).toEqual(["check", "remove"]);
    expect(store.latestCalendarChange("graphite")).toMatchObject({ op: "remove", uid: "demo@google.com", before: JSON.stringify(scriptEvent) });
    expect(said.at(-1)).toBe('Calendar (me): removed "Demo with ACME", Fri 16 Oct 2026, 14:00–15:00 (Europe/Zurich) [id: demo@google.com]. `&calendar undo` puts it back.');
  });

  it("keeps the copy of a removal whose answer was lost, and drops it for a definite refusal", async () => {
    scriptAnswers.check = { ok: true, event: scriptEvent };
    scriptAnswers.remove = { ok: false, reason: "the calendar script could not be reached", reached: false };
    expect(await allCalendarTools("chat").calendarRemove!({ uid: "demo@google.com" })).toContain("Not removed");
    expect(store.latestCalendarChange("graphite")).toMatchObject({ op: "remove" });
    store.deleteCalendarChange(store.latestCalendarChange("graphite")!.id);
    scriptAnswers.remove = { ok: false, reason: "there is no such event", reached: true };
    await allCalendarTools("chat").calendarRemove!({ uid: "demo@google.com" });
    expect(store.latestCalendarChange("graphite")).toBeUndefined();
  });

  it("refuses to remove one with guests, and a repeating one in every turn", async () => {
    scriptAnswers.check = { ok: true, event: { ...scriptEvent, guests: 1 } };
    expect(await allCalendarTools("chat").calendarRemove!({ uid: "demo@google.com" })).toContain("guests");
    scriptAnswers.check = { ok: true, event: { ...scriptEvent, repeats: true, recurring: true } };
    expect(await allCalendarTools("chat").calendarRemove!({ uid: "demo@google.com" })).toContain("repeats");
    expect(calls.map((c) => c.req.action)).toEqual(["check", "check"]);
  });

  it("changes a series only in a turn the user's message started", async () => {
    scriptAnswers.check = { ok: true, event: { ...scriptEvent, repeats: true } };
    scriptAnswers.update = { ok: true, event: { ...scriptEvent, title: "x", repeats: true } };
    expect(await allCalendarTools("event").calendarWrite!({ action: "update", uid: "demo@google.com", title: "x" })).toContain("Refused: the event repeats");
    expect(await allCalendarTools("chat").calendarWrite!({ action: "update", uid: "demo@google.com", title: "x" })).toContain("Changed");
  });

  describe("in a turn an outsider's text started", () => {
    it("adds at most three events a day", async () => {
      scriptAnswers.create = { ok: true, event: scriptEvent };
      const add = () => allCalendarTools("event", true).calendarWrite!({ action: "create", title: "Call", start: "2026-10-16T10:00", end: "2026-10-16T11:00" });
      for (let i = 0; i < 3; i += 1) expect(await add()).toContain("Added");
      expect(await add()).toContain("3 events were already added");
      expect(await allCalendarTools("chat").calendarWrite!({ action: "create", title: "Mine", start: "2026-10-16T10:00", end: "2026-10-16T11:00" })).toContain("Added");
    });

    it("changes or removes only an event a Clot added", async () => {
      scriptAnswers.check = { ok: true, event: scriptEvent };
      scriptAnswers.update = { ok: true, event: { ...scriptEvent, title: "Moved" } };
      expect(await allCalendarTools("event", true).calendarWrite!({ action: "update", uid: "demo@google.com", title: "Moved" })).toContain("only events a Clot added");
      expect(await allCalendarTools("event", true).calendarRemove!({ uid: "demo@google.com" })).toContain("only events a Clot added");
      expect(calls).toEqual([]);
      scriptAnswers.create = { ok: true, event: scriptEvent };
      await allCalendarTools("chat").calendarWrite!({ action: "create", title: "Demo with ACME", start: "2026-10-16T14:00", end: "2026-10-16T15:00" });
      expect(await allCalendarTools("event", true).calendarWrite!({ action: "update", uid: "demo@google.com", title: "Moved" })).toContain("Changed");
    });
  });

  describe("&calendar undo", () => {
    it("puts a removed event back from the copy, as a new copy, then steps further back, then has nothing left", async () => {
      scriptAnswers.create = { ok: true, event: scriptEvent };
      await allCalendarTools("chat").calendarWrite!({ action: "create", title: "Demo with ACME", start: "2026-10-16T14:00", end: "2026-10-16T15:00" });
      scriptAnswers.check = { ok: true, event: scriptEvent };
      scriptAnswers.remove = { ok: true, event: scriptEvent };
      await allCalendarTools("chat").calendarRemove!({ uid: "demo@google.com" });
      calls = [];

      scriptAnswers.check = { ok: false, reason: "there is no event with that ID", reached: true };
      scriptAnswers.create = { ok: true, event: { ...scriptEvent, uid: "new@google.com" } };
      expect(await undo()).toBe('Put back: "Demo with ACME", Fri 16 Oct 2026, 14:00–15:00 (Europe/Zurich) [id: new@google.com].\n(It is a new copy; links to the old event will not find it.)');
      // The script confirmed the removal, so the undo creates the copy without checking first.
      expect(calls[0].req).toEqual({ action: "create", title: "Demo with ACME", start: scriptEvent.start, end: scriptEvent.end, allDay: false, description: "", location: "" });

      expect(await undo()).toContain("Removed:");
      expect(calls[1].req).toEqual({ action: "remove", uid: "demo@google.com" });
      expect(await undo()).toBe("Nothing to put back.");
    });

    it("after a removal whose answer was lost, creates the event again only when the script says it is not there, and keeps the copy when creating fails", async () => {
      scriptAnswers.check = { ok: true, event: scriptEvent };
      scriptAnswers.remove = { ok: false, reason: "the calendar script could not be reached (timeout)", reached: false };
      await allCalendarTools("chat").calendarRemove!({ uid: "demo@google.com" });
      calls = [];
      scriptAnswers.check = { ok: false, reason: "wrong secret", reached: true };
      expect(await undo()).toContain("Not undone just now: wrong secret");
      scriptAnswers.check = { ok: false, reason: "there is no event with that ID in this calendar", reached: true, missing: true };
      scriptAnswers.create = { ok: false, reason: "the calendar named by CALENDAR_ID was not found", reached: true };
      expect(await undo()).toContain("The copy of");
      expect(calls.map((c) => c.req.action)).toEqual(["check", "check", "create"]);
      expect(store.latestCalendarChange("graphite")).toMatchObject({ op: "remove" });
    });

    it("makes no second copy when a removal whose answer was lost did not happen", async () => {
      scriptAnswers.check = { ok: true, event: scriptEvent };
      scriptAnswers.remove = { ok: false, reason: "the calendar script could not be reached (timeout)", reached: false };
      await allCalendarTools("chat").calendarRemove!({ uid: "demo@google.com" });
      calls = [];
      expect(await undo()).toContain("Nothing to put back: \"Demo with ACME\"");
      expect(calls.map((c) => c.req.action)).toEqual(["check"]);
      expect(store.latestCalendarChange("graphite")).toBeUndefined();
    });

    it("writes back what an update replaced", async () => {
      scriptAnswers.check = { ok: true, event: scriptEvent };
      scriptAnswers.update = { ok: true, event: { ...scriptEvent, title: "Moved", start: "2026-10-17T12:00:00.000Z", end: "2026-10-17T13:00:00.000Z" } };
      await allCalendarTools("chat").calendarWrite!({ action: "update", uid: "demo@google.com", title: "Moved", start: "2026-10-17T14:00", end: "2026-10-17T15:00" });
      calls = [];
      scriptAnswers.update = { ok: true, event: scriptEvent };
      expect(await undo()).toContain("Put back:");
      expect(calls[0].req).toEqual({ action: "update", uid: "demo@google.com", title: "Demo with ACME", start: scriptEvent.start, end: scriptEvent.end, allDay: false, description: "", location: "" });
    });

    it("puts back a removal the script confirmed, even when the script still finds the deleted event", async () => {
      // Apps Script's getEventById goes on returning an event for a while after it was deleted.
      scriptAnswers.check = { ok: true, event: scriptEvent };
      scriptAnswers.remove = { ok: true, event: scriptEvent };
      await allCalendarTools("chat").calendarRemove!({ uid: "demo@google.com" });
      calls = [];
      scriptAnswers.create = { ok: true, event: { ...scriptEvent, uid: "copy@google.com" } };
      expect(await undo()).toContain("Put back:");
      expect(calls.map((c) => c.req.action)).toEqual(["create"]);
    });

    it("lists the copy an undo restored before the feed has it, and the next undo steps past it", async () => {
      scriptAnswers.check = { ok: true, event: scriptEvent };
      scriptAnswers.remove = { ok: true, event: scriptEvent };
      await allCalendarTools("chat").calendarRemove!({ uid: "demo@google.com" });
      scriptAnswers.create = { ok: true, event: { ...scriptEvent, uid: "copy@google.com" } };
      expect(await undo()).toContain("Put back:");
      const text = await calendarTools("event")({});
      expect(text).toContain("[id: copy@google.com] (put back by a Clot)");
      expect(text).not.toContain("[id: demo@google.com] (removed by a Clot");
      expect(await undo()).toBe("Nothing to put back.");
    });

    it("keeps the change when the script cannot be reached, and reverses it once when undone twice at the same time", async () => {
      scriptAnswers.create = { ok: true, event: scriptEvent };
      await allCalendarTools("chat").calendarWrite!({ action: "create", title: "Demo", start: "2026-10-16T14:00", end: "2026-10-16T15:00" });
      scriptAnswers.remove = { ok: false, reason: "the calendar script could not be reached", reached: false };
      expect(await undo()).toContain("Not undone just now");
      expect(store.latestCalendarChange("graphite")).toBeDefined();
      scriptAnswers.remove = { ok: true, event: scriptEvent };
      calls = [];
      const undoer = new CalendarUndo({ store, timeZone: "UTC", call: async (account, req) => (calls.push({ account, req }), scriptAnswers[req.action]) });
      const [a, b] = await Promise.all([undoer.undo("graphite"), undoer.undo("graphite")]);
      expect([a, b].filter((text) => text.startsWith("Removed"))).toHaveLength(1);
      expect(calls).toHaveLength(1);
    });
  });

  it("lists the coming week by default, with each event's id, also under the lock", async () => {
    const text = await calendarTools("event")({});
    expect(asked).toEqual([{ account: "me", from: "2026-10-15T12:30:00.000Z", to: "2026-10-22T12:30:00.000Z" }]);
    expect(text).toContain("Fri 16 Oct 2026, 14:00–15:00  Demo with ACME  [id: demo@google.com]");
    expect(text).toContain("Room 2");
    expect(text).toContain("1 guest");
  });

  it("shows an event a Clot added minutes ago, which the feed does not have yet, by its id", async () => {
    scriptAnswers.create = { ok: true, event: { ...scriptEvent, uid: "fresh@google.com", title: "Invoice review" } };
    await allCalendarTools("chat").calendarWrite!({ action: "create", title: "Invoice review", start: "2026-10-16T14:00", end: "2026-10-16T15:00" });
    const text = await calendarTools("event")({});
    expect(text).toContain("Changes the Clots made lately");
    expect(text).toContain('"Invoice review", Fri 16 Oct 2026, 14:00–15:00 (Europe/Zurich) [id: fresh@google.com] (added by a Clot)');
  });

  it("reads the range it is given, and refuses one longer than 31 days", async () => {
    await calendarTools("chat")({ from: "2026-10-16", to: "2026-10-17" });
    expect(asked[0]).toMatchObject({ from: "2026-10-15T22:00:00.000Z", to: "2026-10-16T22:00:00.000Z" });
    expect(await calendarTools("chat")({ from: "2026-10-01", to: "2026-12-01" })).toContain("at most 31 days");
    expect(await calendarTools("chat")({ from: "soon" })).toContain("Refused");
  });
});

describe("mcp_list", () => {
  it("gives the hub's description, in any kind of turn", async () => {
    const t = makeTools(
      { rulebook, writer: new RuleWriter({ rulebook, store, commit: () => undefined }), asks: { rule: async () => "" }, store, senders: {}, say: async () => undefined, handOver: async () => "", mcp: { describe: async () => "notion: connected" } },
      { clot: "graphite", kind: "event", event: issue(), outsider: false },
    );
    expect(await t.mcpList!()).toContain("notion: connected");
  });
});

describe("watch recipe tools", () => {
  const recipe = { name: "notion-feedback", server: "notion", tool: "search", arguments: {}, items: "results", id: "id", ignore: [], every: 5, report: "added" as const };

  it("apply a recipe in an event's turn, and try one with a read-only tool even under the lock", async () => {
    const t = makeTools(
      {
        rulebook,
        writer: new RuleWriter({ rulebook, store, commit: () => undefined }),
        asks: { rule: async (clot, scope, edit) => (opened.push({ clot, scope, edit }), "FILED") },
        store,
        senders: {},
        say: async () => undefined,
        handOver: async () => "",
        mcp: { describe: async () => "", listTools: async () => [{ name: "search", description: "", readOnly: true }], callTool: async () => ({ text: '{"results":[{"id":"p1"}]}', isError: false }) },
      },
      { clot: "graphite", kind: "event", event: issue(), outsider: false },
    );
    expect(await t.watch({ action: "set", file: "own", recipe })).toContain("Applied");
    expect(own().watches).toMatchObject([{ name: "notion-feedback" }]);
    expect(await t.watchTry!(recipe)).toContain("1 item");
  });
});

describe("watch recipes on a Composio account", () => {
  const onAccount = { name: "new-posts", account: "reddit:me", tool: "REDDIT_GET_NEW_POSTS", arguments: {}, items: "posts", id: "id", ignore: [], every: 15, report: "added" as const };
  const make = (composio: Partial<NonNullable<ToolDeps["composio"]>>) =>
    makeTools(
      {
        rulebook,
        writer,
        asks: { rule: async () => "FILED" },
        store,
        senders: {},
        say: async () => undefined,
        handOver: async () => "",
        composio: { find: async () => "", run: async () => "", ...composio },
        composioHub: { listTools: async () => [{ name: "REDDIT_GET_NEW_POSTS", description: "", readOnly: true }], callTool: async () => ({ text: '{"posts":[{"id":"a"}]}', isError: false }) },
      },
      { clot: "graphite", kind: "chat", outsider: false },
    );

  it("counts watch_try against composio_run's limits, and refuses past them with the same text", async () => {
    let allowed = true;
    const t = make({ countCall: () => (allowed ? undefined : "Refused: 30 Composio calls were made in this turn, which is the limit.") });
    expect(await t.watchTry!(onAccount)).toContain("1 item");
    allowed = false;
    expect(await t.watchTry!(onAccount)).toBe("Refused: 30 Composio calls were made in this turn, which is the limit.");
  });

  it("refuses to set a watch whose account is not configured, naming the accounts", async () => {
    const t = make({ hasAccount: (name) => name === "slack:work", accountNames: () => ["slack:work"] });
    expect(await t.watch({ action: "set", file: "own", recipe: onAccount })).toBe("Not done: no Composio account reddit:me is configured. The accounts are: slack:work.");
    expect(own().watches).toEqual([]);
    const ok = make({ hasAccount: () => true });
    expect(await ok.watch({ action: "set", file: "own", recipe: onAccount })).toContain("Applied");
  });
});

describe("rulebook_webhook", () => {
  it("applies a recipe at once, and refuses one that does not fit", async () => {
    const recipe = { name: "tracker", verify: { scheme: "token", header: "X-Token", secret: "RECIPE_TRACKER" }, kinds: [{ kind: "ping", when: {} }], event: { title: "{t}" } } as never;
    expect(await tools("chat").webhook({ action: "set", file: "global", recipe })).toContain("Applied");
    expect(opened).toEqual([]);
    expect(await tools("chat").webhook({ action: "set", file: "own", recipe: { name: "x" } as never })).toContain("Not done");
  });
});

describe("the Composio tools", () => {
  const withComposio = (kind: TurnKind, composio?: ToolDeps["composio"]) =>
    makeTools(
      { rulebook, writer, asks: { rule: async () => "FILED" }, store, senders: {}, say: async () => undefined, handOver: async () => "", ...(composio === undefined ? {} : { composio }) },
      { clot: "graphite", kind, outsider: kind === "event", userText: kind === "chat" ? "go" : undefined },
    );

  it("are absent when no Composio account is configured", () => {
    const t = withComposio("chat");
    expect(t.composioFind).toBeUndefined();
    expect(t.composioRun).toBeUndefined();
  });

  it("hand each call to Composio with the turn's own context, in every kind of turn, since the tool rates each call itself", async () => {
    const seen: { ctx: TurnContext; what: string }[] = [];
    const composio = {
      find: async (ctx: TurnContext, a: { account: string; query: string }) => (seen.push({ ctx, what: `find ${a.account} ${a.query}` }), "FOUND"),
      run: async (ctx: TurnContext, a: { account: string; tool: string; args: Record<string, unknown> }) => (seen.push({ ctx, what: `run ${a.account} ${a.tool} ${JSON.stringify(a.args)}` }), "RAN"),
    };
    for (const kind of ["chat", "event", "worker"] as const) {
      const t = withComposio(kind, composio);
      expect(await t.composioFind!({ account: "linear:proton", query: "archive" })).toBe("FOUND");
      expect(await t.composioRun!({ account: "linear:proton", tool: "LINEAR_GET_LINEAR_ISSUE", args: { issue_id: "CLO-1" } })).toBe("RAN");
    }
    expect(seen.map((s) => s.what)).toEqual(Array(3).fill(["find linear:proton archive", 'run linear:proton LINEAR_GET_LINEAR_ISSUE {"issue_id":"CLO-1"}']).flat());
    expect(seen.map((s) => s.ctx.kind)).toEqual(["chat", "chat", "event", "event", "worker", "worker"]);
    expect(seen[0].ctx.userText).toBe("go");
    expect(seen[2].ctx.outsider).toBe(true);
  });
});
