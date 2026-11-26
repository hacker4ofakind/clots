import { beforeEach, describe, expect, it } from "vitest";
import { Asks, type AskKind } from "../src/asks.js";
import { askEmail, changedLines, emailKind, SEND_FILED, type EmailPayload, type SendRequest } from "../src/asks/email.js";
import type { EmailAccount } from "../src/config.js";
import type { OutgoingMail } from "../src/sources/email.js";
import type { MailSent } from "../src/sources/smtp.js";
import { Store, type AskState } from "../src/store.js";
import { FakeConversation } from "./helpers/conversation.js";

const MINUTE = 60_000;
const account: EmailAccount = { account: "tady", shared: true, address: "me@tady.ch", addresses: [], password: "p", imap: { host: "i", port: 993 }, smtp: { host: "s", port: 465 }, mailboxes: ["INBOX"], tellAddress: true };
const mail = (text = "Thanks, we are on it."): OutgoingMail => ({ from: "me@tady.ch", to: ["jane@x.com"], subject: "Re: Order 7", text, inReplyTo: "<m2@x.com>", references: ["<m2@x.com>"], messageId: `<c-${text.length}@tady.ch>` });

let store: Store;
let conv: FakeConversation;
let sent: OutgoingMail[];
let kicked: string[];
let sendAnswer: MailSent;
let now: number;
let accounts: EmailAccount[];
let kind: AskKind<EmailPayload>;
let asks: Asks;
let max: number;

const build = () => {
  kind = emailKind({
    store,
    accounts: () => accounts,
    send: async (_account, m) => {
      sent.push(m);
      return sendAnswer;
    },
  });
  asks = new Asks({ store, conv, now: () => now, kick: (clot) => void kicked.push(clot), after: () => () => undefined, emit: () => undefined, timeoutMs: () => 10 * MINUTE, kinds: [kind] });
};

const open = (req: SendRequest) => askEmail(asks, kind, max, "graphite", req, false);
const emails = () => store.openAsks("graphite").filter((ask) => ask.kind === "email");
const allow = () => asks.answer(emails()[0]!.id, { action: "allow" });
/** The Clot's notes since the last call. */
const notes = () => {
  const texts = store.notes("graphite").map((note) => note.text);
  store.clearNotes("graphite");
  return texts;
};
/** An email ask as a stop left it. */
const leftAs = (state: AskState, text: string, step?: EmailPayload["step"]) => {
  const payload: EmailPayload = { account: "tady", mail: mail(text), outsider: false, ...(step ? { step } : {}) };
  const id = store.createAsk({ kind: "email", clot: "graphite", payload, summary: `Email "${text}"`, openedAt: now, deadline: now + 10 * MINUTE, dedupe: text, outsider: false });
  if (state !== "open") store.moveAsk(id, "open", state);
};

beforeEach(() => {
  store = new Store(":memory:");
  conv = new FakeConversation();
  sent = [];
  kicked = [];
  sendAnswer = { ok: true };
  now = 1_000_000;
  max = 3;
  accounts = [account];
  store.upsertClot("graphite");
  store.createSession({ id: "s1", clot: "graphite", seed: null });
  build();
});

