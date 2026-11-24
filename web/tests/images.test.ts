import { describe, expect, it } from "vitest";
import { canKeep, fitWithin, MAX_SIDE } from "@/lib/images";

describe("fitWithin", () => {
  it("leaves a picture that already fits as it is", () => {
    expect(fitWithin(1200, 800)).toEqual({ width: 1200, height: 800, scaled: false });
    expect(fitWithin(MAX_SIDE, 100)).toMatchObject({ scaled: false });
  });

  it("shrinks a tall phone screenshot so its longest side is 2048 and keeps its shape", () => {
    const size = fitWithin(1170, 2532);
    expect(size.scaled).toBe(true);
    expect(size.height).toBe(2048);
    expect(size.width).toBe(Math.round((1170 * 2048) / 2532));
  });

  it("shrinks a wide picture by its width", () => {
    expect(fitWithin(4096, 1024)).toEqual({ width: 2048, height: 512, scaled: true });
  });

  it("never makes a side zero", () => {
    expect(fitWithin(100000, 1).height).toBe(1);
  });
});

describe("canKeep", () => {
  const png = { type: "image/png", size: 200_000 };
  it("keeps a small stored picture", () => expect(canKeep(png, 800, 600)).toBe(true));
  it("encodes again a picture that is too large in pixels", () => expect(canKeep(png, 3000, 600)).toBe(false));
  it("encodes again a picture that is over 3 MB", () => expect(canKeep({ ...png, size: 3 * 1024 * 1024 + 1 }, 800, 600)).toBe(false));
  it("encodes again a format the daemon does not store", () => expect(canKeep({ type: "image/heic", size: 100 }, 800, 600)).toBe(false));
});
