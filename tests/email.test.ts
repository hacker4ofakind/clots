import { describe, expect, it } from "vitest";
import { simpleParser } from "mailparser";
import type { EmailAccount } from "../src/config.js";
import {
  emailEvent,
  fromParsed,
  gmailLink,
  htmlToText,
  isAutomatedMail,
  isOwnAddress,
  metaOf,
  newMail,
  placeOf,
  replyMail,
  threadSubject,
  trimQuoted,
  type Mail,
} from "../src/sources/email.js";

const account: EmailAccount = { account: "gmail", shared: true, address: "me@gmail.com", addresses: ["support@shop.ch"], password: "p", imap: { host: "i", port: 993 }, smtp: { host: "s", port: 465 }, mailboxes: ["Clots"] };

const RAW = [
  "Delivered-To: me+shop@gmail.com",
  "Message-ID: <m2@example.com>",
  "In-Reply-To: <m1@example.com>",
  "References: <m0@example.com> <m1@example.com>",
  "From: Jane Doe <Jane@Example.com>",
  "Reply-To: jane.private@example.com",
  "To: Me <me+shop@gmail.com>",
  "Cc: other@example.com",
  "Subject: Order 7 never arrived",
  "Date: Tue, 14 Oct 2026 09:30:00 +0000",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "Hi, my order 7 never arrived. Can you check?",
  "",
  "On Mon, 13 Oct 2026 at 10:00, Me <me+shop@gmail.com>",
  "wrote:",
  "> Thanks for your order.",
  "",
].join("\r\n");

const mail = async (raw = RAW) => fromParsed(await simpleParser(raw));

describe("fromParsed", () => {
  it("reads the addresses, the thread and the headers that matter", async () => {
    const m = await mail();
    expect(m).toMatchObject({
      messageId: "<m2@example.com>",
      inReplyTo: "<m1@example.com>",
      references: ["<m0@example.com>", "<m1@example.com>"],
      from: { address: "jane@example.com", name: "Jane Doe" },
      replyTo: "jane.private@example.com",
      to: ["me+shop@gmail.com"],
      cc: ["other@example.com"],
      deliveredTo: ["me+shop@gmail.com"],
      subject: "Order 7 never arrived",
    });
    expect(m.text).toContain("my order 7 never arrived");
  });

  it("makes text from HTML when there is no plain part", async () => {
    const m = await mail(["From: a@b.c", "To: me@gmail.com", "Subject: Hi", "Content-Type: text/html", "", "<p>Hello <b>there</b></p><p>Line two&amp;more</p>"].join("\r\n"));
    // mailparser may make the text itself, with blank lines between paragraphs.
    expect(m.text.replace(/\n+/g, "\n")).toBe("Hello there\nLine two&more");
  });
});

describe("text", () => {
  it("drops the quoted earlier messages", () => {
    expect(trimQuoted("New text.\n\nOn Mon, 13 Oct 2026 at 10:00, Me <me@x.ch> wrote:\n> old\n> older")).toBe("New text.");
    expect(trimQuoted("New text.\nOn Mon, 13 Oct 2026 at 10:00, Me <me@\nx.ch> wrote:\n> old")).toBe("New text.");
    expect(trimQuoted("Top.\n> quoted\nBottom.")).toBe("Top.\nBottom.");
    expect(trimQuoted("Reply.\n-----Original Message-----\nFrom: x")).toBe("Reply.");
  });

  it("turns HTML into lines of text", () => {
    expect(htmlToText("<style>p{}</style><div>One<br>Two</div><p>Three &lt;4&gt;</p>")).toBe("One\nTwo\nThree <4>");
  });
});

describe("addresses", () => {
  it("knows the account's own addresses and their +aliases", () => {
    expect(isOwnAddress(account, "ME@gmail.com")).toBe(true);
    expect(isOwnAddress(account, "me+shop@gmail.com")).toBe(true);
    expect(isOwnAddress(account, "support@shop.ch")).toBe(true);
    expect(isOwnAddress(account, "support+x@shop.ch")).toBe(true);
    expect(isOwnAddress(account, "someone@gmail.com")).toBe(false);
  });

  it("places a message at the first own address among Delivered-To, To and Cc", async () => {
    expect(placeOf(account, await mail())).toBe("me+shop@gmail.com");
    const m: Mail = { ...(await mail()), deliveredTo: [], to: ["friend@x.ch"], cc: ["support@shop.ch"] };
    expect(placeOf(account, m)).toBe("support@shop.ch");
    expect(placeOf(account, { ...m, cc: [] })).toBe("me@gmail.com");
  });
});

