import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { ABANDON_AFTER_MS, JobError, OAUTH_READY_AFTER_MS, TOOLKIT_CACHE_MS } from "../src/integrations/jobs.js";
import { keyNameIn, makeJobs, OPTIONS, posthogScript, settle, slackScript } from "./helpers/integrations.js";

const composioEntries = (h: ReturnType<typeof makeJobs>) => ((h.config.json().sources as { composio?: Record<string, unknown>[] } | undefined)?.composio ?? []) as Record<string, unknown>[];
const states = (h: ReturnType<typeof makeJobs>, jobId: string) => h.events.filter((e) => e.jobId === jobId).map((e) => e.state);

/** Starts a Slack connection for the shared scope and waits until its sign-in link is shown. */
async function slackToOAuth(h: ReturnType<typeof makeJobs>, extra: Record<string, unknown> = {}) {
  h.state.script = slackScript;
  const jobId = await h.jobs.configure({ toolkit: "slack", ...OPTIONS, ...extra } as never);
  await settle();
  return jobId;
}

describe("the toolkit list", () => {
  it("is read from Composio once a day, filtered by name or slug, at most 60", async () => {
    const h = makeJobs();
    h.api.toolkitList = Array.from({ length: 80 }, (_, i) => ({ slug: `app${i}`, name: `App ${i}`, auth: "oauth" as const }));
    h.api.toolkitList.push({ slug: "linear", name: "Linear", auth: "oauth" });
    expect(await h.jobs.toolkits()).toHaveLength(60);
    expect((await h.jobs.toolkits("LINE")).map((t) => t.slug)).toEqual(["linear"]);
    expect((await h.jobs.toolkits("app7")).map((t) => t.slug)).toContain("app7");
    expect(h.api.of("listToolkits")).toHaveLength(1);
    h.clock.now += TOOLKIT_CACHE_MS - 1;
    await h.jobs.toolkits();
    expect(h.api.of("listToolkits")).toHaveLength(1);
    h.clock.now += 2;
    await h.jobs.toolkits();
    expect(h.api.of("listToolkits")).toHaveLength(2);
  });

  it("shows a built-in toolkit with the way its entry connects, whatever Composio lists first", async () => {
    const h = makeJobs();
    h.api.toolkitList = [{ slug: "linear", name: "Linear", auth: "oauth" }];
    expect((await h.jobs.toolkits())[0]!.auth).toBe("key");
  });

  it("does not keep a failed read", async () => {
    const h = makeJobs();
    h.api.failNext.set("listToolkits", new Error("down"));
    await expect(h.jobs.toolkits()).rejects.toThrow("down");
    h.api.toolkitList = [{ slug: "slack", name: "Slack", auth: "oauth" }];
    expect(await h.jobs.toolkits()).toHaveLength(1);
  });
});

