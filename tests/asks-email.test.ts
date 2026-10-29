import { beforeEach, describe, expect, it } from "vitest";
import { Asks, type AskKind } from "../src/asks.js";
import { askEmail, emailKind, SEND_FILED, span, type EmailPayload, type SendRequest } from "../src/asks/email.js";
import type { InboundMessage } from "../src/chat/adapter.js";
import { FakeChat } from "../src/chat/fake.js";
import type { EmailAccount } from "../src/config.js";
import { ownMessageKey, type OutgoingMail } from "../src/sources/email.js";
import type { MailSent } from "../src/sources/smtp.js";
import { Store, type AskState } from "../src/store.js";

const USER = "user-1";
const DAY = 86_400_000;
const account: EmailAccount = { account: "tady", shared: true, address: "me@tady.ch", addresses: [], password: "p", imap: { host: "i", port: 993 }, smtp: { host: "s", port: 465 }, mailboxes: ["INBOX"], tellAddress: true };
const mail = (text = "Thanks, we are on it."): OutgoingMail => ({ from: "me@tady.ch", to: ["jane@x.com"], subject: "Re: Order 7", text, inReplyTo: "<m2@x.com>", references: ["<m2@x.com>"], messageId: `<c-${text.length}@tady.ch>` });

let store: Store;
let chat: FakeChat;
let said: string[];
let sent: OutgoingMail[];
let drafts: OutgoingMail[];
let kicked: string[];
let sendAnswer: MailSent;
let draftFails: boolean;
let now: number;
let n: number;

function reply(channelId: string, text: string, authorId = USER): InboundMessage {
  n += 1;
  return { id: `r${n}`, channelId, authorId, text, at: new Date(0) };
}

let kind: AskKind<EmailPayload>;
let asks: Asks;
let max: number;

const build = (withEmail = true) => {
  kind = emailKind({
    store,
    accounts: [account],
    maxMs: 3 * DAY,
    now: () => now,
    send: async (_account, m) => {
      sent.push(m);
      return sendAnswer;
    },
    saveDraft: async (_account, m) => {
      if (draftFails) throw new Error("no Drafts folder");
      drafts.push(m);
      return { mailbox: "Drafts" };
    },
    say: async (_clot, text) => void said.push(text),
  });
  asks = new Asks({ store, chat, userId: USER, now: () => now, kick: (clot) => void kicked.push(clot), say: async (_clot, text) => void said.push(text), after: () => () => undefined, kinds: withEmail ? [kind] : [] });
};

const open = (req: SendRequest) => askEmail(asks, kind, max, "graphite", req, false);
const emails = () => store.openAsks("graphite").filter((ask) => ask.kind === "email");
const channel = () => emails()[0].channelId;
/** The Clot's notes since the last call. */
const notes = () => {
  const texts = store.notes("graphite").map((note) => note.text);
  store.clearNotes("graphite");
  return texts;
};
/** An email ask as a stop left it. */
const leftAs = async (state: AskState, text: string, step?: EmailPayload["step"]) => {
  const payload: EmailPayload = { account: "tady", mail: mail(text), outsider: false, ...(step ? { step } : {}) };
  const id = store.createAsk({ kind: "email", clot: "graphite", channelId: await chat.createChannel("cat-graphite", "graphite-mail"), channelName: "graphite-mail", payload, summary: `Email "${text}"`, openedAt: now, deadline: null, dedupe: text, outsider: false });
  if (state !== "posting") store.moveAsk(id, "posting", state);
};

beforeEach(async () => {
  store = new Store(":memory:");
  chat = new FakeChat();
  said = [];
  sent = [];
  drafts = [];
  kicked = [];
  sendAnswer = { ok: true };
  draftFails = false;
  now = 1_000_000;
  n = 0;
  max = 3;
  const category = await chat.ensureCategory("graphite");
  store.upsertClot("graphite", category);
  store.createSession({ id: "s1", clot: "graphite", channelId: await chat.createChannel(category, "graphite-1610"), seed: null });
  build();
});

describe("span", () => {
  it("names a length of time in days, hours or minutes", () => {
    expect([3 * DAY, 1.5 * DAY, DAY, 2 * 3_600_000, 86_400, 60_000].map(span)).toEqual(["3 days", "1.5 days", "1 day", "2 hours", "1.4 minutes", "1 minute"]);
  });
});

