import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";

function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? files(path.join(dir, entry.name)) : [path.join(dir, entry.name)]));
}

it("no file under src imports discord.js, and the package is not a dependency", () => {
  const root = path.join(import.meta.dirname, "..");
  for (const file of files(path.join(root, "src")).filter((f) => f.endsWith(".ts"))) {
    expect(fs.readFileSync(file, "utf8"), file).not.toMatch(/from\s+["']discord\.js["']|require\(["']discord\.js["']\)/);
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { dependencies: Record<string, string> };
  expect(pkg.dependencies).not.toHaveProperty("discord.js");
  expect(fs.existsSync(path.join(root, "src/chat"))).toBe(false);
});
