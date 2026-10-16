// Stage 2c calendar assumption checks: the secret iCal feed is current, and the Apps Script can be
// reached from here, finds events by their iCal UID, and refuses an event with guests.
// Run: node --env-file=.env --import tsx scripts/spike-2c-calendar.ts
import fs from "node:fs";
import readline from "node:readline/promises";
import { loadConfig } from "../src/config.js";

const config = loadConfig(JSON.parse(fs.readFileSync("clots.config.json", "utf8")), process.env);
const ask = readline.createInterface({ input: process.stdin, output: process.stdout });
const results: [string, boolean][] = [];
const check = (name: string, passed: boolean, detail = "") => {
  results.push([name, passed]);
  console.log(passed ? "PASS" : "FAIL", name, detail);
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The UID of the first event in the feed whose title is exactly this, or undefined. */
async function uidOf(url: string, title: string): Promise<string | undefined> {
  const ics = await (await fetch(url)).text();
  const block = ics.split("BEGIN:VEVENT").find((part) => part.replace(/\r\n[ \t]/g, "").includes(`\nSUMMARY:${title}\r`));
  return block?.match(/\nUID:([^\r\n]+)/)?.[1];
}

for (const account of config.sources.calendar) {
  console.log(`\n== ${account.account}`);
  const response = await fetch(account.icalUrl);
  const ics = await response.text();
  check("the feed answers", response.ok && ics.startsWith("BEGIN:VCALENDAR"), `(${(ics.match(/BEGIN:VEVENT/g) ?? []).length} events)`);

  await ask.question('Create an event titled "Clots feed check" tomorrow at 10:00 in this calendar, then press Enter. ');
  const started = Date.now();
  let seen: string | undefined;
  while (seen === undefined && Date.now() - started < 10 * 60_000) {
    seen = await uidOf(account.icalUrl, "Clots feed check");
    if (seen === undefined) await sleep(30_000);
  }
  check("a new event appears in the feed within ten minutes", seen !== undefined, `(after ${Math.round((Date.now() - started) / 1000)} s, UID ${seen})`);

  if (!account.script) {
    console.log("No script configured for this calendar: it is read-only.");
    continue;
  }
  const call = async (body: Record<string, unknown>) => {
    const answer = await fetch(account.script!.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ secret: account.script!.secret, ...body }), redirect: "follow" });
    const text = await answer.text();
    try {
      return JSON.parse(text);
    } catch {
      return { ok: false, reason: `not JSON: ${text.slice(0, 120)}` };
    }
  };
  const tomorrow = new Date(Date.now() + 86_400_000);
  tomorrow.setUTCHours(15, 0, 0, 0);
  const made = await call({ action: "create", title: "Clots script check", start: tomorrow.toISOString(), end: new Date(tomorrow.getTime() + 30 * 60_000).toISOString() });
  check("the script creates an event", made.ok === true, JSON.stringify(made));
  if (made.ok) {
    check("it finds the event by its iCal UID", (await call({ action: "check", uid: made.event.uid })).ok === true, made.event.uid);
    const moved = await call({ action: "update", uid: made.event.uid, start: new Date(tomorrow.getTime() + 3_600_000).toISOString(), end: new Date(tomorrow.getTime() + 5_400_000).toISOString() });
    check("it moves the event", moved.ok === true && moved.event.start === new Date(tomorrow.getTime() + 3_600_000).toISOString());
    check("it removes the event", (await call({ action: "remove", uid: made.event.uid })).ok === true);
  }
  check("a wrong secret is refused", (await call({ secret: "wrong", action: "check", uid: "x" })).reason === "wrong secret");
  if (seen) {
    check("it finds an event made in Google Calendar by the UID the feed shows", (await call({ action: "check", uid: seen })).ok === true);
  }

  await ask.question('Now add a guest to "Clots feed check" (any address; when Google asks, choose not to send an invitation), wait a moment, then press Enter. ');
  if (seen) {
    const refused = await call({ action: "update", uid: seen, title: "Clots feed check (changed)" });
    check("it refuses to change an event with guests", refused.ok === false && String(refused.reason).includes("guests"), JSON.stringify(refused));
  }
  console.log('You can delete "Clots feed check" now.');
}

ask.close();
console.log(results.every(([, passed]) => passed) ? "\nSPIKE OK" : "\nSPIKE FAILED");
