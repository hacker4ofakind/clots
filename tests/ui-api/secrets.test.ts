import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readEnvFile, removeEnvKey, setEnvKey } from "../../src/env-file.js";
import { ensureEnvKey } from "../../src/ui-api/secrets.js";

const temp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "clots-env-")), ".env");

describe(".env keys", () => {
  it("creates the secret on first start and keeps it afterwards", () => {
    const file = temp();
    const first = ensureEnvKey(file, "CLOTS_UI_SECRET");
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(ensureEnvKey(file, "CLOTS_UI_SECRET")).toBe(first);
    expect(readEnvFile(file).CLOTS_UI_SECRET).toBe(first);
  });

  it("keeps comments and order when a key is written, replacing a line in place and appending a new key", () => {
    const file = temp();
    fs.writeFileSync(file, "# secrets\nA=1\n# note\nB=2\n");
    setEnvKey(file, "A", "10");
    setEnvKey(file, "C", "3");
    expect(fs.readFileSync(file, "utf8")).toBe("# secrets\nA=10\n# note\nB=2\nC=3\n");
    expect(removeEnvKey(file, "B")).toBe(true);
    expect(fs.readFileSync(file, "utf8")).toBe("# secrets\nA=10\n# note\nC=3\n");
    expect(removeEnvKey(file, "ZZ")).toBe(false);
  });

  it("refuses a value with a line break", () => {
    expect(() => setEnvKey(temp(), "A", "x\ny")).toThrow(/line break/);
  });
});
