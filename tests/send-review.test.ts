import { beforeEach, describe, expect, it } from "vitest";
import type { InboundMessage } from "../src/chat/adapter.js";
import { FakeChat } from "../src/chat/fake.js";
import type { EmailAccount } from "../src/config.js";
import { SEND_FILED, SendReviews, span } from "../src/send-review.js";
import { ownMessageKey, type OutgoingMail } from "../src/sources/email.js";
import type { MailSent } from "../src/sources/smtp.js";
import { Store } from "../src/store.js";

const USER = "user-1";
const DAY = 86_400_000;
const account: EmailAccount = { account: "tady", shared: true, address: "me@tady.ch", addresses: [], password: "p", imap: { host: "i", port: 993 }, smtp: { host: "s", port: 465 }, mailboxes: ["INBOX"], tellAddress: true };
const mail = (text = "Thanks, we are on it."): OutgoingMail => ({ from: "me@tady.ch", to: ["jane@x.com"], subject: "Re: Order 7", text, inReplyTo: "<m2@x.com>", references: ["<m2@x.com>"], messageId: `<c-${text.length}@tady.ch>` });

let store: Store;
let chat: FakeChat;
let said: string[];
let sent: OutgoingMail[];
let drafts: OutgoingMail[];
let feedback: { clot: string; text: string }[];
let sendAnswer: MailSent;
let draftFails: boolean;
let feedbackFails: boolean;
let now: number;
let n: number;
let channelsAtFeedback: number;

function reply(channelId: string, text: string, authorId = USER): InboundMessage {
  n += 1;
  return { id: `r${n}`, channelId, authorId, text, at: new Date(0) };
}

const build = (max = 3) =>
  new SendReviews({
    store,
    chat,
    userId: USER,
    accounts: [account],
    max,
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
    feedback: async (clot, text) => {
      channelsAtFeedback = chat.channels.length;
      if (feedbackFails) return false;
      feedback.push({ clot, text });
      return true;
    },
    say: async (_clot, text) => void said.push(text),
  });

let reviews: SendReviews;
const channel = () => store.openSendReviews("graphite")[0].channelId;
/** The Clot's notes since the last call. */
const notes = () => {
  const texts = store.notes("graphite").map((note) => note.text);
  store.clearNotes("graphite");
  return texts;
};

beforeEach(async () => {
  store = new Store(":memory:");
  chat = new FakeChat();
  said = [];
  sent = [];
  drafts = [];
  feedback = [];
  sendAnswer = { ok: true };
  draftFails = false;
  feedbackFails = false;
  now = 1_000_000;
  n = 0;
  const category = await chat.ensureCategory("graphite");
  store.upsertClot("graphite", category);
  store.createSession({ id: "s1", clot: "graphite", channelId: await chat.createChannel(category, "graphite-1610"), seed: null });
  reviews = build();
});

describe("span", () => {
  it("names a length of time in days, hours or minutes", () => {
    expect([3 * DAY, 1.5 * DAY, DAY, 2 * 3_600_000, 86_400, 60_000].map(span)).toEqual(["3 days", "1.5 days", "1 day", "2 hours", "1.4 minutes", "1 minute"]);
  });
});