describe("a sign-in connection", () => {
  it("shows the link, writes nothing until Composio says the connection is active, then writes the entry the person's choices shaped", async () => {
    const h = makeJobs();
    const jobId = await slackToOAuth(h);
    expect(states(h, jobId)).toEqual(["working", "oauth"]);
    const view = h.jobs.get(jobId);
    expect(view).toMatchObject({ jobId, toolkit: "slack", name: "Slack", clot: null, state: "oauth", link: expect.stringContaining("https://connect.example/link/") });
    expect(view.oauthReadyAt).toBe(h.clock.now + OAUTH_READY_AFTER_MS);
    expect(composioEntries(h)).toHaveLength(0);
    // The link is made for the account the entry will have, so the entry adopts the connection later.
    expect(h.api.of("linkManaged")).toEqual(["linkManaged:slack:shared"]);

    await h.jobs.tick();
    expect(h.jobs.get(jobId).state).toBe("oauth");
    expect(composioEntries(h)).toHaveLength(0);

    [...h.api.connections.values()][0]!.status = "active";
    await h.jobs.tick();
    expect(h.jobs.get(jobId).state).toBe("active");
    expect(states(h, jobId)).toEqual(["working", "oauth", "active"]);
    expect(composioEntries(h)).toEqual([{ toolkit: "slack", account: "shared", audience: "private", shared: true, selfIsUser: false, triggers: [{ slug: "SLACK_CHANNEL_MESSAGE_RECEIVED", config: { channel_id: "C1" } }] }]);
  });

  it("makes no sign-in link for a connection that is already active when the entry is edited", async () => {
    const h = makeJobs();
    const first = await slackToOAuth(h);
    [...h.api.connections.values()][0]!.status = "active";
    await h.jobs.tick();
    expect(h.jobs.get(first).state).toBe("active");

    const jobId = await h.jobs.configure({ toolkit: "slack", ...OPTIONS, audience: "team", events: false, replaces: "slack:shared" });
    await settle();
    expect(h.jobs.get(jobId).state).toBe("active");
    expect(h.api.of("linkManaged")).toHaveLength(1);
    // The brief carried the entry being edited, so the configurer keeps what is still right.
    expect(h.inputs.at(-1)!.prompt).toContain("current_entry");
    // Replaced in place, under the same account, never added.
    const entries = composioEntries(h);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ account: "shared", audience: "team", triggers: [] });
  });

  it("removes a sign-in that was not finished in an hour, from Composio, and keeps the failure for the dialog", async () => {
    const h = makeJobs();
    const jobId = await slackToOAuth(h);
    const connection = [...h.api.connections.keys()][0]!;
    h.clock.now += ABANDON_AFTER_MS - 1;
    await h.jobs.tick();
    expect(h.jobs.get(jobId).state).toBe("oauth");
    h.clock.now += 1;
    await h.jobs.tick();
    expect(h.api.of("deleteConnection")).toEqual([`deleteConnection:${connection}`]);
    expect(h.api.connections.size).toBe(0);
    expect(h.jobs.get(jobId)).toMatchObject({ state: "failed", error: "The sign-in was not finished in an hour." });
    expect(composioEntries(h)).toHaveLength(0);
    // The job itself is dropped an hour after that.
    h.clock.now += ABANDON_AFTER_MS;
    await h.jobs.tick();
    expect(() => h.jobs.get(jobId)).toThrow(JobError);
  });

  it("does not remove the connection of a sign-in that finished just before the hour", async () => {
    const h = makeJobs();
    const jobId = await slackToOAuth(h);
    [...h.api.connections.values()][0]!.status = "active";
    h.clock.now += ABANDON_AFTER_MS - 1000;
    await h.jobs.tick();
    expect(h.jobs.get(jobId).state).toBe("active");
    expect(h.api.of("deleteConnection")).toHaveLength(0);
  });

  it("abandoning from the connect step removes the connection and the job, and writes nothing", async () => {
    const h = makeJobs();
    const jobId = await slackToOAuth(h);
    await h.jobs.abandon(jobId);
    expect(h.api.connections.size).toBe(0);
    expect(() => h.jobs.get(jobId)).toThrow(JobError);
    expect(composioEntries(h)).toHaveLength(0);
    await h.jobs.abandon(jobId);
  });

  it("finishing again after Back updates the same job: the sign-in is kept while it is valid, and the entry is written once", async () => {
    const h = makeJobs();
    const jobId = await slackToOAuth(h);
    const link = h.jobs.get(jobId).link;
    h.state.script = async (tools) => {
      await tools.save_integration({ entry: { toolkit: "slack", triggers: [] } });
    };
    const again = await h.jobs.configure({ toolkit: "slack", ...OPTIONS, audience: "team", jobId });
    expect(again).toBe(jobId);
    await settle();
    expect(h.jobs.get(jobId)).toMatchObject({ state: "oauth", link });
    expect(h.api.of("linkManaged")).toHaveLength(1);
    expect(h.api.of("deleteConnection")).toHaveLength(0);

    [...h.api.connections.values()][0]!.status = "active";
    await h.jobs.tick();
    expect(composioEntries(h)).toHaveLength(1);
    expect(composioEntries(h)[0]).toMatchObject({ audience: "team", triggers: [] });

    // Even after the entry is written, one more Finish replaces it.
    const third = await h.jobs.configure({ toolkit: "slack", ...OPTIONS, audience: "public", jobId });
    await settle();
    expect(third).toBe(jobId);
    expect(composioEntries(h)).toHaveLength(1);
    expect(composioEntries(h)[0]).toMatchObject({ audience: "public" });
  });

  it("makes a new sign-in when the one kept has gone", async () => {
    const h = makeJobs();
    const jobId = await slackToOAuth(h);
    h.api.connections.clear();
    await h.jobs.configure({ toolkit: "slack", ...OPTIONS, jobId });
    await settle();
    expect(h.api.of("linkManaged")).toHaveLength(2);
    expect(h.jobs.get(jobId).state).toBe("oauth");
  });

  it("is not fooled by a leftover connection of a removed tool of the same name: it is replaced by a fresh sign-in", async () => {
    const h = makeJobs();
    h.api.connections.set("old", { id: "old", status: "active", user: "slack:shared", toolkit: "slack" });
    const jobId = await slackToOAuth(h);
    expect(h.api.of("deleteConnection")).toEqual(["deleteConnection:old"]);
    expect(h.jobs.get(jobId).state).toBe("oauth");
  });

  it("names a second account of the same toolkit apart, and a Clot's account after the Clot", async () => {
    const h = makeJobs();
    await slackToOAuth(h);
    [...h.api.connections.values()][0]!.status = "active";
    await h.jobs.tick();
    await slackToOAuth(h, { clot: "graphite" });
    [...h.api.connections.values()][1]!.status = "active";
    await h.jobs.tick();
    await slackToOAuth(h);
    expect(h.api.of("linkManaged")).toEqual(["linkManaged:slack:shared", "linkManaged:slack:graphite", "linkManaged:slack:shared-2"]);
    expect(composioEntries(h).map((e) => `${e.account}/${e.clot ?? "shared"}`)).toEqual(["shared/shared", "graphite/graphite"]);
  });
});

