import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { IntegrationStatus } from "@clots/ui-api-schemas";
import { ConfigStore } from "../../src/config-store.js";
import { Configurer, type ConfigurerInput, type ConfigurerTools } from "../../src/integrations/configurer.js";
import { IntegrationJobs } from "../../src/integrations/jobs.js";
import { LiveEnv } from "../../src/live-env.js";
import { FakeComposioApi } from "../fake-composio.js";

export const COMPOSIO_KEY = "composio-test-key";

/** A configuration with the Clot `graphite`, on a temp folder, and an .env that holds what loading needs. */
export function makeConfigStore(o: { publicUrl?: boolean; extra?: Record<string, unknown> } = {}): { config: ConfigStore; dir: string; envFile: string; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clots-integrations-"));
  const file = path.join(dir, "clots.config.json");
  const envFile = path.join(dir, ".env");
  fs.writeFileSync(envFile, `CLAUDE_CODE_OAUTH_TOKEN=c\nCLOT_GITHUB_TOKEN=ghp_secret123\nGITHUB_WEBHOOK_SECRET=w\nCOMPOSIO_API_KEY=${COMPOSIO_KEY}\n`);
  fs.writeFileSync(
    file,
    JSON.stringify({ timeZone: "UTC", image: "i", ui: { owner: "me" }, home: true, ...(o.publicUrl === false ? {} : { publicUrl: "https://box.example.ts.net" }), clots: [{ name: "graphite", repoUrl: "https://github.com/o/r.git" }], ...o.extra }),
  );
  return { config: new ConfigStore({ file, envFile, env: new LiveEnv(envFile, {}) }), dir, envFile, file };
}

export type Script = (tools: ConfigurerTools, input: ConfigurerInput) => Promise<void>;

/** Everything a jobs test needs: the jobs over a real config store and the fake Composio, a fake clock, the recorded configurer input. */
export function makeJobs(o: { publicUrl?: boolean } = {}) {
  const made = makeConfigStore(o);
  const api = new FakeComposioApi();
  const clock = { now: Date.UTC(2026, 10, 24, 9, 0, 0) };
  const events: IntegrationStatus[] = [];
  const inputs: ConfigurerInput[] = [];
  const reconnected: string[] = [];
  const forgotten: string[] = [];
  let n = 0;
  const state: { script: Script } = { script: async () => undefined };
  const configurer = new Configurer({
    model: async (input) => {
      inputs.push(input);
      await state.script(input.tools, input);
    },
    toolkitInfo: (slug) => api.toolkitInfo(slug),
    toolkitText: async (a) => `info of ${a.toolkit}`,
    triggerTypes: (toolkit) => api.toolkitTriggers(toolkit),
    skill: () => "THE SKILL",
  });
  const jobs = new IntegrationJobs({
    config: made.config,
    api,
    configurer,
    emit: (_type, data) => void events.push(data),
    now: () => clock.now,
    newId: () => `job-${++n}`,
    reconnected: async (id) => void reconnected.push(id),
    // What the component does: the tool's old connection is deleted at Composio.
    forget: async (id) => {
      forgotten.push(id);
      for (const [cid, connection] of [...api.connections]) if (connection.user === id) api.connections.delete(cid);
      return undefined;
    },
    log: () => undefined,
  });
  return { ...made, api, clock, events, inputs, reconnected, forgotten, jobs, state };
}

/** Lets what a call started in the background settle. */
export async function settle(times = 30): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setImmediate(resolve));
}

/** The oauth toolkit the tests use, and the entry a model would propose for it. */
export const slackScript: Script = async (tools) => {
  await tools.save_integration({ entry: { toolkit: "slack", triggers: [{ slug: "SLACK_CHANNEL_MESSAGE_RECEIVED", config: { channel_id: "C1" } }] } });
};

/** The .env key the brief names. */
export const keyNameIn = (input: ConfigurerInput): string => /named ([A-Z0-9_]+);/.exec(input.prompt)![1]!;

/** A key toolkit (PostHog) whose key name is whatever the brief gave. */
export const posthogScript: Script = async (tools, input) => {
  await tools.save_integration({
    entry: { toolkit: "posthog", apiKey: keyNameIn(input), connect: { subdomain: "us" }, triggers: [{ slug: "POSTHOG_EVENT_CAPTURED", config: { project_id: 1, event_names: ["signup"] } }] },
    instructions: "1. Open PostHog.\n2. Settings, Personal API keys, Create.\n3. Give it the hog_function:write scope.\n4. Copy the key.",
  });
};

export const OPTIONS = { audience: "private" as const, selfIsUser: false, events: true };
