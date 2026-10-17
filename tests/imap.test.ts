import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EmailAccount } from "../src/config.js";
import type { ClotEvent } from "../src/events/types.js";
import { emailMetaKey, ownMessageKey } from "../src/sources/email.js";
import { MailboxListener, startPosition, type FetchedMail, type ImapClient } from "../src/sources/imap.js";
import { Store } from "../src/store.js";

const account: EmailAccount = { account: "gmail", shared: true, address: "me@gmail.com", addresses: [], password: "p", imap: { host: "i", port: 993 }, smtp: { host: "s", port: 465 }, mailboxes: ["Clots"], tellAddress: true };

const message = (n: number) => Buffer.from([`Message-ID: <m${n}@x.com>`, "From: jane@x.com", "To: me+shop@gmail.com", `Subject: Message ${n}`, "", `Body ${n}`].join("\r\n"));

class FakeClient implements ImapClient {
  mail: FetchedMail[] = [];
  status = { uidValidity: "9", uidNext: 1 };
  private newMail: () => void = () => undefined;
  private close!: () => void;
  private closedPromise = new Promise<void>((resolve) => (this.close = resolve));
  async connect() {}
  async open() {
    return this.status;
  }
  async *fetchAfter(uid: number) {
    for (const m of this.mail.filter((m) => m.uid > uid)) yield m;
  }
  onNewMail(fn: () => void) {
    this.newMail = fn;
  }
  arrive(m: FetchedMail) {
    this.mail.push(m);
    this.status = { ...this.status, uidNext: m.uid + 1 };
    this.newMail();
  }
  closed() {
    return this.closedPromise;
  }
  end() {
    this.close();
  }
  async logout() {}
}

let store: Store;
let client: FakeClient;
let delivered: { id: string; dropped?: string }[];
const listener = () => new MailboxListener({ account, mailbox: "Clots", client: () => client, store, deliver: (event: ClotEvent, dropped?: string) => void delivered.push({ id: event.id, dropped }), now: () => 1000 });
/** Waits until what a read should have done is done: parsing takes longer while the whole suite runs. */
const until = (check: () => void) => vi.waitFor(check, { timeout: 2000, interval: 10 });

beforeEach(() => {
  store = new Store(":memory:");
  client = new FakeClient();
  delivered = [];
});

describe("startPosition", () => {
  it("starts at the end of a mailbox seen for the first time or renumbered, and where it stopped otherwise", () => {
    expect(startPosition(undefined, { uidValidity: "9", uidNext: 50 })).toEqual({ uidValidity: "9", lastUid: 49 });
    expect(startPosition({ uidValidity: "8", lastUid: 10 }, { uidValidity: "9", uidNext: 50 })).toEqual({ uidValidity: "9", lastUid: 49 });
    expect(startPosition({ uidValidity: "9", lastUid: 10 }, { uidValidity: "9", uidNext: 50 })).toEqual({ uidValidity: "9", lastUid: 10 });
  });
});

describe("MailboxListener", () => {
  it("reports nothing that was there before the first connection, then each new message once", async () => {
    client.mail = [{ uid: 1, size: 100, source: message(1) }];
    client.status = { uidValidity: "9", uidNext: 2 };
    let ready = false;
    const run = listener().run(() => void (ready = true));
    // Ready is called once the first read is done, so nothing more can be reported for what was there.
    await until(() => expect(ready).toBe(true));
    expect(delivered).toEqual([]);

    client.arrive({ uid: 2, size: 100, source: message(2) });
    await until(() => expect(delivered).toEqual([{ id: "email:gmail:<m2@x.com>", dropped: undefined }]));
    expect(store.getEvent("email:gmail:<m2@x.com>")).toMatchObject({ place: "me+shop@gmail.com", title: "Message 2" });
    expect(JSON.parse(store.getState(emailMetaKey("email:gmail:<m2@x.com>"))!)).toMatchObject({ messageId: "<m2@x.com>" });
    client.end();
    await run;
  });

  it("ends the run when a read of new mail fails, so the supervisor connects again", async () => {
    let ready = false;
    const run = listener().run(() => void (ready = true));
    await until(() => expect(ready).toBe(true));
    client.fetchAfter = async function* () {
      throw new Error("connection reset");
    };
    client.arrive({ uid: 1, size: 100, source: message(1) });
    // The connection stays open: the run must end on the failed read, not wait for it to close.
    await expect(run).rejects.toThrow("connection reset");
  });

  it("catches up on what arrived while it was away, after a restart", async () => {
    store.setState("imap:gmail:Clots", JSON.stringify({ uidValidity: "9", lastUid: 1 }));
    client.mail = [1, 2, 3].map((uid) => ({ uid, size: 100, source: message(uid) }));
    client.status = { uidValidity: "9", uidNext: 4 };
    let ready = false;
    const run = listener().run(() => void (ready = true));
    await until(() => expect(ready).toBe(true));
    expect(delivered.map((d) => d.id)).toEqual(["email:gmail:<m2@x.com>", "email:gmail:<m3@x.com>"]);
    expect(JSON.parse(store.getState("imap:gmail:Clots")!)).toEqual({ uidValidity: "9", lastUid: 3 });
    client.end();
    await run;
  });

  it("drops mail the daemon wrote itself, and reads only the headers of a message that is too large", async () => {
    store.setState(ownMessageKey("<m2@x.com>"), "1");
    let ready = false;
    const run = listener().run(() => void (ready = true));
    await until(() => expect(ready).toBe(true));
    client.arrive({ uid: 2, size: 100, source: message(2) });
    client.arrive({ uid: 3, size: 9_000_000, headers: message(3) });
    await until(() =>
      expect(delivered).toEqual([
        { id: "email:gmail:<m2@x.com>", dropped: "caused by the Clot itself" },
        { id: "email:gmail:<m3@x.com>", dropped: undefined },
      ]),
    );
    expect(store.getEvent("email:gmail:<m3@x.com>")!.body).toContain("larger than 5 MB");
    client.end();
    await run;
  });
});