describe("the email ask", () => {
  it("shows the email in a temporary channel and sends nothing yet", async () => {
    expect(await open({ account: "tady", mail: mail() })).toBe(SEND_FILED);
    const [ask] = emails();
    expect(chat.channels.find((c) => c.id === ask.channelId)?.name).toBe("graphite-mail");
    const posted = chat.postsIn(ask.channelId)[0];
    expect(posted).toContain("<@user-1> graphite asks to send this email from tady");
    expect(posted).toContain("To: jane@x.com");
    expect(posted).toContain("> Thanks, we are on it.");
    expect(posted).toContain("`draft`");
    expect(sent).toEqual([]);
  });

  it("refuses the same email twice and more than the limit", async () => {
    max = 2;
    await open({ account: "tady", mail: mail() });
    expect(await open({ account: "tady", mail: { ...mail(), messageId: "<other@tady.ch>" } })).toContain("already with the user");
    await open({ account: "tady", mail: mail("Second.") });
    expect(await open({ account: "tady", mail: mail("Third.") })).toContain("Not filed: 2 emails");
  });

  it("sends on a yes, once, and tells the user and the Clot", async () => {
    await open({ account: "tady", mail: mail() });
    const id = channel();
    expect(await asks.onReply(reply(id, "Yes!"))).toBe(true);
    await asks.onReply(reply(id, "yes"));
    expect(sent).toHaveLength(1);
    expect(said[0]).toContain("Sent, as you approved");
    expect(notes()[0]).toContain("the daemon sent it");
    expect(chat.deleted).toContain(id);
  });

  it("tells the user and the Clot who did not get an email the server took only in part", async () => {
    sendAnswer = { ok: true, rejected: ["gone@x.com"], noCopy: "no Sent folder" };
    await open({ account: "tady", mail: mail() });
    await asks.onReply(reply(channel(), "yes"));
    expect(said[0]).toContain("the mail server refused gone@x.com, so it did not go to them; no copy could be put in Sent: no Sent folder");
    expect(notes()[0]).toContain("Tell the user who did not get it.");
  });

  it("withdraws every open email ask once send review is switched off, and closes a half-done one as unknown", async () => {
    await open({ account: "tady", mail: mail() });
    await leftAs("busy", "Other.", "sending");
    build(false);
    await asks.sweep(true);
    expect(emails()).toEqual([]);
    const texts = notes();
    expect(texts.some((text) => text.includes("whether it finished is not known"))).toBe(true);
    expect(texts.some((text) => text.includes("switched off"))).toBe(true);
    expect(chat.channels.map((c) => c.name)).toEqual(["graphite-1610"]);
    expect(sent).toEqual([]);
  });

  it("says when an approved email was refused, and when it may or may not have gone", async () => {
    sendAnswer = { ok: false, refused: true, reason: "the mail server refused it (550)" };
    await open({ account: "tady", mail: mail() });
    await asks.onReply(reply(channel(), "yes"));
    expect(notes()[0]).toContain("it was not sent: the mail server refused it (550)");
    sendAnswer = { ok: false, refused: false, reason: "timeout" };
    await open({ account: "tady", mail: mail("Other.") });
    await asks.onReply(reply(channel(), "yes"));
    expect(notes()[0]).toContain("whether it went out is not known");
  });

  it("drops it on a no", async () => {
    await open({ account: "tady", mail: mail() });
    await asks.onReply(reply(channel(), "no"));
    expect(sent).toEqual([]);
    expect(notes()[0]).toContain("declined your email");
    expect(emails()).toEqual([]);
  });

  it("saves it as a followed draft on `draft`, and asks again when it cannot", async () => {
    draftFails = true;
    await open({ account: "tady", mail: mail() });
    const id = channel();
    await asks.onReply(reply(id, "draft"));
    expect(emails()[0]).toMatchObject({ channelId: id, state: "open" });
    expect(chat.postsIn(id).at(-1)).toContain("could not be saved just now");
    draftFails = false;
    await asks.onReply(reply(id, "Draft."));
    expect(drafts).toHaveLength(1);
    expect(sent).toEqual([]);
    expect(store.getState(ownMessageKey(drafts[0].messageId))).toBe("1");
    expect(JSON.parse(store.getState("pending-drafts:graphite")!)).toMatchObject([{ account: "tady", subject: "Re: Order 7" }]);
    expect(notes()[0]).toContain("saved as a draft in Drafts");
  });

  it("hands any other reply to the Clot as feedback, with the email, in the same step as the close", async () => {
    await open({ account: "tady", event: "email:tady:<m2@x.com>", mail: mail() });
    const id = channel();
    await asks.onReply(reply(id, "Mention the refund is on its way."));
    expect(sent).toEqual([]);
    const row = store.nextPending("graphite")!;
    expect(row).toMatchObject({ kind: "message", outsider: false });
    expect(row.text).toContain("> Thanks, we are on it.");
    expect(row.text).toContain("It answered the email email:tady:<m2@x.com>.");
    expect(row.text).toContain("Mention the refund is on its way.");
    expect(kicked).toEqual(["graphite"]);
    expect(said[0]).toContain("Feedback on the email");
    expect(chat.deleted).toContain(id);
    expect(emails()).toEqual([]);
  });

  it("taints the feedback turn when the email was asked for in an outsider's turn", async () => {
    await askEmail(asks, kind, max, "graphite", { account: "tady", mail: mail() }, true);
    await asks.onReply(reply(channel(), "Shorter."));
    expect(store.nextPending("graphite")).toMatchObject({ outsider: true });
  });

  it("ignores others in the channel, and leaves other channels alone", async () => {
    await open({ account: "tady", mail: mail() });
    expect(await asks.onReply(reply(channel(), "yes", "someone-else"))).toBe(true);
    expect(await asks.onReply(reply("elsewhere", "yes"))).toBe(false);
    expect(sent).toEqual([]);
    expect(emails()).toHaveLength(1);
  });

  it("takes no answer until the email is shown in full", async () => {
    await leftAs("posting", "A.");
    const id = emails()[0].channelId;
    await asks.onReply(reply(id, "yes"));
    expect(sent).toEqual([]);
    expect(chat.postsIn(id).at(-1)).toContain("still being shown");
    expect(emails()[0].state).toBe("posting");
  });

  it("takes the same text answering another email as an ask of its own", async () => {
    await open({ account: "tady", event: "email:tady:<a@x.com>", mail: mail() });
    expect(await open({ account: "tady", event: "email:tady:<b@x.com>", mail: mail() })).toBe(SEND_FILED);
    expect(await open({ account: "tady", event: "email:tady:<b@x.com>", mail: mail() })).toContain("already with the user");
  });

  it("does not send on a yes that came after the deadline", async () => {
    await open({ account: "tady", mail: mail() });
    now += 3 * DAY;
    await asks.onReply(reply(channel(), "yes"));
    expect(sent).toEqual([]);
    expect(notes()[0]).toContain("Withdrawn");
    expect(emails()).toEqual([]);
  });

  it("closes, at startup only, the asks a stop caught half-way, and tries nothing again", async () => {
    await leftAs("posting", "A.");
    await leftAs("busy", "Bb.", "sending");
    await leftAs("busy", "Ccc.", "drafting");
    await asks.sweep(false);
    expect(emails()).toHaveLength(3);
    await asks.sweep(true);
    expect(emails()).toEqual([]);
    const texts = notes();
    expect(texts[0]).toContain("the daemon stopped while showing it");
    expect(texts[1]).toContain("stopped while sending it: whether it went out is not known");
    expect(texts[2]).toContain("may or may not be in Drafts");
    expect(sent).toEqual([]);
    expect(drafts).toEqual([]);
  });

  it("withdraws an email left unanswered too long, or whose channel is gone", async () => {
    await open({ account: "tady", mail: mail() });
    now += 2 * DAY;
    await open({ account: "tady", mail: mail("Later.") });
    await asks.sweep(false);
    expect(emails()).toHaveLength(2);
    now += DAY;
    await asks.sweep(false);
    expect(emails()).toHaveLength(1);
    expect(said[0]).toContain("Withdrawn: Email");
    expect(notes()[0]).toContain("it waited 3 days for your answer");
    await chat.deleteChannel(channel());
    await asks.sweep(false);
    expect(emails()).toEqual([]);
    expect(notes()[0]).toContain("its channel was removed");
    expect(sent).toEqual([]);
  });
});