describe("a toolkit that needs no connection", () => {
  it("writes its entry as soon as the configurer is done", async () => {
    const h = makeJobs();
    h.state.script = async (tools) => void (await tools.save_integration({ entry: { toolkit: "hackernews" } }));
    const jobId = await h.jobs.configure({ toolkit: "hackernews", ...OPTIONS });
    await settle();
    expect(states(h, jobId)).toEqual(["working", "active"]);
    expect(composioEntries(h)).toHaveLength(1);
  });
});

describe("a key connection", () => {
  it("asks for the key with the configurer's steps, writes the key to .env first, then the entry; the value never reaches the configurer", async () => {
    const h = makeJobs();
    h.state.script = posthogScript;
    const jobId = await h.jobs.configure({ toolkit: "posthog", ...OPTIONS, clot: "graphite" });
    await settle();
    const view = h.jobs.get(jobId);
    expect(view).toMatchObject({ state: "key", keyName: "POSTHOG_GRAPHITE_KEY", instructions: expect.stringContaining("hog_function:write") });
    expect(fs.readFileSync(h.envFile, "utf8")).not.toContain("POSTHOG_GRAPHITE_KEY");
    expect(composioEntries(h)).toHaveLength(0);

    const SECRET = "phx_SUPER_SECRET_VALUE_123";
    // At the moment the entry is saved, the key it names is already in .env: loadConfig needs it.
    const real = h.config.save.bind(h.config);
    let keyThere: boolean | undefined;
    vi.spyOn(h.config, "save").mockImplementation(async (patch) => {
      keyThere = fs.readFileSync(h.envFile, "utf8").includes(`POSTHOG_GRAPHITE_KEY=${SECRET}`);
      return real(patch);
    });
    await h.jobs.putKey(jobId, SECRET);
    expect(keyThere).toBe(true);
    expect(h.jobs.get(jobId).state).toBe("active");
    expect(composioEntries(h)[0]).toMatchObject({ toolkit: "posthog", account: "graphite", clot: "graphite", apiKey: "POSTHOG_GRAPHITE_KEY", connect: { subdomain: "us" } });
    expect(JSON.stringify(composioEntries(h))).not.toContain(SECRET);

    // Everything the session was given or answered is free of the value (it was not even known yet).
    expect(JSON.stringify(h.inputs.map((i) => [i.systemPrompt, i.prompt]))).not.toContain(SECRET);
    expect(JSON.stringify(h.events)).not.toContain(SECRET);
  });

  it("refuses a value it cannot write, and keeps waiting", async () => {
    const h = makeJobs();
    h.state.script = posthogScript;
    const jobId = await h.jobs.configure({ toolkit: "posthog", ...OPTIONS });
    await settle();
    await expect(h.jobs.putKey(jobId, "two\nlines")).rejects.toMatchObject({ status: 400 });
    expect(h.jobs.get(jobId).state).toBe("key");
    await expect(h.jobs.putKey("nope", "x")).rejects.toMatchObject({ status: 404 });
  });

  it("takes the key out of .env again when the entry is refused", async () => {
    const h = makeJobs({ publicUrl: false });
    h.state.script = posthogScript;
    const jobId = await h.jobs.configure({ toolkit: "posthog", ...OPTIONS });
    await settle();
    await h.jobs.putKey(jobId, "phx_value");
    expect(h.jobs.get(jobId)).toMatchObject({ state: "failed", error: expect.stringContaining("publicUrl") });
    expect(fs.readFileSync(h.envFile, "utf8")).not.toContain("POSTHOG_SHARED_KEY");
    expect(composioEntries(h)).toHaveLength(0);
  });

  it("does not ask again for the key of a tool being edited", async () => {
    const h = makeJobs();
    h.state.script = posthogScript;
    const first = await h.jobs.configure({ toolkit: "posthog", ...OPTIONS });
    await settle();
    await h.jobs.putKey(first, "phx_value");
    const edit = await h.jobs.configure({ toolkit: "posthog", ...OPTIONS, audience: "team", replaces: "posthog:shared" });
    await settle();
    expect(h.jobs.get(edit).state).toBe("active");
    expect(composioEntries(h)).toHaveLength(1);
    expect(composioEntries(h)[0]).toMatchObject({ audience: "team", apiKey: "POSTHOG_SHARED_KEY" });
  });

  it("removes the key an abandoned or expired job wrote, when nothing names it", async () => {
    const h = makeJobs();
    h.state.script = posthogScript;
    const jobId = await h.jobs.configure({ toolkit: "posthog", ...OPTIONS, clot: "newclot" });
    await settle();
    // The Clot does not exist yet: the key is written, the entry is held.
    await h.jobs.putKey(jobId, "phx_value");
    expect(h.jobs.get(jobId)).toMatchObject({ state: "active", held: true });
    expect(fs.readFileSync(h.envFile, "utf8")).toContain("POSTHOG_NEWCLOT_KEY=phx_value");
    h.clock.now += ABANDON_AFTER_MS;
    await h.jobs.tick();
    expect(fs.readFileSync(h.envFile, "utf8")).not.toContain("POSTHOG_NEWCLOT_KEY");
    expect(h.jobs.get(jobId).state).toBe("failed");
  });

  it("gives up a key nobody entered in an hour", async () => {
    const h = makeJobs();
    h.state.script = posthogScript;
    const jobId = await h.jobs.configure({ toolkit: "posthog", ...OPTIONS });
    await settle();
    h.clock.now += ABANDON_AFTER_MS;
    await h.jobs.tick();
    expect(h.jobs.get(jobId)).toMatchObject({ state: "failed" });
    await expect(h.jobs.putKey(jobId, "late")).rejects.toMatchObject({ status: 409 });
  });
});

