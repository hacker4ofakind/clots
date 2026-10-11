// Records real GitHub deliveries as test fixtures, and shows who GitHub names as the sender.
// Run: node --env-file=.env --import tsx scripts/capture-webhooks.ts
import { createHmac, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import http from "node:http";

const PORT = Number(process.env.CLOTS_INTAKE_PORT ?? "8787");
const DIR = "tests/fixtures/github";
const secret = process.env.GITHUB_WEBHOOK_SECRET;
if (!secret) throw new Error("GITHUB_WEBHOOK_SECRET is not set in .env");
fs.mkdirSync(DIR, { recursive: true });

http
  .createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const given = Buffer.from(String(req.headers["x-hub-signature-256"] ?? ""));
      const expected = Buffer.from(`sha256=${createHmac("sha256", secret).update(body).digest("hex")}`);
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
        console.log("REFUSED: bad signature (is the secret in .env the one on the webhook?)");
        res.writeHead(401).end("bad signature");
        return;
      }
      const event = String(req.headers["x-github-event"]);
      const payload = JSON.parse(body.toString("utf8"));
      const parts = [event, payload.action, event === "workflow_run" ? payload.workflow_run?.conclusion : undefined].filter(Boolean);
      const file = `${DIR}/${parts.join(".")}.json`;
      fs.writeFileSync(file, JSON.stringify({ event, delivery: String(req.headers["x-github-delivery"]), payload }, null, 2));
      console.log(`${parts.join(".").padEnd(40)} sender: ${payload.sender?.login ?? "?"}  ->  ${file}`);
      res.writeHead(200).end("recorded");
    });
  })
  .listen(PORT, "127.0.0.1", () => console.log(`Recording GitHub deliveries on http://127.0.0.1:${PORT} (Ctrl+C to stop)`));
