import { expect, it } from "vitest";
import { CLOT_NAME, labelOf, sameClot, slugOf } from "../src/clot-name.js";

it("keeps a name as typed and makes its slug lowercase", () => {
  expect(slugOf("Truecast")).toBe("truecast");
  expect(slugOf("graphite")).toBe("graphite");
  expect(sameClot("Truecast", "truecast")).toBe(true);
  expect(sameClot("Truecast", "Encryptify")).toBe(false);
});

it("takes letters, digits and hyphens, starting with a letter", () => {
  for (const good of ["Truecast", "encryptify", "My-Clot2", "A"]) expect(CLOT_NAME.test(good)).toBe(true);
  for (const bad of ["", "2fast", "-x", "two words", "naïve", "a".repeat(32)]) expect(CLOT_NAME.test(bad)).toBe(false);
});

it("calls the home Clot Home and any other by its name", () => {
  expect(labelOf("home")).toBe("Home");
  expect(labelOf("Truecast")).toBe("Truecast");
});
