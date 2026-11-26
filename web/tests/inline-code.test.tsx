import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { InlineCode } from "@/components/clots/inline-code";

const html = (text: string) => renderToStaticMarkup(<InlineCode text={text} />);

describe("InlineCode", () => {
  it("sets backticked parts in the mono face and leaves the rest as text", () => {
    const out = html("Add `FOO_KEY` to the `.env` file.");
    expect(out).toContain('<code class="rounded-sm bg-muted px-1 py-0.5 font-mono text-code">FOO_KEY</code>');
    expect(out).toContain("<code");
    expect(out.replace(/<[^>]+>/g, "")).toBe("Add FOO_KEY to the .env file.");
  });
  it("keeps an unmatched backtick, and does not match across lines", () => {
    expect(html("a ` b")).toBe("a ` b");
    expect(html("a `b\nc` d")).toBe("a `b\nc` d");
  });
  it("escapes markup in the text and in the code", () => {
    expect(html("<b>x</b> `<i>`")).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(html("`<i>`")).toContain("&lt;i&gt;");
  });
});
