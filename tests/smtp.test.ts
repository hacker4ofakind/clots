import { beforeEach, describe, expect, it } from "vitest";
import type { EmailAccount } from "../src/config.js";
import type { ClotEvent } from "../src/events/types.js";
import { emailMetaKey, ownMessageKey } from "../src/sources/email.js";
import { composeMail } from "../src/sources/imap.js";
import { emailReplySender } from "../src/sources/smtp.js";
import { Store } from "../src/store.js";

const account: EmailAccount = { account: "gmail", shared: true, address: "me@gmail.com", addresses: [], password: "p", imap: { host: "i", port: 993 }, smtp: { host: "s", port: 465 }, mailboxes: ["Clots"] };
const mail: ClotEvent = { id: "email:gmail:<m2@x.com>", source: "email", account: "gmail", kind: "email", place: "me+shop@gmail.com", actor: "jane@x.com", title: "Order 7", body: "", url: "https://mail.google.com/mail/u/0/#all/1", ref: "<m2@x.com>", subject: "thread:<m1@x.com>", automated: false, receivedAt: 0 };

let store: Store;
let sent: any[];
let answer: unknown;
const sender = () =>
  emailReplySender({
    accounts: [account],
    store,
    transport: () => ({
      sendMail: async (m: object) => {
        sent.push(m);
        if (answer instanceof Error) throw answer;
        return answer;
      },
    }),
  });

beforeEach(() => {
  store = new Store(":memory:");
  store.setState(emailMetaKey(mail.id), JSON.stringify({ messageId: "<m2@x.com>", replyTo: "", references: ["<m1@x.com>"], subject: "Order 7" }));
  sent = [];
  answer = { messageId: "x" };
});

describe("emailReplySender", () => {
  it("reaches a person's email, and not mail from a list or a program, nor another source", () => {
    expect(sender().reach(mail)).toBeUndefined();
    expect(sender().reach({ ...mail, automated: true })).toContain("program or a mailing list");
    expect(sender().reach({ ...mail, source: "github" })).toContain("answers emails");
    expect(sender().reach({ ...mail, account: "elsewhere" })).toContain("not configured");
  });

  it("replies in the thread from the alias, and remembers the reply as its own before sending", async () => {
    const result = await sender().send(mail, "Thanks, Jane.");
    expect(result).toEqual({ ok: true, url: mail.url });
    expect(sent[0]).toMatchObject({ from: "me+shop@gmail.com", to: ["jane@x.com"], subject: "Re: Order 7", text: "Thanks, Jane.", inReplyTo: "<m2@x.com>", references: ["<m1@x.com>", "<m2@x.com>"] });
    expect(store.getState(ownMessageKey(sent[0].messageId))).toBe("1");
  });

  it("calls a 5xx answer a refusal, and anything else uncertain", async () => {
    answer = Object.assign(new Error("Mailbox unavailable"), { responseCode: 550 });
    expect(await sender().send(mail, "x")).toEqual({ ok: false, refused: true, reason: "the mail server refused it (550 Mailbox unavailable)" });
    answer = Object.assign(new Error("Connection timeout"), { code: "ETIMEDOUT" });
    expect(await sender().send(mail, "x")).toMatchObject({ ok: false, refused: false });
  });
});

describe("composeMail", () => {
  it("writes a message with its threading headers", async () => {
    const raw = (await composeMail({ from: "me@gmail.com", to: ["a@b.c"], subject: "Re: Hi", text: "Hello.", inReplyTo: "<m1@x>", references: ["<m0@x>", "<m1@x>"], messageId: "<c1@gmail.com>" })).toString();
    expect(raw).toContain("Message-ID: <c1@gmail.com>");
    expect(raw).toContain("In-Reply-To: <m1@x>");
    expect(raw).toContain("References: <m0@x> <m1@x>");
    expect(raw).toContain("Hello.");
  });
});
