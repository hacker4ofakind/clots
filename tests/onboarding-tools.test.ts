import { beforeEach, describe, expect, it } from "vitest";
import { ClotCreator } from "../src/onboarding/create.js";
import { OPTIONS, makeJobs, posthogScript, settle, slackScript } from "./helpers/integrations.js";

const composioEntries = (h: ReturnType<typeof makeJobs>) => ((h.config.json().sources as { composio?: Record<string, unknown>[] } | undefined)?.composio ?? []) as Record<string, unknown>[];

let h: ReturnType<typeof makeJobs>;
let creator: ClotCreator;
let steps: { clot: string; step: string }[];
let startFails: string | undefined;

const waitDone = async () => {
  for (let i = 0; i < 100 && !steps.some((s) => s.step === "done" || s.step === "failed"); i++) await new Promise((r) => setTimeout(r, 5));
};

/** Connects Slack for a Clot that does not exist yet, to the point where its entry is held. */
async function heldSlack(clot: string): Promise<string> {
  h.state.script = slackScript;
  const jobId = await h.jobs.configure({ toolkit: "slack", ...OPTIONS, clot });
  await settle();
  [...h.api.connections.values()].at(-1)!.status = "active";
  await h.jobs.tick();
  expect(h.jobs.get(jobId)).toMatchObject({ state: "active", held: true });
  return jobId;
}

beforeEach(() => {
  h = makeJobs();
  steps = [];
  startFails = undefined;
  const fetchFn = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
  creator = new ClotCreator({
    config: h.config,
    token: () => "ghp_secret123",
    fetchFn,
    tools: h.jobs,
    start: async () => {
      if (startFails) throw new Error(startFails);
    },
    emit: (e) => void steps.push(e),
    onReady: async () => undefined,
  });
});

describe("creating a Clot with tools connected in its Tools step", () => {
  it("writes the held entries together with the Clot's own, so the configuration never holds one without the other", async () => {
    const jobId = await heldSlack("fresh");
    expect(composioEntries(h)).toHaveLength(0);
    expect(await creator.create({ name: "fresh", repo: "o/new", toolJobs: [jobId] })).toEqual({ ok: true });
    await waitDone();
    expect(h.config.current.clots.some((c) => c.name === "fresh")).toBe(true);
    expect(composioEntries(h)).toEqual([expect.objectContaining({ toolkit: "slack", account: "fresh", clot: "fresh", audience: "private" })]);
    expect(h.config.current.sources.composio).toHaveLength(1);
    // The jobs are done: the entry cannot be written a second time.
    expect(h.jobs.claim([jobId], "fresh")).toMatchObject({ ok: false });
  });

  it("refuses a job that is not held for this Clot, and writes nothing", async () => {
    const jobId = await heldSlack("fresh");
    const wrong = await creator.create({ name: "other", repo: "o/new", toolJobs: [jobId] });
    expect(wrong).toMatchObject({ ok: false, errors: { toolJobs: expect.stringContaining("not ready") } });
    const gone = await creator.create({ name: "other", repo: "o/new", toolJobs: ["job-404"] });
    expect(gone).toMatchObject({ ok: false, errors: { toolJobs: expect.stringContaining("dropped") } });
    expect(h.config.current.clots.map((c) => c.name)).toEqual(["graphite"]);
    expect(composioEntries(h)).toHaveLength(0);
    expect(creator.building.size).toBe(0);
  });

  it("takes the Clot's tools out with it when its build fails, and has them again on retry", async () => {
    const jobId = await heldSlack("fresh");
    startFails = "docker build failed";
    await creator.create({ name: "fresh", repo: "o/new", toolJobs: [jobId] });
    await waitDone();
    expect(steps.at(-1)!.step).toBe("failed");
    expect(h.config.current.clots.map((c) => c.name)).toEqual(["graphite"]);
    expect(composioEntries(h)).toHaveLength(0);

    startFails = undefined;
    steps.length = 0;
    expect(await creator.retry("fresh")).toBe(true);
    await waitDone();
    expect(steps.at(-1)!.step).toBe("done");
    expect(composioEntries(h)).toHaveLength(1);
    expect(composioEntries(h)[0]).toMatchObject({ account: "fresh", clot: "fresh" });
  });

  it("writes a key tool's entry too: its key was put in .env when the key was entered", async () => {
    h.state.script = posthogScript;
    const jobId = await h.jobs.configure({ toolkit: "posthog", ...OPTIONS, clot: "fresh" });
    await settle();
    await h.jobs.putKey(jobId, "phx_value");
    expect(composioEntries(h)).toHaveLength(0);
    expect(await creator.create({ name: "fresh", repo: "o/new", toolJobs: [jobId] })).toEqual({ ok: true });
    await waitDone();
    expect(h.config.current.sources.composio[0]).toMatchObject({ toolkit: "posthog", clot: "fresh", apiKey: "phx_value" });
  });

  it("is told plainly when connecting services is not set up", async () => {
    const bare = new ClotCreator({ config: h.config, token: () => "t", fetchFn: (async () => new Response("{}")) as unknown as typeof fetch, start: async () => undefined, emit: () => undefined, onReady: async () => undefined });
    expect(await bare.create({ name: "fresh", repo: "o/new", toolJobs: ["x"] })).toMatchObject({ ok: false, errors: { toolJobs: expect.any(String) } });
  });
});
