import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const root = path.join(import.meta.dirname, "..");

describe("deploy and the example configuration", () => {
  it("the example configuration loads with the schema, and has ui.owner and askTimeoutMinutes but no discord or sendReview", () => {
    const json = JSON.parse(fs.readFileSync(path.join(root, "clots.config.example.json"), "utf8"));
    expect(json).not.toHaveProperty("discord");
    expect(json).not.toHaveProperty("sendReview");
    expect(json).not.toHaveProperty("choiceTimeoutMinutes");
    const env = new Proxy({}, { get: (_t, key) => (typeof key === "string" ? "value" : undefined) }) as Record<string, string>;
    const config = loadConfig(json, env);
    expect(config.ui.owner).toBe("you@example.com");
    expect(config.askTimeoutMinutes).toBe(10);
  });

  for (const script of ["deploy/update.sh", "deploy/setup-pi.sh", "deploy/backup.sh"]) {
    it(`${script} is valid bash`, () => {
      let bash: string | undefined;
      for (const candidate of ["bash", "C:/Program Files/Git/bin/bash.exe"]) {
        try {
          execFileSync(candidate, ["--version"], { stdio: "ignore" });
          bash = candidate;
          break;
        } catch {
          // Try the next.
        }
      }
      if (bash === undefined) return;
      expect(() => execFileSync(bash!, ["-n", path.join(root, script)], { stdio: "pipe" })).not.toThrow();
    });
  }

  it("the web service reads its own small environment and starts after the daemon, and the sudoers rule covers restarting it", () => {
    const unit = fs.readFileSync(path.join(root, "deploy/clots-web.service"), "utf8");
    expect(unit).toContain("After=clots.service");
    expect(unit).toContain("EnvironmentFile=/home/clots/clots/data/web.env");
    expect(unit).not.toContain("/.env");
    expect(fs.readFileSync(path.join(root, "deploy/clots-sudoers"), "utf8")).toContain("/usr/bin/systemctl restart clots-web");
  });

  it("the update script builds the web app, writes web.env from the secret only, and publishes it on 8443", () => {
    const script = fs.readFileSync(path.join(root, "deploy/update.sh"), "utf8");
    expect(script).toContain("npm run web:build");
    expect(script).toContain("CLOTS_UI_SECRET=%s");
    expect(script).toContain("tailscale serve --bg --https=8443 http://127.0.0.1:3000");
    expect(script).not.toContain("cat .env");
  });

  it("the backup covers the uploaded icons", () => {
    expect(fs.readFileSync(path.join(root, "deploy/backup.sh"), "utf8")).toContain("data/icons");
  });
});
