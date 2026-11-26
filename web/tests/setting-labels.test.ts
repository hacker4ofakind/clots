import { describe, expect, it } from "vitest";
import { restartText, savedText, settingLabel } from "@/lib/setting-labels";

describe("setting labels", () => {
  it("names the General settings by the labels the page shows, the old Ask timeout key included", () => {
    expect(settingLabel("askTimeoutMinutes")).toBe("Ask timeout");
    expect(settingLabel("choiceTimeoutMinutes")).toBe("Ask timeout");
    expect(settingLabel("rolloverPercent")).toBe("Start a new session at");
  });

  it("never lets an unknown key through", () => {
    expect(settingLabel("somethingNew")).toBe("A setting");
  });

  it("says one thing for a plain save, and which settings wait for a restart otherwise", () => {
    expect(savedText([])).toBe("Saved");
    expect(savedText(["choiceTimeoutMinutes"])).toBe("Saved. Ask timeout takes effect after a restart.");
    expect(savedText(["publicUrl", "timeZone"])).toBe("Saved. Public URL, Time zone take effect after a restart.");
    expect(restartText(["intake", "intake"])).toBe("The intake port takes effect after a restart.");
  });
});
