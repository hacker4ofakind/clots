// Records real deliveries from a source as test fixtures, and checks that they reach this machine
// through the tunnel. Stop the daemon first: this takes its port.
// Run: node --env-file=.env --import tsx scripts/capture-2c.ts <stripe|linear|notion|...>
import fs from "node:fs";
import http from "node:http";

const source = process.argv[2];
if (!source || !/^[a-z0-9-]+$/.test(source)) throw new Error("Name the source: scripts/capture-2c.ts stripe");
const PORT = Number(process.env.CLOTS_INTAKE_PORT ?? "8787");
const DIR = `tests/fixtures/${source}`;
fs.mkdirSync(DIR, { recursive: true });
// Headers worth keeping: the ones that sign a delivery or name it. Nothing else is written down.
const KEEP = /signature|delivery|event|timestamp|hook|request-id|content-type/i;
let count = fs.readdirSync(DIR).length;

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
      // Notion's first request carries the verification token, which finishes setting up the subscription.
      if (typeof body?.verification_token === "string") {
        console.log(`\nNotion verification token (paste it into Notion, and into .env):\n${body.verification_token}\n`);
        res.writeHead(200).end("ok");
        return;
      }
      const type = String(body?.type ?? body?.event ?? "delivery").replace(/[^A-Za-z0-9_.-]/g, "_") + (body?.action ? `.${body.action}` : "");
      count += 1;
      const headers = Object.fromEntries(Object.entries(req.headers).filter(([name]) => KEEP.test(name)));
      const file = `${DIR}/${String(count).padStart(2, "0")}-${type}.json`;
      fs.writeFileSync(file, JSON.stringify({ path: req.url, headers, raw, body }, null, 2));
      console.log(`${req.method} ${req.url}  ${type}  ->  ${file}`);
      res.writeHead(200).end("recorded");
    });
  })
  .listen(PORT, "127.0.0.1", () => console.log(`Recording ${source} deliveries on http://127.0.0.1:${PORT} (Ctrl+C to stop)`));
