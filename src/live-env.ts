import { readEnvFile } from "./env-file.js";

/**
 * The daemon's environment as it is now. The daemon starts with `node --env-file`, so a key written to
 * `.env` while it runs never reaches `process.env`; every secret is read through this map instead. The
 * file wins over what the process started with.
 */
export class LiveEnv {
  private values: Record<string, string> = {};

  constructor(
    private file: string,
    private base: Record<string, string | undefined> = process.env,
  ) {
    this.reload();
  }

  /** Reads the file again. */
  reload(): void {
    const merged: Record<string, string> = {};
    for (const [key, value] of Object.entries(this.base)) if (value !== undefined) merged[key] = value;
    this.values = { ...merged, ...readEnvFile(this.file) };
  }

  get(key: string): string | undefined {
    return this.values[key];
  }

  /** Every key and value: for `loadConfig`, which takes the environment as a record. */
  all(): Record<string, string> {
    return { ...this.values };
  }

  /** The names in the file itself, which are the ones the user manages. */
  fileKeys(): string[] {
    return Object.keys(readEnvFile(this.file));
  }
}
