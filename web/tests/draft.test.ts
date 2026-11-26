import { describe, expect, it } from "vitest";
import { readDraft, writeDraft, type DraftStore } from "@/lib/draft";

function memory(): DraftStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) };
}

describe("drafts", () => {
  it("keeps what was typed, per Clot", () => {
    const store = memory();
    writeDraft("Truecast", "half a thought", store);
    writeDraft("home", "another one", store);
    expect(readDraft("Truecast", store)).toBe("half a thought");
    expect(readDraft("home", store)).toBe("another one");
    expect(readDraft("Encryptify", store)).toBe("");
  });

  it("forgets the draft once the text is empty, as after sending", () => {
    const store = memory();
    writeDraft("home", "hello", store);
    writeDraft("home", "", store);
    expect(store.data.size).toBe(0);
  });

  it("copes with storage that refuses", () => {
    const blocked: DraftStore = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    expect(readDraft("home", blocked)).toBe("");
    expect(() => writeDraft("home", "x", blocked)).not.toThrow();
    expect(() => writeDraft("home", "x", undefined)).not.toThrow();
  });
});
