/** The part of `Storage` a draft needs, so a test can pass a plain object. */
export type DraftStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const keyOf = (clot: string): string => `draft:${clot}`;

const browserStore = (): DraftStore | undefined => {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    // Storage is blocked (some private modes): drafts live only while the page does.
    return undefined;
  }
};

/** What was typed and not sent in a Clot's chat, kept per Clot. Empty when there is none or storage is blocked. */
export function readDraft(clot: string, store: DraftStore | undefined = browserStore()): string {
  try {
    return store?.getItem(keyOf(clot)) ?? "";
  } catch {
    return "";
  }
}

/** Keeps the text as the Clot's draft; an empty text removes it. */
export function writeDraft(clot: string, text: string, store: DraftStore | undefined = browserStore()): void {
  try {
    if (text === "") store?.removeItem(keyOf(clot));
    else store?.setItem(keyOf(clot), text);
  } catch {
    // Full or blocked: the draft is simply not kept.
  }
}
