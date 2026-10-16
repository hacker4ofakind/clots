import type { EmailAccount } from "./config.js";
import type { Store } from "./store.js";

/** An email draft a Clot saved, kept until the daemon has seen what the user did with it. */
export interface PendingDraft {
  account: string;
  messageId: string;
  subject: string;
  to: string[];
  text: string;
  savedAt: number;
}

/** What became of a draft: still in Drafts, sent (when, and with what text), gone without a copy in Sent, or gone from Drafts where there is no Sent folder to look in. */
export type DraftFate = { kind: "waiting" } | { kind: "sent"; at: Date; text: string } | { kind: "deleted" } | { kind: "gone" };

/** Looks up what became of an account's drafts, one fate per draft, in order. */
export type DraftLookup = (account: EmailAccount, drafts: PendingDraft[]) => Promise<DraftFate[]>;

/** A draft nobody has sent or deleted after this long is no longer followed. */
const FOLLOW_MS = 30 * 24 * 60 * 60_000;

const keyOf = (clot: string) => `pending-drafts:${clot}`;

function pending(store: Store, clot: string): PendingDraft[] {
  const saved = store.getState(keyOf(clot));
  return saved === undefined ? [] : (JSON.parse(saved) as PendingDraft[]);
}

/** Remembers a draft the Clot saved, so that the Clot hears whether the user sent it. */
export function recordDraft(store: Store, clot: string, draft: PendingDraft): void {
  store.setState(keyOf(clot), JSON.stringify([...pending(store, clot), draft]));
}

/** Text compared as words: line breaks and spacing that mail programs change do not count. */
const words = (text: string) => text.replace(/\s+/g, " ").trim();

const quote = (text: string) => `> ${text.split("\n").join("\n> ")}`;

/** The note that tells the Clot what became of its draft. */
export function draftNote(draft: PendingDraft, fate: Exclude<DraftFate, { kind: "waiting" }>, when: (date: Date) => string, now: Date): string {
  const what = `your email draft "${draft.subject}" to ${draft.to.join(", ")} (${draft.account})`;
  switch (fate.kind) {
    case "sent": {
      const sent = `The user sent ${what} at ${when(fate.at)}. It is in their Sent folder, no longer in Drafts.`;
      if (words(fate.text) === words(draft.text)) return `${sent} It went as you wrote it. This is only to keep you up to date; nothing needs doing about it.`;
      return `${sent} The text that went out differs from your draft (the user may have changed it):\n${quote(fate.text)}\nThis is only to keep you up to date; nothing needs doing about it.`;
    }
    case "deleted":
      return `The user deleted ${what} without sending it; the daemon noticed at ${when(now)}. Do not write it again or save a new draft of it: it was most likely deleted on purpose. Only if it answered something urgent, you may ask the user once what made them drop it.`;
    case "gone":
      return `${what[0].toUpperCase()}${what.slice(1)} is no longer in Drafts as of ${when(now)}: the user sent it or deleted it (the account has no Sent folder to tell which). Do not save it again unless the user asks.`;
  }
}

/** A time as the user reads it: date, time and zone. */
export function userTime(timeZone: string): (date: Date) => string {
  const format = new Intl.DateTimeFormat("en-GB", { timeZone, day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZoneName: "short" });
  return (date) => format.format(date);
}

export interface DraftTrackerDeps {
  store: Store;
  accounts: EmailAccount[];
  lookup: DraftLookup;
  timeZone: string;
  now: () => number;
  log: (text: string, error?: unknown) => void;
}

/**
 * Follows the drafts the Clots saved. Before a Clot's turn, it looks at what the user did with them
 * and leaves the Clot a note for each one sent or deleted, so the turn starts knowing.
 */
export class DraftTracker {
  constructor(private d: DraftTrackerDeps) {}

  /** Never throws: a lookup that fails leaves its drafts to the next turn. */
  async check(clot: string): Promise<void> {
    const { store } = this.d;
    const drafts = pending(store, clot);
    if (drafts.length === 0) return;
    const now = this.d.now();
    const when = userTime(this.d.timeZone);
    const settled = new Set<PendingDraft>();
    for (const name of new Set(drafts.map((draft) => draft.account))) {
      const mine = drafts.filter((draft) => draft.account === name);
      const account = this.d.accounts.find((candidate) => candidate.account === name);
      if (!account) {
        for (const draft of mine) settled.add(draft);
        continue;
      }
      let fates: DraftFate[];
      try {
        fates = await this.d.lookup(account, mine);
      } catch (error) {
        this.d.log(`[${clot}] could not look at the drafts in ${name}; trying again before the next turn:`, error);
        continue;
      }
      mine.forEach((draft, i) => {
        const fate = fates[i];
        if (fate === undefined || fate.kind === "waiting") {
          if (now - draft.savedAt > FOLLOW_MS) settled.add(draft);
          return;
        }
        store.addNote(clot, draftNote(draft, fate, when, new Date(now)));
        settled.add(draft);
      });
    }
    if (settled.size === 0) return;
    // Read again: a draft saved while the lookup ran is kept.
    store.setState(keyOf(clot), JSON.stringify(pending(store, clot).filter((draft) => ![...settled].some((done) => done.messageId === draft.messageId))));
  }
}
