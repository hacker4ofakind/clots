import { promisify } from "node:util";
import { beforeEach, describe, expect, it, vi } from "vitest";

/** Docker as the tests need it: every call is recorded, and a call can be made to fail. */
const calls: { args: string[]; env?: Record<string, string | undefined> }[] = [];
let fail: (args: string[]) => string | undefined;
let volumes: string[];

vi.mock("node:child_process", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:child_process")>();
  const execFile = (() => undefined) as unknown as typeof real.execFile;
  (execFile as unknown as Record<symbol, unknown>)[promisify.custom] = async (file: string, args: string[], opts?: { env?: Record<string, string | undefined> }) => {
    if (file !== "docker") throw new Error(`unexpected command ${file}`);
    calls.push({ args, env: opts?.env });
    const problem = fail(args);
    if (problem !== undefined) throw Object.assign(new Error(problem), { stderr: problem });
    return { stdout: args[0] === "volume" && args[1] === "ls" ? volumes.join("\n") : "", stderr: "" };
  };
  return { ...real, execFile };
});

const { recloneWorkspace, ensureContainer } = await import("../src/agent/container.js");
const verbs = () => calls.map((c) => c.args.slice(0, 2).join(" "));

beforeEach(() => {
  calls.length = 0;
  fail = () => undefined;
  volumes = [];
});

describe("moving a Clot to another repository", () => {
  const o = { clot: "Graphite", image: "clots-clot:dev", repoUrl: "https://github.com/o/new.git", githubToken: "ghp_secret123", at: 1_800_000_000_000 };

  it("clones into a fresh volume in a throwaway container, then puts the Clot's container on it, keeping the old volume", async () => {
    const { volume } = await recloneWorkspace(o);
    expect(volume).toBe(`clot-graphite-work-${o.at.toString(36)}`);
    expect(verbs()).toEqual(["volume create", "run --rm", "stop clot-graphite", "rename clot-graphite", "run -d", "rm -f"]);
    const run = calls[4]!.args;
    expect(run).toContain(`${volume}:/workspace`);
    expect(run).toContain("clot-graphite-home:/home/clot");
    // The old container is removed by name, and no volume is ever removed on success.
    expect(calls.some((c) => c.args[0] === "volume" && c.args[1] === "rm")).toBe(false);
    expect(calls.some((c) => c.args.includes("-v") && c.args.includes("clot-graphite-work:/workspace"))).toBe(false);
  });

  it("sends the token as an environment variable, never in an argument", async () => {
    await recloneWorkspace(o);
    for (const c of calls) expect(c.args.join(" ")).not.toContain("ghp_secret123");
    expect(calls[1]!.env).toMatchObject({ GH_TOKEN: "ghp_secret123", REPO_URL: o.repoUrl });
    expect(calls[1]!.args).toEqual(expect.arrayContaining(["-e", "GH_TOKEN", "-e", "REPO_URL"]));
  });

  it("leaves the Clot alone when the clone fails: its container is never stopped and the new volume goes", async () => {
    fail = (args) => (args[0] === "run" && args[1] === "--rm" ? "fatal: repository not found" : undefined);
    await expect(recloneWorkspace(o)).rejects.toThrow(/could not be cloned: fatal: repository not found/);
    expect(verbs()).toEqual(["volume create", "run --rm", "volume rm"]);
  });

  it("puts the old container back when the new one will not start", async () => {
    fail = (args) => (args[0] === "run" && args[1] === "-d" ? "port is already allocated" : undefined);
    await expect(recloneWorkspace(o)).rejects.toThrow(/new container could not start/);
    expect(calls.slice(4).map((c) => c.args[0])).toEqual(["run", "rm", "rename", "start", "volume"]);
    const back = calls.find((c) => c.args[0] === "rename" && c.args[2] === "clot-graphite")!;
    expect(back.args[1]).toBe(calls[3]!.args[2]);
  });
});

describe("the old container waits for what follows the swap", () => {
  const o = { clot: "Graphite", image: "clots-clot:dev", repoUrl: "https://github.com/o/new.git", githubToken: "t", at: 1_800_000_000_000 };

  it("keeps the old container until the follow-up step has worked, then removes it", async () => {
    let seen: string[] = [];
    await recloneWorkspace({ ...o, after: async () => void (seen = verbs()) });
    expect(seen).toEqual(["volume create", "run --rm", "stop clot-graphite", "rename clot-graphite", "run -d"]);
    expect(verbs().at(-1)).toBe("rm -f");
  });

  it("puts the old container back and drops the new volume when the follow-up step fails", async () => {
    await expect(recloneWorkspace({ ...o, after: async () => Promise.reject(new Error("its entry could not be saved")) })).rejects.toThrow(/entry could not be saved/);
    expect(calls.slice(5).map((c) => c.args[0])).toEqual(["rm", "rename", "start", "volume"]);
    // The container removed is the new one, by the Clot's name; the old one was renamed back, never removed.
    expect(calls[5]!.args).toEqual(["rm", "-f", "clot-graphite"]);
    expect(calls[6]!.args[2]).toBe("clot-graphite");
    expect(calls.filter((c) => c.args[0] === "rm" && c.args[2] !== "clot-graphite")).toEqual([]);
  });
});

describe("a container made again uses the newest workspace", () => {
  it("mounts the volume the Clot was moved to, not the first one", async () => {
    volumes = ["clot-graphite-home", "clot-graphite-work", `clot-graphite-work-${(1_800_000_000_000).toString(36)}`];
    fail = (args) => (args[0] === "inspect" ? "no such container" : args[0] === "exec" ? "skipped in this test" : undefined);
    await ensureContainer({ clot: "graphite", image: "clots-clot:dev", githubToken: "t" }).catch(() => undefined);
    const run = calls.find((c) => c.args[0] === "run")!.args;
    expect(run).toContain(`clot-graphite-work-${(1_800_000_000_000).toString(36)}:/workspace`);
  });
});