describe("SendReviews", () => {
  it("shows the email in a temporary channel and sends nothing yet", async () => {
    expect(await reviews.open("graphite", { account: "tady", mail: mail() })).toBe(SEND_FILED);
    const [open] = store.openSendReviews("graphite");
    expect(chat.channels.find((c) => c.id === open.channelId)?.name).toBe("graphite-mail");
    const posted = chat.postsIn(open.channelId)[0];
    expect(posted).toContain("<@user-1> graphite asks to send this email from tady");
    expect(posted).toContain("To: jane@x.com");
    expect(posted).toContain("> Thanks, we are on it.");
    expect(posted).toContain("`draft`");
    expect(sent).toEqual([]);
  });

  it("refuses the same email twice and more than the limit", async () => {
    reviews = build(2);
    await reviews.open("graphite", { account: "tady", mail: mail() });
    expect(await reviews.open("graphite", { account: "tady", mail: { ...mail(), messageId: "<other@tady.ch>" } })).toContain("already with the user");
    await reviews.open("graphite", { account: "tady", mail: mail("Second.") });
    expect(await reviews.open("graphite", { account: "tady", mail: mail("Third.") })).toContain("Not filed: 2 emails");
  });

  it("sends on a yes, once, and tells the user and the Clot", async () => {
    await reviews.open("graphite", { account: "tady", mail: mail() });
    const id = channel();
    expect(await reviews.onReply(reply(id, "Yes!"))).toBe(true);
    await reviews.onReply(reply(id, "yes"));
    expect(sent).toHaveLength(1);
    expect(said[0]).toContain("Sent, as you approved");
    expect(notes()[0]).toContain("the daemon sent it");
    expect(chat.deleted).toContain(id);
  });

  it("says when an approved email was refused, and when it may or may not have gone", async () => {
    sendAnswer = { ok: false, refused: true, reason: "the mail server refused it (550)" };
    await reviews.open("graphite", { account: "tady", mail: mail() });
    await reviews.onReply(reply(channel(), "yes"));
    expect(notes()[0]).toContain("it was not sent: the mail server refused it (550)");
    sendAnswer = { ok: false, refused: false, reason: "timeout" };
    await reviews.open("graphite", { account: "tady", mail: mail("Other.") });
    await reviews.onReply(reply(channel(), "yes"));
    expect(notes()[0]).toContain("whether it went out is not known");
  });

  it("drops it on a no", async () => {
    await reviews.open("graphite", { account: "tady", mail: mail() });
    await reviews.onReply(reply(channel(), "no"));
    expect(sent).toEqual([]);
    expect(notes()[0]).toContain("declined your email");
    expect(store.openSendReviews()).toEqual([]);
  });

  it("saves it as a followed draft on `draft`, and asks again when it cannot", async () => {
    draftFails = true;
    await reviews.open("graphite", { account: "tady", mail: mail() });
    const id = channel();
    await reviews.onReply(reply(id, "draft"));
    expect(store.openSendReviews("graphite")[0].channelId).toBe(id);
    expect(chat.postsIn(id).at(-1)).toContain("could not be saved just now");
    draftFails = false;
    await reviews.onReply(reply(id, "Draft."));
    expect(drafts).toHaveLength(1);
    expect(sent).toEqual([]);
    expect(store.getState(ownMessageKey(drafts[0].messageId))).toBe("1");
    expect(JSON.parse(store.getState("pending-drafts:graphite")!)).toMatchObject([{ account: "tady", subject: "Re: Order 7" }]);
    expect(notes()[0]).toContain("saved as a draft in Drafts");
  });

  it("hands any other reply to the Clot as feedback, with the email, and closes the channel", async () => {
    await reviews.open("graphite", { account: "tady", event: "email:tady:<m2@x.com>", mail: mail() });
    const id = channel();
    await reviews.onReply(reply(id, "Mention the refund is on its way."));
    expect(sent).toEqual([]);
    expect(feedback[0].clot).toBe("graphite");
    expect(feedback[0].text).toContain("> Thanks, we are on it.");
    expect(feedback[0].text).toContain("It answered the email email:tady:<m2@x.com>.");
    expect(feedback[0].text).toContain("Mention the refund is on its way.");
    expect(said[0]).toContain("Feedback on the email");
    expect(chat.deleted).toContain(id);
    // The channel is gone before the Clot gets to work on the feedback.
    expect(channelsAtFeedback).toBe(1);
    expect(store.openSendReviews()).toEqual([]);
  });

  it("leaves the feedback as a note when it cannot be handed over", async () => {
    feedbackFails = true;
    await reviews.open("graphite", { account: "tady", mail: mail() });
    await reviews.onReply(reply(channel(), "Shorter."));
    expect(notes()[0]).toContain("Shorter.");
  });

  it("ignores others in the channel, and leaves other channels alone", async () => {
    await reviews.open("graphite", { account: "tady", mail: mail() });
    expect(await reviews.onReply(reply(channel(), "yes", "someone-else"))).toBe(true);
    expect(await reviews.onReply(reply("elsewhere", "yes"))).toBe(false);
    expect(sent).toEqual([]);
    expect(store.openSendReviews()).toHaveLength(1);
  });

  it("withdraws a review left unanswered too long, or whose channel is gone", async () => {
    await reviews.open("graphite", { account: "tady", mail: mail() });
    now += 2 * DAY;
    await reviews.open("graphite", { account: "tady", mail: mail("Later.") });
    await reviews.closeStale();
    expect(store.openSendReviews()).toHaveLength(2);
    now += DAY;
    await reviews.closeStale();
    expect(store.openSendReviews()).toHaveLength(1);
    expect(said[0]).toContain("Withdrawn after 3 days");
    expect(notes()[0]).toContain("waited 3 days");
    await chat.deleteChannel(channel());
    await reviews.closeStale();
    expect(store.openSendReviews()).toEqual([]);
    expect(notes()[0]).toContain("its review channel was removed");
    expect(sent).toEqual([]);
  });
});
