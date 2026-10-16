// Stage 2c email assumption checks: IDLE on each watched mailbox (a Gmail label included), Gmail's
// thread IDs, the Drafts folder, SMTP sign-in, and Gmail keeping a +alias as the sender.
// Run: node --env-file=.env --import tsx scripts/spike-2c-email.ts [--send-alias you+tag@gmail.com]
import fs from "node:fs";
import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import { loadConfig } from "../src/config.js";

const config = loadConfig(JSON.parse(fs.readFileSync("clots.config.json", "utf8")), process.env);
const results: [string, boolean][] = [];
const check = (name: string, passed: boolean) => {
  results.push([name, passed]);
  console.log(passed ? "PASS" : "FAIL", name);
};

for (const account of config.sources.email) {
  console.log(`\n== ${account.account} (${account.address})`);
  const client = new ImapFlow({ host: account.imap.host, port: account.imap.port, secure: account.imap.port === 993, auth: { user: account.address, pass: account.password }, logger: false });
  await client.connect();
  check(`${account.account}: signs in to IMAP`, true);
  check(`${account.account}: the server offers IDLE`, client.capabilities.has("IDLE"));
  const gmail = client.capabilities.has("X-GM-EXT-1");
  const list = await client.list();
  const drafts = list.find((box) => box.specialUse === "\\Drafts");
  check(`${account.account}: a Drafts folder is marked (${drafts?.path ?? "none"})`, drafts !== undefined);

  for (const mailbox of account.mailboxes) {
    // Opened without a lock: imapflow starts IDLE by itself only while no lock is held.
    await client.mailboxOpen(mailbox, { readOnly: true });
    {
      const box = client.mailbox;
      check(`${account.account}/${mailbox}: opens read-only (UIDVALIDITY ${box ? box.uidValidity : "?"}, next UID ${box ? box.uidNext : "?"})`, box !== false && box !== undefined);
      if (box && box.exists > 0) {
        const last = await client.fetchOne("*", { uid: true, envelope: true, threadId: true });
        console.log(`   newest: "${last ? last.envelope?.subject : "?"}" thread ${last ? last.threadId : "?"}`);
        if (gmail && last) {
          check(`${account.account}/${mailbox}: Gmail gives a thread ID`, typeof last.threadId === "string" && last.threadId !== "");
          if (last.threadId) console.log(`   open this to check the link works: https://mail.google.com/mail/u/0/#all/${BigInt(last.threadId).toString(16)}`);
        }
      }
      // A server that greylists can take several minutes to accept a new sender's mail.
      console.log(`   Send an email that lands in ${mailbox} now. Waiting up to 10 minutes...`);
      const arrived = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), 600_000);
        client.once("exists", () => {
          clearTimeout(timer);
          resolve(true);
        });
      });
      check(`${account.account}/${mailbox}: IDLE reports new mail`, arrived);
    }
  }
  await client.logout();

  const smtp = nodemailer.createTransport({ host: account.smtp.host, port: account.smtp.port, secure: account.smtp.port === 465, auth: { user: account.address, pass: account.password } });
  check(`${account.account}: signs in to SMTP`, await smtp.verify().then(() => true, () => false));

  // An alias added under Gmail's "Send mail as"; Gmail rewrites any other sender to the account's address.
  const alias = process.argv[process.argv.indexOf("--send-alias") + 1];
  if (process.argv.includes("--send-alias") && gmail && alias?.toLowerCase().endsWith(`@${account.address.split("@")[1]}`)) {
    const info = await smtp.sendMail({ from: alias, to: account.address, subject: "Clots check: sent from an alias", text: `If this arrived from ${alias}, a standing reply can come from an alias.` });
    console.log(`   sent ${info.messageId} from ${alias} to ${account.address}. Look at its From line in Gmail.`);
  }
}

console.log(results.every(([, passed]) => passed) ? "\nSPIKE OK" : "\nSPIKE FAILED");
