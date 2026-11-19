// Stage 2d probes (Task 1). Run: node --env-file=.env --import tsx scripts/spike-2d.ts <probe>
// Probes run in a Clot's container with its own claude.ai login (no CLAUDE_CODE_OAUTH_TOKEN passed).
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { makeSpawn } from "../src/agent/container.js";
import { InputQueue } from "../src/agent/input-queue.js";

const CONTAINER = process.env.PROBE_CONTAINER ?? "clot-encryptify";
const spawnIn = makeSpawn({ container: CONTAINER, cwd: "/workspace", env: process.env.PROBE_TOKEN ? { CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN! } : {} });

function msg(text: string): SDKUserMessage {
  return { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null };
}
function dock(...args: string[]): string {
  try { return execFileSync("docker", args, { encoding: "utf8" }).trim(); } catch (e) { return `ERR ${(e as Error).message}`; }
}
const base = {
  model: "claude-opus-5-5",
  effort: "low" as const,
  cwd: "/workspace",
  permissionMode: "bypassPermissions" as const,
  allowDangerouslySkipPermissions: true,
  spawnClaudeCodeProcess: spawnIn,
};

async function usage() {
  const q = new InputQueue<SDKUserMessage>([]);
  const s = query({ prompt: q, options: base });
  const t = Date.now();
  const u = await s.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true });
  console.log("usage call ms", Date.now() - t);
  console.log(JSON.stringify(u, null, 1));
  q.close();
}

async function status() {
  const q = new InputQueue<SDKUserMessage>([]);
  const s = query({ prompt: q, options: base });
  let st = await s.mcpServerStatus();
  for (let i = 0; i < 30 && st.some((x) => x.status === "pending"); i++) {
    await new Promise((r) => setTimeout(r, 1000));
    st = await s.mcpServerStatus();
  }
  for (const x of st) {
    console.log(JSON.stringify({ name: x.name, status: x.status, scope: x.scope, source: x.source, config: x.config && { type: (x.config as any).type, url: (x.config as any).url }, tools: x.tools?.map((t) => ({ n: t.name, a: t.annotations })) }));
  }
  q.close();
}

async function turns() {
  // Two-turn resume: total_cost_usd, rate_limit_event, structured output, transcript deletion.
  const id = randomUUID();
  const events: unknown[] = [];
  async function run(opts: Record<string, unknown>, prompt: string) {
    const q = new InputQueue<SDKUserMessage>([msg(prompt)]);
    const s = query({ prompt: q, options: { ...base, ...opts } as any });
    let total: number | undefined;
    let structured: unknown;
    for await (const m of s) {
      if (m.type === "rate_limit_event") events.push((m as any).rate_limit_info);
      if (m.type === "result") {
        total = (m as any).total_cost_usd;
        structured = (m as any).structured_output;
        q.close();
      }
    }
    return { total, structured };
  }
  const a = await run({ sessionId: id }, "Say hello in one word.");
  console.log("turn1 total", a.total);
  const b = await run({ resume: id }, "Say goodbye in one word.");
  console.log("turn2 total (resumed)", b.total);
  console.log("rate limit events", JSON.stringify(events));
  const u = await (async () => {
    const q = new InputQueue<SDKUserMessage>([]);
    const s = query({ prompt: q, options: base });
    const r = await s.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true });
    q.close();
    return r.rate_limits;
  })();
  console.log("usage call now", JSON.stringify(u));
  // Structured output in a session that reads a file.
  const schema = { type: "object", properties: { hostname: { type: "string" }, n: { type: "number" } }, required: ["hostname", "n"], additionalProperties: false };
  const id2 = randomUUID();
  const c = await run({ sessionId: id2, outputFormat: { type: "json_schema", schema }, allowedTools: ["Read"] }, "Read /etc/hostname with the Read tool, then answer with its content as hostname and 7 as n.");
  console.log("structured", JSON.stringify(c.structured), "total", c.total);
  // Transcript deletion leaves the main session resumable.
  console.log("before", dock("exec", CONTAINER, "sh", "-c", `ls /home/clot/.claude/projects/*/${id2}.jsonl`));
  dock("exec", CONTAINER, "sh", "-c", `rm -f /home/clot/.claude/projects/*/${id2}.jsonl`);
  console.log("after", dock("exec", CONTAINER, "sh", "-c", `ls /home/clot/.claude/projects/*/${id2}.jsonl`));
  const d = await run({ resume: id }, "Say thanks in one word.");
  console.log("turn3 total (resumed after deleting the other)", d.total);
}

