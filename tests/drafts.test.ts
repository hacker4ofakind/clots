import { beforeEach, describe, expect, it } from "vitest";
import { DraftTracker, recordDraft, type DraftFate, type PendingDraft } from "../src/drafts.js";
import { Store } from "../src/store.js";

const account = { account: "gmail", shared: true, address: "me@gmail.com", addresses: [], password: "p", imap: { host: "i", port: 993 }, smtp: { host: "s", port: 465 }, mailboxes: ["INBOX"] };
const draft = (id: string, text = "We are checking."): PendingDraft => ({ account: "gmail", messageId: `<${id}@gmail.com>`, subject: "Re: Order 7", to: ["jane@x.com"], text, savedAt: Date.UTC(2026, 9, 16, 9) });

describe("DraftTracker", () => {
  let store: Store;
  let fates: DraftFate[];
  let looked: PendingDraft[][];
  let fail: boolean;
  const tracker = (now = Date.UTC(2026, 9, 16, 12)) =>
    new DraftTracker({
      store,
      accounts: [account],
      lookup: async (_account, drafts) => {
        looked.push(drafts);
        if (fail) throw new Error("offline");
        return fates;
      },
      timeZone: "Europe/Zurich",
      now: () => now,
      log: () => undefined,
    });
  const notes = () => store.notes("graphite").map((note) => note.text);

  beforeEach(() => {
    store = new Store(":memory:");
    looked = [];
    fail = false;
  });

  it("does not look when there are no drafts", async () => {
    await tracker().check("graphite");
    expect(looked).toEqual([]);
  });

  it("notes a draft sent as written, with its time, and stops following it", async () => {
    recordDraft(store, "graphite", draft("a"));
    fates = [{ kind: "sent", at: new Date(Date.UTC(2026, 9, 16, 10, 5)), text: "We are\nchecking." }];
    await tracker().check("graphite");
    expect(notes()).toHaveLength(1);
    expect(notes()[0]).toContain('The user sent your email draft "Re: Order 7" to jane@x.com (gmail) at 16 Oct 2026, 12:05');
    expect(notes()[0]).toContain("as you wrote it");
    expect(notes()[0]).toContain("nothing needs doing");
    await tracker().check("graphite");
    expect(looked).toHaveLength(1);
  });

  it("quotes what was sent when it differs from the draft", async () => {
    recordDraft(store, "graphite", draft("a"));
    fates = [{ kind: "sent", at: new Date(), text: "We are checking.\nBest, L" }];
    await tracker().check("graphite");
    expect(notes()[0]).toContain("differs from your draft");
    expect(notes()[0]).toContain("> Best, L");
  });

  it("notes a deleted draft and tells the Clot not to write it again", async () => {
    recordDraft(store, "graphite", draft("a"));
    fates = [{ kind: "deleted" }];
    await tracker().check("graphite");
    expect(notes()[0]).toContain("deleted your email draft");
    expect(notes()[0]).toContain("Do not write it again");
  });

  it("keeps a draft still waiting, and one whose lookup failed, for the next turn", async () => {
    recordDraft(store, "graphite", draft("a"));
    recordDraft(store, "graphite", draft("b"));
    fates = [{ kind: "waiting" }, { kind: "gone" }];
    await tracker().check("graphite");
    expect(notes()).toHaveLength(1);
    expect(notes()[0]).toContain("no longer in Drafts");
    fail = true;
    await tracker().check("graphite");
    expect(looked[1].map((d) => d.messageId)).toEqual(["<a@gmail.com>"]);
    expect(notes()).toHaveLength(1);
  });

  it("stops following a draft nobody touched for a month", async () => {
    recordDraft(store, "graphite", draft("a"));
    fates = [{ kind: "waiting" }];
    await tracker(Date.UTC(2026, 10, 20)).check("graphite");
    await tracker(Date.UTC(2026, 10, 20)).check("graphite");
    expect(looked).toHaveLength(1);
    expect(notes()).toEqual([]);
  });
});