describe("the configurer's proposal", () => {
  it("is refused when it is not a valid entry, and nothing is written", async () => {
    const h = makeJobs();
    const answers: string[] = [];
    h.state.script = async (tools) => {
      answers.push(await tools.save_integration({ entry: { toolkit: "slack", bogus: 1 } }));
      answers.push(await tools.save_integration({ entry: "not an object" }));
    };
    const jobId = await h.jobs.configure({ toolkit: "slack", ...OPTIONS });
    await settle();
    expect(answers[0]).toMatch(/^Refused: .*bogus/);
    expect(answers[1]).toMatch(/^Refused: an entry is an object/);
    expect(h.jobs.get(jobId)).toMatchObject({ state: "failed", error: expect.stringContaining("could not produce a valid entry") });
    expect(composioEntries(h)).toHaveLength(0);
    expect(h.api.of("linkManaged")).toHaveLength(0);
  });

  it("is refused when it names an .env key the daemon did not generate, or none when a key is needed", async () => {
    const h = makeJobs();
    const answers: string[] = [];
    h.state.script = async (tools, input) => {
      const triggers = [{ slug: "POSTHOG_EVENT_CAPTURED", config: { project_id: 1 } }];
      answers.push(await tools.save_integration({ entry: { toolkit: "posthog", apiKey: "SOME_OTHER_KEY", connect: { subdomain: "us" }, triggers }, instructions: "1. x" }));
      answers.push(await tools.save_integration({ entry: { toolkit: "posthog", apiKey: "COMPOSIO_API_KEY", connect: { subdomain: "us" }, triggers }, instructions: "1. x" }));
      answers.push(await tools.save_integration({ entry: { toolkit: "posthog", connect: { subdomain: "us" }, triggers }, instructions: "1. x" }));
      answers.push(await tools.save_integration({ entry: { toolkit: "posthog", apiKey: keyNameIn(input), connect: { subdomain: "us" }, triggers } }));
      answers.push(await tools.save_integration({ entry: { toolkit: "posthog", apiKey: keyNameIn(input), connect: { subdomain: "us" }, triggers }, instructions: "1. Open https://eu.posthog.com/settings\n2. Copy." }));
    };
    const jobId = await h.jobs.configure({ toolkit: "posthog", ...OPTIONS });
    await settle();
    expect(answers[0]).toMatch(/did not make; the only key is POSTHOG_SHARED_KEY/);
    expect(answers[1]).toMatch(/did not make/);
    expect(answers[2]).toMatch(/name POSTHOG_SHARED_KEY/);
    expect(answers[3]).toMatch(/needs instructions/);
    expect(answers[4]).toBe("Saved.");
    expect(h.jobs.get(jobId).state).toBe("key");
  });

  it("is refused when its instructions have a link that is not https, HTML, or are too long", async () => {
    const h = makeJobs();
    const answers: string[] = [];
    h.state.script = async (tools, input) => {
      const entry = { toolkit: "posthog", apiKey: keyNameIn(input), connect: { subdomain: "us" } };
      answers.push(await tools.save_integration({ entry, instructions: "1. Go to http://evil.example/x" }));
      answers.push(await tools.save_integration({ entry, instructions: "1. Click javascript:alert(1)" }));
      answers.push(await tools.save_integration({ entry, instructions: "1. <b>Bold</b>" }));
      answers.push(await tools.save_integration({ entry, instructions: "x".repeat(1201) }));
    };
    await h.jobs.configure({ toolkit: "posthog", ...OPTIONS });
    await settle();
    expect(answers.every((a) => a.startsWith("Refused"))).toBe(true);
  });

  it("is overwritten with what the person chose: audience, scope, selfIsUser and the account name", async () => {
    const h = makeJobs();
    h.state.script = async (tools) => {
      await tools.save_integration({ entry: { toolkit: "slack", account: "mine", audience: "public", shared: true, clot: "zzz", selfIsUser: true, triggers: [{ slug: "SLACK_CHANNEL_MESSAGE_RECEIVED", config: { channel_id: "C1" } }] } });
    };
    await h.jobs.configure({ toolkit: "slack", audience: "private", selfIsUser: false, events: true, clot: "graphite" });
    await settle();
    [...h.api.connections.values()][0]!.status = "active";
    await h.jobs.tick();
    expect(composioEntries(h)).toEqual([{ toolkit: "slack", account: "graphite", audience: "private", clot: "graphite", selfIsUser: false, triggers: [{ slug: "SLACK_CHANNEL_MESSAGE_RECEIVED", config: { channel_id: "C1" } }] }]);
  });

  it("has no triggers when events are off, and the person's poll interval on the triggers Composio polls for", async () => {
    const h = makeJobs();
    h.state.script = async (tools) => {
      await tools.save_integration({ entry: { toolkit: "slack", triggers: [{ slug: "SLACK_CHANNEL_MESSAGE_RECEIVED", config: { channel_id: "C1" }, pollMinutes: 1 }] } });
    };
    await h.jobs.configure({ toolkit: "slack", ...OPTIONS, events: false });
    await settle();
    expect(h.jobs.get("job-1").state).toBe("oauth");
    h.api.triggerTypes.set("slack", [{ slug: "SLACK_POLLED", type: "poll" }, { slug: "SLACK_CHANNEL_MESSAGE_RECEIVED", type: "webhook" }]);
    h.state.script = async (tools) => {
      await tools.save_integration({ entry: { toolkit: "slack", triggers: [{ slug: "SLACK_POLLED", config: {} }, { slug: "SLACK_CHANNEL_MESSAGE_RECEIVED", config: { channel_id: "C1" }, pollMinutes: 3 }] } });
    };
    await h.jobs.configure({ toolkit: "slack", ...OPTIONS, pollMinutes: 30, jobId: "job-1" });
    await settle();
    [...h.api.connections.values()][0]!.status = "active";
    await h.jobs.tick();
    expect(composioEntries(h)[0]!.triggers).toEqual([{ slug: "SLACK_POLLED", config: {}, pollMinutes: 30 }, { slug: "SLACK_CHANNEL_MESSAGE_RECEIVED", config: { channel_id: "C1" } }]);
  });

  it("fails the job, with nothing written, when the session ends without proposing anything or throws", async () => {
    const h = makeJobs();
    const a = await h.jobs.configure({ toolkit: "slack", ...OPTIONS });
    await settle();
    expect(h.jobs.get(a)).toMatchObject({ state: "failed", error: "The configurer finished without proposing an entry." });
    h.state.script = async () => {
      throw new Error("the model is down");
    };
    const b = await h.jobs.configure({ toolkit: "slack", ...OPTIONS });
    await settle();
    expect(h.jobs.get(b)).toMatchObject({ state: "failed", error: expect.stringContaining("the model is down") });
    expect(composioEntries(h)).toHaveLength(0);
  });

  it("is told only facts: a built-in toolkit is flagged, and the Clot to be is allowed in the check", async () => {
    const h = makeJobs();
    h.state.script = slackScript;
    await h.jobs.configure({ toolkit: "slack", ...OPTIONS, clot: "NotMadeYet" });
    await settle();
    expect(h.inputs[0]!.prompt).toContain("Scope: only the Clot NotMadeYet.");
    expect(h.inputs[0]!.prompt).toContain("Built in: no");
    expect(h.inputs[0]!.systemPrompt).toContain("THE SKILL");
    expect(h.jobs.get("job-1").state).toBe("oauth");
  });

  it("for a toolkit that needs an OAuth app of its own, says so at once", async () => {
    const h = makeJobs();
    h.api.meta.set("custom", { slug: "custom", name: "Custom", managed: [], schemes: [{ scheme: "OAUTH2", required: [], optional: [], creationRequired: ["client_id", "client_secret"] }] });
    await expect(h.jobs.configure({ toolkit: "custom", ...OPTIONS })).rejects.toMatchObject({ status: 400, message: expect.stringContaining("OAuth app of your own") });
  });
});

