import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadRootEnv } from "../root-env";

const file = (text: string): string => {
  const dir = mkdtempSync(path.join(tmpdir(), "root-env-"));
  const name = path.join(dir, ".env");
  writeFileSync(name, text);
  return name;
};

describe("loadRootEnv", () => {
  it("takes the web app's own keys and nothing else", () => {
    const env: Record<string, string | undefined> = {};
    loadRootEnv(file("CLOTS_UI_SECRET=abc\nCLOTS_UI_DEV_OWNER=me@example.com\nCLAUDE_CODE_OAUTH_TOKEN=secret\nCOMPOSIO_API_KEY=k\n"), env);
    expect(env).toEqual({ CLOTS_UI_SECRET: "abc", CLOTS_UI_DEV_OWNER: "me@example.com" });
  });

  it("never overwrites a value that is already set", () => {
    const env: Record<string, string | undefined> = { CLOTS_UI_SECRET: "from-the-service" };
    loadRootEnv(file("CLOTS_UI_SECRET=from-the-file\n"), env);
    expect(env.CLOTS_UI_SECRET).toBe("from-the-service");
  });

  it("does nothing when the file is missing", () => {
    const env: Record<string, string | undefined> = {};
    loadRootEnv(path.join(tmpdir(), "no-such-dir", ".env"), env);
    expect(env).toEqual({});
  });
});
