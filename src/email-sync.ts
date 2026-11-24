import type { EmailAccount } from "./config.js";

/** A mailbox's connection, held by the daemon while the account is configured. */
export interface MailboxRun {
  /** Ends the connection and stops it from being opened again. */
  stop(): void | Promise<void>;
}

export interface EmailSyncDeps {
  /** Starts the listener for one mailbox of an account. */
  start(account: EmailAccount, mailbox: string): MailboxRun;
  log?: (text: string) => void;
}

/**
 * Keeps one connection per watched mailbox in step with `sources.email`: a new account is connected, a removed one is
 * disconnected, and a changed one (its address, password, servers or folders) is reconnected. An account that did not change
 * is left alone, so its connection and its place in the mailbox are not disturbed.
 */
export class EmailSync {
  private running = new Map<string, { json: string; runs: MailboxRun[] }>();

  constructor(private d: EmailSyncDeps) {}

  /** The accounts that are connected, by name. */
  connected(): string[] {
    return [...this.running.keys()];
  }

  /** Brings the connections to `accounts`. Returns what it did. */
  async apply(accounts: EmailAccount[]): Promise<{ started: string[]; stopped: string[] }> {
    const started: string[] = [];
    const stopped: string[] = [];
    const wanted = new Map(accounts.map((a) => [a.account, a]));
    for (const [name, entry] of [...this.running]) {
      const next = wanted.get(name);
      if (next !== undefined && JSON.stringify(next) === entry.json) continue;
      this.running.delete(name);
      for (const run of entry.runs) await Promise.resolve(run.stop()).catch(() => undefined);
      stopped.push(name);
    }
    for (const account of accounts) {
      if (this.running.has(account.account)) continue;
      const runs = account.mailboxes.map((mailbox) => this.d.start(account, mailbox));
      this.running.set(account.account, { json: JSON.stringify(account), runs });
      started.push(account.account);
    }
    if (started.length + stopped.length > 0) this.d.log?.(`[email] connections: started ${started.join(", ") || "none"}; stopped ${stopped.join(", ") || "none"}`);
    return { started, stopped };
  }
}
