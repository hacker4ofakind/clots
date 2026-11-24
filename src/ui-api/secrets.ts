import { randomBytes } from "node:crypto";
import { readEnvFile, setEnvKey } from "../env-file.js";

/** The value of a key in the `.env` file, made and saved there first when there is none. */
export function ensureEnvKey(file: string, key: string, make: () => string = () => randomBytes(32).toString("hex")): string {
  const existing = readEnvFile(file)[key];
  if (existing !== undefined && existing !== "") return existing;
  const value = make();
  setEnvKey(file, key, value);
  return value;
}