describe("the email ask", () => {
  it("shows the email as an editable card and sends nothing yet", async () => {
    expect(await open({ account: "tady", mail: mail() })).toBe(SEND_FILED);
    const [ask] = emails();
    expect(asks.snapshot(ask)!.view).toEqual({
      heading: "Send an email from graphite?",
      shortHeading: "Send an email?",
      rows: [
        { label: "From", value: "me@tady.ch" },
        { label: "To", value: "jane@x.com" },
        { label: "Subject", value: "Re: Order 7" },
      ],
      body: "Thanks, we are on it.",
      bodyEditable: true,
      labels: { allow: "Send", block: "Don't send" },
    });
    expect(ask.deadline).toBe(now + 10 * MINUTE);
    expect(sent).toEqual([]);
  });

  it("names the email an ask answers", async () => {
    store.insertEvent({ id: "email:tady:<m2@x.com>", source: "email", account: "tady", kind: "message", place: "tady", actor: "jane", title: "Order 7", body: "", url: "", ref: "", subject: "", automated: false, outsider: false, receivedAt: 0 });
    await open({ account: "tady", event: "email:tady:<m2@x.com>", mail: mail() });
    expect(asks.snapshot(emails()[0]!)!.view.rows.at(-1)).toEqual({ label: "Answering", value: '"Order 7"' });
  });

  it("refuses the same email twice and more than the limit", async () => {
    max = 2;
    await open({ account: "tady", mail: mail() });
    expect(await open({ account: "tady", mail: { ...mail(), messageId: "<other@tady.ch>" } })).toContain("already with the user");
    await open({ account: "tady", mail: mail("Second.") });
    expect(await open({ account: "tady", mail: mail("Third.") })).toContain("Not filed: 2 emails");
  });

  it("sends on Allow, once, and tells the user and the Clot", async () => {
    await open({ account: "tady", mail: mail() });
    const id = emails()[0]!.id;
    await Promise.all([asks.answer(id, { action: "allow" }), asks.answer(id, { action: "allow" })]);
    expect(sent).toHaveLength(1);
    expect(conv.texts()[0]).toBe("Sent an email · you allowed it");
    expect(notes()[0]).toContain("the daemon sent it");
    expect(store.conversation.askOutcome(id)!.outcome).toBe("Sent an email · you allowed it");
  });

  it("sends the edited body, and tells the Clot which lines the user changed", async () => {
    await open({ account: "tady", mail: mail("Hello Jane.\nWe will refund you.\nBest, Me") });
    const id = emails()[0]!.id;
    expect(await asks.answer(id, { action: "edit", body: "Hello Jane.\nWe will refund you today.\nBest, Me" })).toMatchObject({ status: "answered" });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toBe("Hello Jane.\nWe will refund you today.\nBest, Me");
    const [note] = notes();
    expect(note).toContain("the daemon sent it");
    expect(note).toContain("The user changed the text before sending it.");
    expect(note).toContain("- We will refund you.");
    expect(note).toContain("+ We will refund you today.");
    expect(conv.texts()[0]).toBe("Sent an email · you allowed it (with your changes)");
  });

  it("sends an unchanged body as it was, with no note about changes", async () => {
    await open({ account: "tady", mail: mail() });
    await asks.answer(emails()[0]!.id, { action: "edit", body: mail().text });
    expect(sent[0]!.text).toBe(mail().text);
    expect(notes()[0]).not.toContain("changed the text");
  });

  it("works out the lines taken out and put in", () => {
    expect(changedLines("a\nb\nc", "a\nB\nc\nd")).toEqual({ removed: ["b"], added: ["B", "d"] });
    expect(changedLines("a\n\nb", "a\nb")).toEqual({ removed: [], added: [] });
  });

  it("tells the user and the Clot who did not get an email the server took only in part", async () => {
    sendAnswer = { ok: true, rejected: ["gone@x.com"], noCopy: "no Sent folder" };
    await open({ account: "tady", mail: mail() });
    await allow();
    expect(conv.texts()[0]).toContain("the mail server refused gone@x.com, so it did not go to them; no copy could be put in Sent: no Sent folder");
    expect(notes()[0]).toContain("Tell the user who did not get it.");
  });

  it("closes a half-done send as unknown at startup", async () => {
    await open({ account: "tady", mail: mail() });
    leftAs("busy", "Other.", "sending");
    await asks.sweep(true);
    const texts = notes();
    expect(texts.some((text) => text.includes("whether it finished is not known") || text.includes("whether it went out is not known"))).toBe(true);
    expect(emails()).toHaveLength(1);
    expect(sent).toEqual([]);
  });

  it("says when an approved email was refused, and when it may or may not have gone", async () => {
    sendAnswer = { ok: false, refused: true, reason: "the mail server refused it (550)" };
    await open({ account: "tady", mail: mail() });
    await allow();
    expect(notes()[0]).toContain("it was not sent: the mail server refused it (550)");
    sendAnswer = { ok: false, refused: false, reason: "timeout" };
    await open({ account: "tady", mail: mail("Other.") });
    await allow();
    expect(notes()[0]).toContain("whether it went out is not known");
  });

  it("says the account is gone when it is no longer configured", async () => {
    await open({ account: "tady", mail: mail() });
    accounts = [];
    await allow();
    expect(sent).toEqual([]);
    expect(notes()[0]).toContain("is not configured any more");
  });

  it("drops it on Block", async () => {
    await open({ account: "tady", mail: mail() });
    await asks.answer(emails()[0]!.id, { action: "block" });
    expect(sent).toEqual([]);
    expect(notes()[0]).toContain("declined your email");
    expect(emails()).toEqual([]);
  });

  it("hands text typed in the chat to the Clot as feedback, with the email, in the same step as the close", async () => {
    await open({ account: "tady", event: "email:tady:<m2@x.com>", mail: mail() });
    expect(await asks.onUserMessage("graphite", "Mention the refund is on its way.")).toBe(true);
    expect(sent).toEqual([]);
    const row = store.nextPending("graphite")!;
    expect(row).toMatchObject({ kind: "message", outsider: false });
    expect(row.text).toContain("> Thanks, we are on it.");
    expect(row.text).toContain("It answered the email email:tady:<m2@x.com>.");
    expect(row.text).toContain("Mention the refund is on its way.");
    expect(kicked).toEqual(["graphite"]);
    expect(conv.texts()[0]).toContain("Feedback on the email");
    expect(emails()).toEqual([]);
  });

  it("taints the feedback turn when the email was asked for in an outsider's turn", async () => {
    await askEmail(asks, kind, max, "graphite", { account: "tady", mail: mail() }, true);
    await asks.onUserMessage("graphite", "Shorter.");
    expect(store.nextPending("graphite")).toMatchObject({ outsider: true });
  });

  it("is blocked at its deadline: not sent, the Clot told, the card says Blocked", async () => {
    await open({ account: "tady", mail: mail() });
    const id = emails()[0]!.id;
    now += 10 * MINUTE;
    await asks.sweep(false);
    expect(emails()).toEqual([]);
    expect(sent).toEqual([]);
    expect(conv.texts()).toEqual(["Blocked: no answer within 10 minutes."]);
    expect(notes()[0]).toContain("so it was not sent");
    expect(store.conversation.askOutcome(id)!.outcome).toBe("Blocked: no answer within 10 minutes.");
  });

  it("takes the same text answering another email as an ask of its own", async () => {
    await open({ account: "tady", event: "email:tady:<a@x.com>", mail: mail() });
    expect(await open({ account: "tady", event: "email:tady:<b@x.com>", mail: mail() })).toBe(SEND_FILED);
    expect(await open({ account: "tady", event: "email:tady:<b@x.com>", mail: mail() })).toContain("already with the user");
  });

  it("closes, at startup only, the asks a stop caught half-way, and tries nothing again", async () => {
    leftAs("busy", "Bb.", "sending");
    await asks.sweep(false);
    expect(emails()).toHaveLength(1);
    await asks.sweep(true);
    expect(emails()).toEqual([]);
    expect(notes()[0]).toContain("stopped while sending it: whether it went out is not known");
    expect(sent).toEqual([]);
  });

  it("reads the accounts as they are now, so the first inbox added needs no restart", async () => {
    accounts = [];
    build();
    accounts = [account];
    await open({ account: "tady", mail: mail() });
    await allow();
    expect(sent).toHaveLength(1);
  });
});
