import { expect, it } from "vitest";
import { CLOT_NAME, labelOf, sameClot, slugOf } from "../src/clot-name.js";

it("keeps a name as typed and makes its slug lowercase", () => {
  expect(slugOf("Truecast")).toBe("truecast");
  expect(slugOf("graphite")).toBe("graphite");
  expect(sameClot("Truecast", "truecast")).toBe(true);
  expect(sameClot("Truecast", "Encryptify")).toBe(false);
});

it("makes a space a hyphen in the slug, so names that differ only by that are one Clot", () => {
  expect(slugOf("My Shop")).toBe("my-shop");
  expect(sameClot("My Shop", "my-shop")).toBe(true);
});

it("takes letters, digits, hyphens and single spaces, starting with a letter or digit", () => {
  for (const good of ["Truecast", "encryptify", "My-Clot2", "A", "2fast", "My Shop", "a b c"]) expect(CLOT_NAME.test(good)).toBe(true);
  for (const bad of ["", "-x", " x", "x ", "two  words", "naïve", "a".repeat(32)]) expect(CLOT_NAME.test(bad)).toBe(false);
});

it("calls the home Clot Home and any other by its name", () => {
  expect(labelOf("home")).toBe("Home");
  expect(labelOf("Truecast")).toBe("Truecast");
});
