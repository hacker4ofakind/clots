import fs from "node:fs";

/**
 * The KEY=value lines of an .env file. Read again when the rulebook changes, so a webhook recipe
 * added from chat works once its secret is saved, without a restart. A missing file is empty.
 */
export function readEnvFile(file: string): Record<string, string> {
  if (!fs.existsSync(file)) return {};
  const out: Record<string, string> = {};
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match || line.trim().startsWith("#")) continue;
    out[match[1]] = match[2].replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
  }
  return out;
}

const KEY_LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;

function writeAtomically(file: string, text: string): void {
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, text, { mode: 0o600 });
  fs.renameSync(temp, file);
}

/**
 * Sets one key. Comments and order stay: an existing line is replaced in place, a new key is appended.
 * The file is replaced atomically (a temp file, then a rename). A value with a line break is refused.
 */
export function setEnvKey(file: string, key: string, value: string): void {
  if (/[\r\n]/.test(value)) throw new Error("a value cannot contain a line break");
  const lines = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split(/\r?\n/) : [];
  const line = `${key}=${value}`;
  const at = lines.findIndex((l) => !l.trim().startsWith("#") && KEY_LINE.exec(l)?.[1] === key);
  if (at >= 0) lines[at] = line;
  else {
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    lines.push(line, "");
  }
  writeAtomically(file, lines.join("\n"));
}

/** Removes one key's line, leaving the rest as it was. Returns whether it was there. */
export function removeEnvKey(file: string, key: string): boolean {
  if (!fs.existsSync(file)) return false;
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  const kept = lines.filter((l) => l.trim().startsWith("#") || KEY_LINE.exec(l)?.[1] !== key);
  if (kept.length === lines.length) return false;
  writeAtomically(file, kept.join("\n"));
  return true;
}
