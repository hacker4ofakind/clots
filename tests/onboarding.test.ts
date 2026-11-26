import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { beforeEach, describe, expect, it } from "vitest";
import { ConfigStore } from "../src/config-store.js";
import { LiveEnv } from "../src/live-env.js";
import { ClotCreator, onboardingMessage, scrub } from "../src/onboarding/create.js";
import { activeVariant, colourClusters, IconError, IconStore, processIcon, sniff } from "../src/onboarding/icons.js";
import { checkRepoAccess } from "../src/onboarding/repo-access.js";

/** GitHub as the tests need it: answers by method and path. */
function github(answers: Record<string, { status: number; body?: unknown }>) {
  const calls: string[] = [];
  const fetchFn = (async (url: string, init: RequestInit = {}) => {
    const key = `${init.method ?? "GET"} ${url.replace("https://api.github.com", "")}`;
    calls.push(key);
    const a = answers[key] ?? { status: 404, body: {} };
    return new Response(a.status === 204 ? null : JSON.stringify(a.body ?? {}), { status: a.status });
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

describe("repository access", () => {
  it("is fine when the machine account can read the repository", async () => {
    const { fetchFn } = github({ "GET /repos/o/r": { status: 200 } });
    expect(await checkRepoAccess({ token: "t", repo: "o/r", fetchFn })).toEqual({ ok: true });
  });

  it("accepts a pending invitation with the account's own token", async () => {
    const { fetchFn, calls } = github({ "GET /repos/o/r": { status: 404 }, "GET /user/repository_invitations": { status: 200, body: [{ id: 5, repository: { full_name: "O/R" } }] }, "PATCH /user/repository_invitations/5": { status: 204 } });
    expect(await checkRepoAccess({ token: "t", repo: "o/r", fetchFn })).toEqual({ ok: true, accepted: true });
    expect(calls).toContain("PATCH /user/repository_invitations/5");
  });

  it("says whom to invite when there is no invitation", async () => {
    const { fetchFn } = github({ "GET /repos/o/r": { status: 404 }, "GET /user/repository_invitations": { status: 200, body: [] }, "GET /user": { status: 200, body: { login: "clots-dot-dev" } } });
    const res = await checkRepoAccess({ token: "t", repo: "o/r", fetchFn });
    expect(res).toMatchObject({ ok: false, invite: true, login: "clots-dot-dev" });
    expect((res as { message: string }).message).toContain("Invite clots-dot-dev");
  });

  it("says in plain words why GitHub did not answer, and never as a status line", async () => {
    const answer = async (answers: Record<string, { status: number; body?: unknown }>) => ((await checkRepoAccess({ token: "t", repo: "o/r", fetchFn: github(answers).fetchFn })) as { ok: false; message: string; invite: boolean });
    expect(await answer({ "GET /repos/o/r": { status: 401 } })).toMatchObject({ invite: false, message: expect.stringContaining("CLOT_GITHUB_TOKEN") });
    expect(await answer({ "GET /repos/o/r": { status: 429 } })).toMatchObject({ invite: false, message: expect.stringContaining("limiting requests") });
    expect(await answer({ "GET /repos/o/r": { status: 503 } })).toMatchObject({ invite: false, message: expect.stringContaining("having trouble") });
    const down = (async () => { throw new Error("getaddrinfo ENOTFOUND api.github.com"); }) as unknown as typeof fetch;
    const res = (await checkRepoAccess({ token: "t", repo: "o/r", fetchFn: down })) as { message: string };
    expect(res.message).toBe("GitHub could not be reached. Check the internet connection.");
  });

  it("refuses a repository name GitHub would not allow before calling anything", async () => {
    const { fetchFn, calls } = github({});
    expect(await checkRepoAccess({ token: "t", repo: "../../x", fetchFn })).toMatchObject({ ok: false });
    expect(calls).toEqual([]);
  });
});

const rect = (w: number, h: number, colours: [number, number, number][]) => {
  const data = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const c = colours[Math.min(colours.length - 1, Math.floor((x / w) * colours.length))]!;
      const i = (y * w + x) * 4;
      data[i] = c[0];
      data[i + 1] = c[1];
      data[i + 2] = c[2];
      data[i + 3] = 255;
    }
  return data;
};
const png = (w: number, h: number, colours: [number, number, number][]) => sharp(rect(w, h, colours), { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();
const pixelAt = async (buf: Buffer, x: number, y: number) => {
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const i = (y * info.width + x) * 4;
  return [data[i]!, data[i + 1]!, data[i + 2]!, data[i + 3]!];
};

describe("icons", () => {
  it("swaps the two colours of a two-colour image, and inverts anything else", async () => {
    const two = await processIcon(await png(64, 64, [[200, 30, 30], [250, 250, 250]]));
    expect(colourClusters({ data: await sharp(two.normal).ensureAlpha().raw().toBuffer(), width: 256, height: 256 })).toHaveLength(2);
    const [leftN, rightN] = [await pixelAt(two.normal, 20, 128), await pixelAt(two.normal, 236, 128)];
    const [leftA, rightA] = [await pixelAt(two.active, 20, 128), await pixelAt(two.active, 236, 128)];
    expect(leftA.slice(0, 3)).toEqual(rightN.slice(0, 3));
    expect(rightA.slice(0, 3)).toEqual(leftN.slice(0, 3));

    const photo = await processIcon(await png(64, 64, [[10, 20, 30], [40, 90, 150], [100, 160, 40], [220, 120, 60]]));
    const n = await pixelAt(photo.normal, 20, 128);
    const a = await pixelAt(photo.active, 20, 128);
    expect(a.slice(0, 3)).toEqual([255 - n[0]!, 255 - n[1]!, 255 - n[2]!]);
  });

  it("draws an SVG to pixels and stores a PNG, never the markup", async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="#e11"/><script>alert(1)</script></svg>');
    expect(sniff(svg)).toBe("svg");
    const icon = await processIcon(svg);
    expect(sniff(icon.normal)).toBe("png");
    expect(icon.normal.toString("latin1")).not.toContain("script");
  });

  it("reads a file by its own bytes and refuses what is not an image, in plain words", async () => {
    await expect(processIcon(Buffer.from("MZ not an image at all"))).rejects.toThrow(IconError);
    await expect(processIcon(Buffer.from("MZ not an image at all"))).rejects.toThrow(/isn't an image Clots can use/);
    await expect(processIcon(Buffer.alloc(3 * 1024 * 1024, 1))).rejects.toThrow(/up to 2 MB/);
  });

  it("keeps an icon by an id it makes, serves both variants, and refuses any other id", async () => {
    const store = new IconStore(fs.mkdtempSync(path.join(os.tmpdir(), "clots-icons-")));
    const id = await store.add(await png(32, 32, [[1, 2, 3], [250, 250, 250]]));
    expect(id).toMatch(/^[a-f0-9]{16}$/);
    expect(sniff(store.read(id, false)!)).toBe("png");
    expect(store.read(id, true)).toBeDefined();
    expect(store.read("../../etc/passwd", false)).toBeUndefined();
    expect(store.read("0000000000000000", false)).toBeUndefined();
  });

  it("activeVariant leaves transparent pixels alone", () => {
    const data = Buffer.from([10, 20, 30, 0, 200, 200, 200, 255]);
    const out = activeVariant({ data, width: 2, height: 1 });
    expect([...out.subarray(0, 4)]).toEqual([10, 20, 30, 0]);
    expect([...out.subarray(4, 7)]).toEqual([55, 55, 55]);
  });
});

describe("creating a Clot", () => {
  let dir: string;
  let config: ConfigStore;
  let steps: { clot: string; step: string; log?: string }[];
  let access: Record<string, { status: number; body?: unknown }>;
  let startFails: string | undefined;
  let started: string[];
  let creator: ClotCreator;
  let ready: string[];

  const waitDone = async () => {
    for (let i = 0; i < 50 && !steps.some((s) => s.step === "done" || s.step === "failed"); i++) await new Promise((r) => setTimeout(r, 10));
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "clots-create-"));
    const file = path.join(dir, "clots.config.json");
    const envFile = path.join(dir, ".env");
    fs.writeFileSync(envFile, "CLAUDE_CODE_OAUTH_TOKEN=c\nCLOT_GITHUB_TOKEN=ghp_secret123\nGITHUB_WEBHOOK_SECRET=w\n");
    fs.writeFileSync(file, JSON.stringify({ timeZone: "UTC", image: "i", ui: { owner: "me" }, home: true, clots: [{ name: "graphite", repoUrl: "https://github.com/o/r.git" }] }));
    config = new ConfigStore({ file, envFile, env: new LiveEnv(envFile, {}) });
    steps = [];
    started = [];
    ready = [];
    startFails = undefined;
    access = { "GET /repos/o/new": { status: 200 } };
    const { fetchFn } = { fetchFn: (async (url: string, init: RequestInit = {}) => {
      const a = access[`${init.method ?? "GET"} ${url.replace("https://api.github.com", "")}`] ?? { status: 404, body: {} };
      return new Response(a.status === 204 ? null : JSON.stringify(a.body ?? {}), { status: a.status });
    }) as unknown as typeof fetch };
    creator = new ClotCreator({
      config,
      token: () => "ghp_secret123",
      fetchFn,
      start: async (def, step) => {
        started.push(def.name);
        step("building");
        if (startFails) throw new Error(startFails);
      },
      emit: (e) => void steps.push(e),
      onReady: async (name) => void ready.push(name),
    });
  });

  it("finds a taken name, a bad container name, a reserved one, a bad repository and an unreachable one", async () => {
    expect((await creator.validate({ name: "graphite", repo: "o/new" })).errors.name).toContain("already");
    expect((await creator.validate({ name: "Bad Name", repo: "o/new" })).errors.name).toContain("letters, digits and hyphens");
    expect((await creator.validate({ name: "home", repo: "o/new" })).errors.name).toContain("is reserved");
    // A name keeps its capitals, but is checked on its slug: Graphite is graphite, and Home is home.
    expect((await creator.validate({ name: "Graphite", repo: "o/new" })).errors.name).toContain("already");
    expect((await creator.validate({ name: "Home", repo: "o/new" })).errors.name).toContain("is reserved");
    expect((await creator.validate({ name: "Truecast", repo: "o/new" })).errors.name).toBeUndefined();
    expect((await creator.validate({ name: "fresh", repo: "nope" })).errors.repo).toContain("owner/name");
    const none = await creator.validate({ name: "fresh", repo: "o/private" });
    expect(none.ok).toBe(false);
    expect(none.errors.repo).toContain("cannot reach");
    expect(none.errors.repo?.match(/Invite/g)).toHaveLength(1);
    expect(none.errors.repo).toMatch(/press Check again\.$/);
  });

  it("accepts a pending invitation while checking", async () => {
    access = { "GET /repos/o/new": { status: 404 }, "GET /user/repository_invitations": { status: 200, body: [{ id: 9, repository: { full_name: "o/new" } }] }, "PATCH /user/repository_invitations/9": { status: 204 } };
    expect(await creator.validate({ name: "fresh", repo: "o/new" })).toMatchObject({ ok: true, accepted: true });
  });

  it("writes the entry, builds the Clot with each step sent, and puts the checklist in its chat", async () => {
    expect(await creator.create({ name: "fresh", repo: "o/new", icon: { phosphor: "Sliders", color: "teal" } })).toEqual({ ok: true });
    await waitDone();
    expect(steps.map((s) => s.step)).toEqual(["cloning", "building", "done"]);
    expect(config.current.clots.find((c) => c.name === "fresh")).toMatchObject({ repoUrl: "https://github.com/o/new.git", icon: { phosphor: "Sliders", color: "teal" } });
    expect(started).toEqual(["fresh"]);
    expect(ready).toEqual(["fresh"]);
    expect(creator.building.has("fresh")).toBe(false);
  });

  it("reports a failed build with its log, without the token, frees the name, and retries", async () => {
    startFails = "fatal: could not read https://x-access-token:ghp_secret123@github.com/o/new.git";
    await creator.create({ name: "fresh", repo: "o/new" });
    await waitDone();
    const failed = steps.at(-1)!;
    expect(failed.step).toBe("failed");
    expect(failed.log).not.toContain("ghp_secret123");
    expect(failed.log).toContain("***");
    // A page reloaded after the failure still finds the step and the cleaned log.
    expect(creator.buildOf("fresh")).toEqual({ step: "failed", log: failed.log });
    expect(config.current.clots.some((c) => c.name === "fresh")).toBe(false);
    startFails = undefined;
    steps = [];
    expect(await creator.retry("fresh")).toBe(true);
    await waitDone();
    expect(steps.at(-1)!.step).toBe("done");
    expect(config.current.clots.some((c) => c.name === "fresh")).toBe(true);
    expect(creator.buildOf("fresh")).toBeUndefined();
  });

  it("scrubs secrets and URL credentials from a log, and names the checklist's data, with no secret in the message", () => {
    expect(scrub("clone https://user:pw@github.com/x failed with tok_abcdef", ["tok_abcdef"])).toBe("clone https://***@github.com/x failed with ***");
    const message = onboardingMessage({ name: "Fresh", repo: "o/new", webhookUrl: "https://box.ts.net/webhooks/github" });
    expect(message.text).toBe("Fresh is ready. Three steps finish its setup.");
    expect(message.data).toEqual({ repo: "o/new", webhookUrl: "https://box.ts.net/webhooks/github" });
    expect(JSON.stringify(message)).not.toMatch(/secret/i);
  });
});
