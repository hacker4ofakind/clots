import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LockIcon } from "@phosphor-icons/react/ssr";
import { StatusPage } from "@/components/clots/status-page";
import { accessDeniedHtml, notSetUpHtml, statusTokens } from "@/lib/status-document";
import { renderStatic } from "@/lib/static-html";

const page = (framed: boolean) => (
  <StatusPage framed={framed} icon={LockIcon} title="Title & more" reference="abc123" actions={<a href="/x?a=1&b=2">Go</a>}>
    Some <code>text</code> here.
  </StatusPage>
);

describe("renderStatic", () => {
  it("writes the same HTML as React for the status page, framed or not, icon included", () => {
    expect(renderStatic(page(true))).toBe(renderToStaticMarkup(page(true)));
    expect(renderStatic(page(false))).toBe(renderToStaticMarkup(page(false)));
  });
});

describe("the pages the proxy answers with", () => {
  it("say what is wrong in plain words and offer a way on", () => {
    const denied = accessDeniedHtml();
    expect(denied).toContain("<h1");
    expect(denied).toContain("Clots is private");
    expect(denied).toContain('href="/"');
    const setup = notSetUpHtml();
    expect(setup).toContain("Clots is not set up");
    expect(setup).toContain("<code>ui.owner</code>");
    for (const html of [denied, setup]) {
      expect(html.startsWith("<!doctype html>")).toBe(true);
      expect(html).toContain('name="viewport"');
      expect(html).toContain("prefers-color-scheme:dark");
    }
  });

  it("use the colours of the app's tokens, light and dark", () => {
    const css = readFileSync(path.resolve(__dirname, "../app/globals.css"), "utf8");
    const block = (selector: string) => css.slice(css.indexOf(`\n${selector} {`)).split("\n}")[0];
    const [light, dark] = [block(":root"), block(".dark")];
    for (const [name, [lightValue, darkValue]] of Object.entries(statusTokens)) {
      expect(light, `--${name} (light)`).toContain(`--${name}: ${lightValue};`);
      // A token the dark theme does not change keeps its light value.
      expect(light + dark, `--${name} (dark)`).toContain(`--${name}: ${darkValue};`);
      if (darkValue !== lightValue) expect(dark, `--${name} (dark)`).toContain(`--${name}: ${darkValue};`);
    }
  });
});