describe("what kind of mail", () => {
  it("knows mail from a list or a program", async () => {
    const base = await mail();
    expect(isAutomatedMail(base)).toBe(false);
    expect(isAutomatedMail({ ...base, headers: { "list-id": "<news.x.com>" } })).toBe(true);
    expect(isAutomatedMail({ ...base, headers: { "auto-submitted": "auto-replied" } })).toBe(true);
    expect(isAutomatedMail({ ...base, headers: { "auto-submitted": "no" } })).toBe(false);
    expect(isAutomatedMail({ ...base, headers: { precedence: "bulk" } })).toBe(true);
  });

  it("names the thread by its first message", async () => {
    const m = await mail();
    expect(threadSubject(m, "x")).toBe("thread:<m0@example.com>");
    expect(threadSubject({ ...m, references: [] }, "x")).toBe("thread:<m1@example.com>");
    expect(threadSubject({ ...m, references: [], inReplyTo: undefined }, "x")).toBe("thread:<m2@example.com>");
    expect(threadSubject({ ...m, references: [], inReplyTo: undefined, messageId: undefined }, "Clots:9:4")).toBe("thread:Clots:9:4");
  });

  it("links a Gmail thread", () => {
    expect(gmailLink("1812345678901234567")).toBe("https://mail.google.com/mail/u/0/#all/1926becaf11f4b87");
  });
});

describe("emailEvent", () => {
  it("turns a message into an event, with the quoted part left out and the attachments named", async () => {
    const m: Mail = { ...(await mail()), attachments: [{ filename: "receipt.pdf", contentType: "application/pdf", size: 120_000 }] };
    const event = emailEvent({ account, mailbox: "Clots", uid: 4, uidValidity: "9", threadId: "1812345678901234567", mail: m, tooLarge: false }, 1000);
    expect(event).toMatchObject({
      id: "email:gmail:<m2@example.com>",
      source: "email",
      account: "gmail",
      kind: "email",
      place: "me+shop@gmail.com",
      actor: "jane@example.com",
      title: "Order 7 never arrived",
      url: "https://mail.google.com/mail/u/0/#all/1926becaf11f4b87",
      ref: "<m2@example.com>",
      subject: "thread:<m0@example.com>",
      automated: false,
      receivedAt: 1000,
    });
    expect(event.body).toContain("From: Jane Doe <jane@example.com>");
    expect(event.body).toContain("my order 7 never arrived");
    expect(event.body).not.toContain("Thanks for your order");
    expect(event.body).toContain("Attachments (not read): receipt.pdf (application/pdf, 117 KB)");
  });

  it("says when only the headers were read, and names a message with no Message-ID by its place in the mailbox", async () => {
    const m: Mail = { ...(await mail()), messageId: undefined, text: "" };
    const event = emailEvent({ account, mailbox: "Clots", uid: 4, uidValidity: "9", mail: m, tooLarge: true }, 1000);
    expect(event.id).toBe("email:gmail:Clots:9:4");
    expect(event.url).toBe("");
    expect(event.body).toContain("larger than 5 MB");
  });
});

describe("outgoing mail", () => {
  it("answers in the thread, from the address the mail came to, to its Reply-To", async () => {
    const m = await mail();
    const event = emailEvent({ account, mailbox: "Clots", uid: 4, uidValidity: "9", mail: m, tooLarge: false }, 0);
    expect(replyMail(event, metaOf(m), "We are on it.", "<c1@gmail.com>")).toEqual({
      from: "me+shop@gmail.com",
      to: ["jane.private@example.com"],
      subject: "Re: Order 7 never arrived",
      text: "We are on it.",
      inReplyTo: "<m2@example.com>",
      references: ["<m0@example.com>", "<m1@example.com>", "<m2@example.com>"],
      messageId: "<c1@gmail.com>",
    });
    expect(replyMail({ ...event, title: "RE: Order 7" }, { ...metaOf(m), replyTo: "" }, "x", "<c2@gmail.com>")).toMatchObject({ to: ["jane@example.com"], subject: "RE: Order 7" });
  });

  it("writes a new message from the account's own address", () => {
    expect(newMail(account, ["lukas@tady.ch"], "Rebooking", "Can we move it?", "<c3@gmail.com>")).toEqual({ from: "me@gmail.com", to: ["lukas@tady.ch"], subject: "Rebooking", text: "Can we move it?", references: [], messageId: "<c3@gmail.com>" });
  });
});