describe("a Clot that does not exist yet", () => {
  it("holds the entry once the connection is ready, hands it over for the Clot, and drops it after an hour otherwise", async () => {
    const h = makeJobs();
    const jobId = await slackToOAuth(h, { clot: "Fresh" });
    [...h.api.connections.values()][0]!.status = "active";
    await h.jobs.tick();
    expect(h.jobs.get(jobId)).toMatchObject({ state: "active", held: true, clot: "Fresh" });
    expect(composioEntries(h)).toHaveLength(0);

    expect(h.jobs.claim([jobId], "graphite")).toMatchObject({ ok: false });
    const claimed = h.jobs.claim([jobId], "fresh");
    expect(claimed).toMatchObject({ ok: true, entries: [{ toolkit: "slack", account: "fresh", clot: "fresh" }] });
    h.jobs.committed([jobId]);
    expect(h.jobs.claim([jobId], "fresh")).toMatchObject({ ok: false });
    // The connection stays: the tool uses it now.
    h.clock.now += 2 * ABANDON_AFTER_MS;
    await h.jobs.tick();
    expect(h.api.of("deleteConnection")).toHaveLength(0);
  });

  it("removes the connection of a Clot that was never made", async () => {
    const h = makeJobs();
    const jobId = await slackToOAuth(h, { clot: "ghost" });
    [...h.api.connections.values()][0]!.status = "active";
    await h.jobs.tick();
    h.clock.now += ABANDON_AFTER_MS;
    await h.jobs.tick();
    expect(h.api.connections.size).toBe(0);
    expect(h.jobs.get(jobId)).toMatchObject({ state: "failed", error: "The Clot was not created in an hour." });
    expect(h.jobs.claim([jobId], "ghost")).toMatchObject({ ok: false });
  });
});

