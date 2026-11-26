import { describe, expect, it } from "vitest";
import { plainPreview } from "@/lib/clots";

describe("plainPreview", () => {
  it("turns a link into its text, also when the daemon cut it off in the middle", () => {
    expect(plainPreview("Fixed [#71](https://github.com/hacker4ofakind/encryptify/pull/71) and merged")).toBe("Fixed #71 and merged");
    expect(plainPreview("The PR [#71](https://github.com/hacker4ofakind…")).toBe("The PR #71");
    expect(plainPreview("See [the docs](")).toBe("See the docs");
    expect(plainPreview("Look: ![chart](https://x.test/c.png) here")).toBe("Look: chart here");
  });

  it("drops emphasis, code marks, headings, quotes and bullets, and keeps what they wrapped", () => {
    expect(plainPreview("**Done.** The _tests_ pass, `npm test` is green, ~~old~~ new.")).toBe("Done. The tests pass, npm test is green, old new.");
    expect(plainPreview("## Summary\n- first point\n- second point")).toBe("Summary first point second point");
    expect(plainPreview("> quoted\n1. one\n2) two")).toBe("quoted one two");
    expect(plainPreview("```ts\nconst x = 1;\n```")).toBe("const x = 1;");
  });

  it("leaves ordinary words alone, snake_case and star signs in maths included", () => {
    expect(plainPreview("Set max_workers and rate_limit to 3 * 4 = 12")).toBe("Set max_workers and rate_limit to 3 * 4 = 12");
    expect(plainPreview("Nothing to change here.")).toBe("Nothing to change here.");
    expect(plainPreview("")).toBe("");
  });
});