async function oneoff() {
  // The real runner against the real container: a sweep with no connector, and a re-grounding session.
  const { SdkRunner } = await import("../src/agent/runner.js");
  const { REGROUND_SCHEMA, REGROUND_SYSTEM_PROMPT, regroundPrompt } = await import("../src/reground.js");
  const { SWEEP_SCHEMA, SWEEP_SYSTEM_PROMPT } = await import("../src/sweep.js");
  const { sessionEnv } = await import("../src/agent/container.js");
  const runner = new SdkRunner({ clot: "encryptify", env: sessionEnv({ claudeToken: process.env.CLAUDE_CODE_OAUTH_TOKEN!, githubToken: process.env.CLOT_GITHUB_TOKEN!, ownLogin: false }), cwd: "/workspace/repo" });
  const rate: unknown[] = [];
  (runner as any).o.onRateLimit = (r: unknown) => rate.push(r);
  const sweep = await runner.runOneOff({ kind: "sweep", prompt: "x", systemPrompt: SWEEP_SYSTEM_PROMPT, model: "claude-opus-5-5", effort: "low", cwd: "/workspace", schema: SWEEP_SCHEMA, timeoutMs: 120_000 });
  console.log("sweep:", JSON.stringify(sweep));
  const t = Date.now();
  const re = await runner.runOneOff({ kind: "reground", prompt: regroundPrompt("What happened: we looked at pull request 1 of hacker4ofakind/encryptify, which was open. Workers: none.", []), systemPrompt: REGROUND_SYSTEM_PROMPT, model: "claude-opus-5-5", effort: "low", schema: REGROUND_SCHEMA, timeoutMs: 300_000 });
  console.log("reground:", JSON.stringify(re), Date.now() - t, "ms");
  console.log("rate events seen:", rate.length, JSON.stringify(rate[0]));
  console.log("leftover transcripts:", dock("exec", CONTAINER, "sh", "-c", "ls /home/clot/.claude/projects/*/*.jsonl | wc -l"));
}

async function sweep() {
  // Two real sweeps of clot-home's connectors through the real Sweeper, with a throwaway store.
  const { SdkRunner } = await import("../src/agent/runner.js");
  const { Sweeper, skipList } = await import("../src/sweep.js");
  const { Store } = await import("../src/store.js");
  const store = new Store(process.env.PROBE_DB ?? ":memory:");
  store.deleteState("sweep-last-start");
  const runner = new SdkRunner({ clot: "home", env: {}, cwd: "/workspace" });
  const delivered: string[] = [];
  let clock = Date.now();
  const sweeper = new Sweeper({
    store, now: () => clock, enabled: true, everyMinutes: 15,
    run: async (req) => { const t = Date.now(); const r = await runner.runOneOff(req); console.log("run", JSON.stringify(r).slice(0, 1500), Date.now() - t, "ms"); return r; },
    clots: () => [{ name: "home", about: "anything that belongs to no project" }, { name: "encryptify", about: "the Encryptify app" }],
    skip: () => skipList({ sources: { email: [], composio: [] }, mcpServers: {} }),
    held: () => false, deliver: async (e) => void delivered.push(JSON.stringify(e)), tell: async (t) => console.log("tell", t),
    book: async (a) => console.log("book", JSON.stringify(a)), onLimit: () => undefined, log: console.log,
  });
  await sweeper.tick();
  console.log("record 1:", store.getState("sweep-record")?.slice(0, 600));
  clock += 16 * 60_000;
  if (process.argv[3] === "twice") { await sweeper.tick(); console.log("record 2:", store.getState("sweep-record")?.slice(0, 600)); console.log("delivered", delivered); }
  console.log("transcripts left:", dock("exec", CONTAINER, "sh", "-c", "ls /home/clot/.claude/projects/*/*.jsonl 2>/dev/null | wc -l"));
}

async function readdoc() {
  // Does the hook accept a real connector tool call, and refuse a delete?
  const { SdkRunner } = await import("../src/agent/runner.js");
  const { SWEEP_SCHEMA, SWEEP_SYSTEM_PROMPT } = await import("../src/sweep.js");
  const runner = new SdkRunner({ clot: "home", env: {}, cwd: "/workspace" });
  const r = await runner.runOneOff({ kind: "sweep", prompt: (c) => "Connectors: " + c.join(", ") + ". Call the read tool of claude.ai Claude Docs for the doc with id 0938837c-baaa-4d80-abce-4ccc6c0ca561, then report it as one finding (connector claude.ai Claude Docs, item that id, version its revision). Also try the delete tool on it once and say in the record whether it was refused.", systemPrompt: SWEEP_SYSTEM_PROMPT, model: "claude-opus-5-5", effort: "low", cwd: "/workspace", schema: SWEEP_SCHEMA, timeoutMs: 300_000 });
  console.log(JSON.stringify(r).slice(0, 2500));
}

const probe = process.argv[2];
const probes: Record<string, () => Promise<void>> = { usage, status, turns, oneoff, sweep, readdoc };
if (!probes[probe]) throw new Error(`probe: ${Object.keys(probes).join(" | ")}`);
await probes[probe]();
process.exit(0);