describe("reconnecting a tool", () => {
  it("deletes the old connection, shows a new link, and tells the component when it is active, without touching the configuration", async () => {
    const h = makeJobs();
    const first = await slackToOAuth(h);
    [...h.api.connections.values()][0]!.status = "active";
    await h.jobs.tick();
    expect(h.jobs.get(first).state).toBe("active");
    const save = vi.spyOn(h.config, "save");

    const jobId = await h.jobs.reconnect("slack:shared");
    await settle();
    expect(h.forgotten).toEqual(["slack:shared"]);
    expect(h.jobs.get(jobId)).toMatchObject({ state: "oauth", link: expect.stringContaining("https://") });
    [...h.api.connections.values()].at(-1)!.status = "active";
    await h.jobs.tick();
    expect(h.jobs.get(jobId).state).toBe("active");
    expect(h.reconnected).toEqual(["slack:shared"]);
    expect(save).not.toHaveBeenCalled();
    expect(composioEntries(h)).toHaveLength(1);
  });

  it("goes straight to the key field for a key tool, and the new key goes to .env", async () => {
    const h = makeJobs();
    h.state.script = posthogScript;
    const first = await h.jobs.configure({ toolkit: "posthog", ...OPTIONS });
    await settle();
    await h.jobs.putKey(first, "old_value");
    const jobId = await h.jobs.reconnect("posthog:shared");
    await settle();
    expect(h.jobs.get(jobId)).toMatchObject({ state: "key", keyName: "POSTHOG_SHARED_KEY" });
    await h.jobs.putKey(jobId, "new_value");
    expect(fs.readFileSync(h.envFile, "utf8")).toContain("POSTHOG_SHARED_KEY=new_value");
    expect(h.reconnected).toEqual(["posthog:shared"]);
    expect(h.jobs.get(jobId).state).toBe("active");
  });

  it("says so for a tool that is not there", async () => {
    const h = makeJobs();
    await expect(h.jobs.reconnect("slack:none")).rejects.toMatchObject({ status: 404 });
  });

  it("a reconnect abandoned at the link removes the new connection", async () => {
    const h = makeJobs();
    await slackToOAuth(h);
    [...h.api.connections.values()][0]!.status = "active";
    await h.jobs.tick();
    const jobId = await h.jobs.reconnect("slack:shared");
    await settle();
    expect(h.api.connections.size).toBe(1);
    await h.jobs.abandon(jobId);
    expect(h.api.connections.size).toBe(0);
  });
});
