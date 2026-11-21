// Records real Composio deliveries as test fixtures: headers worth keeping and the raw body, one file
// per delivery in tests/fixtures/composio/<toolkit>/NN-<type>[.<trigger slug>].json, the toolkit being
// the first word of the trigger slug (lifecycle deliveries go to "lifecycle").
// Stop the daemon first: this takes its port. It does not verify signatures (the intake tests do that
// against these files); it answers 200 so Composio keeps delivering.
// Run: node --env-file=.env --import tsx scripts/capture-2e.ts
import fs from "node:fs";
import http from "node:http";

const PORT = Number(process.env.CLOTS_INTAKE_PORT ?? "8787");
const ROOT = "tests/fixtures/composio";
const KEEP = /signature|webhook-id|webhook-timestamp|content-type|user-agent/i;
const counts = new Map<string, number>();
const nextCount = (dir: string): number => {
  fs.mkdirSync(dir, { recursive: true });
  const n = (counts.get(dir) ?? fs.readdirSync(dir).length) + 1;
  counts.set(dir, n);
  return n;
};

http
  .createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: any;
      try {
        body = JSON.parse(raw);
      } catch {
        body = raw;
      }
      const slug = body?.metadata?.trigger_slug ?? body?.trigger_slug ?? "";
      const type = String(body?.type ?? "delivery").replace(/[^A-Za-z0-9_.-]/g, "_") + (slug ? `.${String(slug).replace(/[^A-Za-z0-9_.-]/g, "_")}` : "");
      const toolkit = slug ? String(slug).split("_")[0].toLowerCase().replace(/[^a-z0-9-]/g, "") : "lifecycle";
      const DIR = `${ROOT}/${toolkit}`;
      const count = nextCount(DIR);
      const headers = Object.fromEntries(Object.entries(req.headers).filter(([name]) => KEEP.test(name)));
      const file = `${DIR}/${String(count).padStart(2, "0")}-${type}.json`;
      fs.writeFileSync(file, JSON.stringify({ path: req.url, headers, raw, body }, null, 2));
      console.log(`${req.method} ${req.url}  ${type}  ->  ${file}`);
      res.writeHead(200).end("recorded");
    });
  })
  .listen(PORT, "127.0.0.1", () => console.log(`Recording Composio deliveries on http://127.0.0.1:${PORT} (Ctrl+C to stop)`));
