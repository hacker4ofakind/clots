import { execFile, execFileSync, spawn } from "node:child_process";
import { promisify } from "node:util";
import type { SpawnOptions, SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
import { slugOf } from "../clot-name.js";

const run = promisify(execFile);

export function containerName(clot: string): string {
  return `clot-${slugOf(clot)}`;
}

/** The address GitHub attributes to an account whatever its email privacy settings. */
export function noreplyEmail(id: number, login: string): string {
  return `${id}+${login}@users.noreply.github.com`;
}

/**
 * Commits carry the address of the account that owns the Clot's token: hosts
 * such as Vercel refuse to build a commit whose email matches no GitHub
 * account. Without it the address is on a reserved domain that matches nobody.
 */
export function gitIdentity(clot: string, email?: string): { name: string; email: string } {
  return { name: `${slugOf(clot)}-clot`, email: email ?? `${slugOf(clot)}-clot@clots.invalid` };
}

/** The SDK hands us a host command line. Inside the container the binary is always `claude`. */
export function toContainerCommand(command: string, args: string[]): string[] {
  const base = command.split(/[\\/]/).pop() ?? "";
  const isRuntime = /^(node|bun|deno)(\.exe)?$/.test(base);
  const rest = isRuntime && /\.(c|m)?js$/.test(args[0] ?? "") ? args.slice(1) : args;
  return ["claude", ...rest];
}

export function pickSdkEnv(env: Record<string, string | undefined>): Record<string, string> {
  const picked: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    // The daemon's own token is in its environment too; a session's credentials come only from sessionEnv.
    if (key === "CLAUDE_CODE_OAUTH_TOKEN") continue;
    if (value !== undefined && /^(CLAUDE_CODE_|CLAUDE_AGENT_)/.test(key)) picked[key] = value;
  }
  return picked;
}

/**
 * The secrets a session in the container receives. A container that has been
 * logged in with `claude /login` uses that login, which also brings the
 * account's connectors (such as Claude Docs); the token from `claude
 * setup-token` carries none, and would override the login if passed.
 */
export function sessionEnv(o: { claudeToken: string; githubToken: string; ownLogin: boolean }): Record<string, string> {
  return { ...(o.ownLogin ? {} : { CLAUDE_CODE_OAUTH_TOKEN: o.claudeToken }), GH_TOKEN: o.githubToken };
}

/** Whether the container holds a login made with `claude /login`. */
export function hasOwnLogin(container: string): boolean {
  try {
    execFileSync("docker", ["exec", container, "test", "-s", "/home/clot/.claude/.credentials.json"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** `-e NAME` without a value makes docker read it from its own environment, keeping secrets off the command line. */
export function dockerExecArgs(o: { container: string; cwd: string; envKeys: string[]; command: string[] }): string[] {
  return ["exec", "-i", "-w", o.cwd, ...o.envKeys.flatMap((k) => ["-e", k]), o.container, ...o.command];
}

export function makeSpawn(o: { container: string; cwd: string; env: Record<string, string> }): (s: SpawnOptions) => SpawnedProcess {
  return (s) => {
    const env = { ...pickSdkEnv(s.env), ...o.env };
    const args = dockerExecArgs({
      container: o.container,
      cwd: o.cwd,
      envKeys: Object.keys(env),
      command: toContainerCommand(s.command, s.args),
    });
    return spawn("docker", args, { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "inherit"], signal: s.signal });
  };
}

/** Whether Claude Code already holds a transcript for this session in the container. */
export function sessionExists(container: string, sessionId: string): boolean {
  try {
    execFileSync("docker", ["exec", container, "sh", "-c", 'ls /home/clot/.claude/projects/*/"$1".jsonl', "sh", sessionId], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * What the container needs at startup. `info` is `docker inspect`'s "<running> <image id>", or
 * undefined when there is no container. A container made from an older build of the image is
 * recreated: the image carries Claude Code, and the home and workspace volumes keep the rest.
 */
export function containerStep(info: string | undefined, currentImage: string | undefined): "create" | "recreate" | "start" | "none" {
  if (info === undefined) return "create";
  const [running, image] = info.split(" ");
  if (currentImage !== undefined && image !== currentImage) return "recreate";
  return running === "true" ? "none" : "start";
}

/** The names a Clot's workspace volume can have: `<container>-work`, and `<container>-work-<stamp>` for each repository change since. */
const isWorkspace = (container: string, volume: string): boolean => volume === `${container}-work` || new RegExp(`^${container}-work-[0-9a-z]+$`).test(volume);

/** The workspace volume a Clot uses now: the newest of its volumes (a repository change makes a newer one and keeps the old). Container names are letters, digits and hyphens. */
export function newestWorkspace(container: string, volumes: string[]): string {
  const mine = volumes.filter((v) => isWorkspace(container, v));
  const stamp = (v: string) => v.slice(`${container}-work`.length + 1);
  return mine.sort((a, b) => stamp(a).length - stamp(b).length || stamp(a).localeCompare(stamp(b))).at(-1) ?? `${container}-work`;
}

async function currentWorkspace(container: string): Promise<string> {
  const listed = await run("docker", ["volume", "ls", "-q", "--filter", `name=${container}-work`]).then((r) => r.stdout.split(/\s+/).filter(Boolean), () => []);
  return newestWorkspace(container, listed);
}

/**
 * Starts the Clot's container if needed, sets up git in it and clones the repository, when the
 * Clot has one: the home Clot does not. Returns the login of the account that owns the token,
 * when it can be read.
 */
export async function ensureContainer(o: { clot: string; image: string; repoUrl?: string; githubToken: string }): Promise<string | undefined> {
  const name = containerName(o.clot);
  const [info, currentImage] = await Promise.all([
    run("docker", ["inspect", "-f", "{{.State.Running}} {{.Image}}", name]).then((r) => r.stdout.trim(), () => undefined),
    run("docker", ["image", "inspect", "-f", "{{.Id}}", o.image]).then((r) => r.stdout.trim(), () => undefined),
  ]);
  const step = containerStep(info, currentImage);
  if (step === "recreate") {
    console.log(`[${o.clot}] the image was rebuilt; recreating the container, keeping its volumes`);
    await run("docker", ["rm", "-f", name]);
  }
  if (step === "create" || step === "recreate") {
    await run("docker", [
      "run", "-d", "--name", name, "--restart", "unless-stopped",
      "-v", `${name}-home:/home/clot`, "-v", `${await currentWorkspace(name)}:/workspace`, o.image,
    ]);
  } else if (step === "start") {
    await run("docker", ["start", name]);
  }

  const script = [
    `git config --global credential.helper '!f() { echo username=x-access-token; echo "password=$GH_TOKEN"; }; f'`,
    `git config --global user.name "$CLOT_GIT_NAME"`,
    `git config --global user.email "$CLOT_GIT_EMAIL"`,
    ...(o.repoUrl === undefined ? [] : [`[ -d /workspace/repo/.git ] || git clone "$REPO_URL" /workspace/repo`]),
  ].join(" && ");
  const account = await run("docker", ["exec", "-e", "GH_TOKEN", name, "gh", "api", "user"], { env: { ...process.env, GH_TOKEN: o.githubToken } }).then(
    (r) => JSON.parse(r.stdout) as { id?: unknown; login?: unknown },
    () => undefined,
  );
  const email = typeof account?.id === "number" && typeof account.login === "string" ? noreplyEmail(account.id, account.login) : undefined;
  if (!email) console.warn(`[${o.clot}] could not read the token's GitHub account; commits will use an unmatched address`);
  const identity = gitIdentity(o.clot, email);
  await run("docker", ["exec", "-e", "GH_TOKEN", "-e", "REPO_URL", "-e", "CLOT_GIT_NAME", "-e", "CLOT_GIT_EMAIL", name, "sh", "-c", script], {
    env: { ...process.env, GH_TOKEN: o.githubToken, REPO_URL: o.repoUrl ?? "", CLOT_GIT_NAME: identity.name, CLOT_GIT_EMAIL: identity.email },
  });
  return typeof account?.login === "string" ? account.login : undefined;
}

/** What a repository change needs from Docker: the new volume's name for a Clot, from a time stamp. */
export const newWorkspaceName = (clot: string, at: number): string => `${containerName(clot)}-work-${at.toString(36)}`;

/**
 * Moves a Clot to another repository: the new one is cloned into a fresh workspace volume by a throwaway container, so the running
 * Clot is not touched until the clone has worked; then its container is replaced by one on the new volume, with the same home volume.
 * The old workspace volume stays (the user may want something out of it); the old container is removed. A clone that fails leaves the
 * Clot exactly as it was, and so does a container that will not start, or an `after` step (the Clot started on the new workspace, its
 * entry saved) that throws: the old one is put back.
 * Everything goes to docker as an argument list; the token travels as an environment variable, never in an argument.
 */
export async function recloneWorkspace(o: { clot: string; image: string; repoUrl: string; githubToken: string; at?: number; after?: () => Promise<void> }): Promise<{ volume: string }> {
  const name = containerName(o.clot);
  const volume = newWorkspaceName(o.clot, o.at ?? Date.now());
  const env = { ...process.env, GH_TOKEN: o.githubToken, REPO_URL: o.repoUrl };
  await run("docker", ["volume", "create", volume]);
  try {
    const script = [`git config --global credential.helper '!f() { echo username=x-access-token; echo "password=$GH_TOKEN"; }; f'`, `git clone "$REPO_URL" /workspace/repo`].join(" && ");
    await run("docker", ["run", "--rm", "-e", "GH_TOKEN", "-e", "REPO_URL", "-v", `${volume}:/workspace`, o.image, "sh", "-c", script], { env });
  } catch (error) {
    await run("docker", ["volume", "rm", volume]).catch(() => undefined);
    throw new Error(`the repository could not be cloned: ${(error as { stderr?: string }).stderr || (error as Error).message}`);
  }
  const old = `${name}-before-${volume.slice(-8)}`;
  await run("docker", ["stop", name]).catch(() => undefined);
  await run("docker", ["rename", name, old]);
  // The old container is put back, and the new volume goes, when what follows the swap fails.
  const putBack = async () => {
    await run("docker", ["rm", "-f", name]).catch(() => undefined);
    await run("docker", ["rename", old, name]).catch(() => undefined);
    await run("docker", ["start", name]).catch(() => undefined);
    await run("docker", ["volume", "rm", volume]).catch(() => undefined);
  };
  try {
    await run("docker", ["run", "-d", "--name", name, "--restart", "unless-stopped", "-v", `${name}-home:/home/clot`, "-v", `${volume}:/workspace`, o.image]);
  } catch (error) {
    await putBack();
    throw new Error(`the new container could not start: ${(error as { stderr?: string }).stderr || (error as Error).message}`);
  }
  // The old container stays until the caller has started the Clot on the new one and saved its new repository: a failure in either puts it back.
  try {
    await o.after?.();
  } catch (error) {
    await putBack();
    throw error;
  }
  await run("docker", ["rm", "-f", old]).catch(() => undefined);
  return { volume };
}

/** Where the daemon's plugin is in every container: outside the home volume, and the root user's. */
export const PLUGIN_DIR = "/opt/clots/plugin";

/**
 * The docker arguments that put a plugin folder into a container, in order: remove what is there, copy the
 * folder in (from the folder itself, so no host path reaches docker's `container:path` syntax), then make
 * it root's and read-only to the Clot. A Clot steered by outsider text cannot rewrite its own skill.
 */
export function pluginInstallSteps(container: string): { args: string[]; inSource: boolean }[] {
  return [
    { args: ["exec", "-u", "root", container, "sh", "-c", `rm -rf ${PLUGIN_DIR} && mkdir -p ${PLUGIN_DIR}`], inSource: false },
    { args: ["cp", "./.", `${container}:${PLUGIN_DIR}`], inSource: true },
    { args: ["exec", "-u", "root", container, "sh", "-c", `chown -R root:root ${PLUGIN_DIR} && chmod -R a+rX,go-w ${PLUGIN_DIR}`], inSource: false },
  ];
}

/** Copies the plugin folder into the container, replacing what is there. Throws on a failed step: the caller logs it and the Clot starts without the skill. */
export async function installPlugin(container: string, source: string): Promise<void> {
  for (const step of pluginInstallSteps(container)) {
    await run("docker", step.args, { timeout: EXEC_TIMEOUT_MS, ...(step.inSource ? { cwd: source } : {}) });
  }
}

// Workers. Every git command the daemon runs in a container goes through that container's own
// chain, one at a time: git commands in one shared .git collide on its lock files.

const REPO = "/workspace/repo";
const EXEC_TIMEOUT_MS = 120_000;
const chains = new Map<string, Promise<unknown>>();

/** Where a worker works: a worktree of the clone, or a plain directory for the home Clot. */
export function worktreePath(workerId: string, home: boolean): string {
  return home ? `/workspace/workers/${workerId}` : `/workspace/worktrees/${workerId}`;
}

/**
 * The docker arguments for each worker step. The branch and the path come from titles the model
 * wrote, so they are passed as the script's positional arguments, never put into its text. A step
 * that fetches passes GH_TOKEN: git's credential helper in the container reads it from there.
 */
export const workerExec = {
  defaultBranch: (container: string) => ["exec", container, "git", "-C", REPO, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
  addWorktree: (container: string, path: string, branch: string, base: string) => [
    "exec", "-e", "GH_TOKEN", container, "sh", "-c",
    `git -C ${REPO} fetch origin && git -C ${REPO} worktree add --no-track -b "$1" "$2" "origin/$3"`,
    "sh", branch, path, base,
  ],
  addDirectory: (container: string, path: string) => ["exec", container, "mkdir", "-p", path],
  removeWorktree: (container: string, path: string) => [
    "exec", container, "sh", "-c",
    `if [ -e "$1" ]; then git -C ${REPO} worktree remove --force "$1"; fi && git -C ${REPO} worktree prune`,
    "sh", path,
  ],
  removeDirectory: (container: string, path: string) => ["exec", container, "rm", "-rf", path],
  exists: (container: string, path: string) => ["exec", container, "test", "-d", path],
  // A clone an earlier version edited in place may hold unfinished work: it is stashed, not thrown
  // away, before the checkout. A local branch it was on keeps its commits.
  refreshMain: (container: string, base: string) => [
    "exec", "-e", "GH_TOKEN", container, "sh", "-c",
    `git -C ${REPO} fetch origin && { [ -z "$(git -C ${REPO} status --porcelain)" ] || git -C ${REPO} stash push --include-untracked -m "clots: kept before refreshing the main checkout"; } && git -C ${REPO} checkout --detach --force "origin/$1"`,
    "sh", base,
  ],
  killStray: (container: string) => ["exec", container, "pkill", "-x", "claude"],
  // The session ID is on the claude process's command line (--session-id or --resume), which is how a stray one is found.
  killSession: (container: string, sessionId: string) => ["exec", container, "pkill", "-f", sessionId],
  deleteSession: (container: string, sessionId: string) => ["exec", container, "sh", "-c", 'rm -f /home/clot/.claude/projects/*/"$1".jsonl', "sh", sessionId],
  sessionExists: (container: string, sessionId: string) => ["exec", container, "sh", "-c", 'ls /home/clot/.claude/projects/*/"$1".jsonl', "sh", sessionId],
  prsForBranch: (container: string, branch: string, repo: string) => ["exec", "-e", "GH_TOKEN", container, "gh", "pr", "list", "-R", repo, "--head", branch, "--state", "all", "--json", "number,url,state,isCrossRepository"],
};

async function docker(args: string[], env?: Record<string, string>): Promise<string> {
  try {
    const { stdout } = await run("docker", args, { timeout: EXEC_TIMEOUT_MS, ...(env ? { env: { ...process.env, ...env } } : {}) });
    return stdout;
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.trim();
    throw new Error(stderr || (error instanceof Error ? error.message : String(error)));
  }
}

/** Runs a git step in the container's chain. One that hits another git's lock is tried once more, two seconds later. */
function gitStep(container: string, args: string[], env?: Record<string, string>): Promise<string> {
  const attempt = () =>
    docker(args, env).catch(async (error: Error) => {
      if (!/index\.lock|cannot lock ref/.test(error.message)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 2000));
      return docker(args, env);
    });
  const next = (chains.get(container) ?? Promise.resolve()).then(attempt, attempt);
  chains.set(container, next.catch(() => undefined));
  return next;
}

/** The repository's default branch, as the clone knows it; main when it cannot be read. */
export async function defaultBranch(container: string): Promise<string> {
  const ref = await gitStep(container, workerExec.defaultBranch(container)).catch(() => "");
  return ref.trim().replace(/^origin\//, "") || "main";
}

/** Makes a worker's place and returns its path. With a base, a worktree on a new branch from it; without, an empty directory. */
export async function addWorktree(container: string, o: { workerId: string; branch: string | null; base: string | null; githubToken: string }): Promise<string> {
  const path = worktreePath(o.workerId, o.base === null);
  if (o.base === null || o.branch === null) await docker(workerExec.addDirectory(container, path));
  else await gitStep(container, workerExec.addWorktree(container, path, o.branch, o.base), { GH_TOKEN: o.githubToken });
  return path;
}

/** Removes a worker's place. The branch is kept. Succeeds when it is already gone. */
export async function removeWorktree(container: string, path: string): Promise<void> {
  if (path.startsWith("/workspace/workers/")) await docker(workerExec.removeDirectory(container, path));
  else await gitStep(container, workerExec.removeWorktree(container, path));
}

export async function worktreeExists(container: string, path: string): Promise<boolean> {
  return docker(workerExec.exists(container, path)).then(
    () => true,
    () => false,
  );
}

/** Brings the main session's clone to the default branch's latest commit. It is never a worker's branch, so detaching it is safe. */
export async function refreshMainCheckout(container: string, githubToken: string): Promise<void> {
  const base = await defaultBranch(container);
  await gitStep(container, workerExec.refreshMain(container, base), { GH_TOKEN: githubToken });
}

/** Stops every Claude Code process left in the container: a `docker exec` can outlive the daemon that started it. */
/** Stops a Clot's container. Its volumes stay, so a Clot of the same name later finds them again. */
export async function stopContainer(container: string): Promise<void> {
  await run("docker", ["stop", container]).catch(() => undefined);
}

export async function killStrayClaude(container: string): Promise<void> {
  // pkill exits 1 when there was nothing to stop.
  await docker(workerExec.killStray(container)).catch(() => undefined);
}

/** Stops the Claude Code process of one session, when a `docker exec` was cut off but its process went on. */
export async function killSession(container: string, sessionId: string): Promise<void> {
  // pkill exits 1 when there was nothing to stop.
  await docker(workerExec.killSession(container, sessionId)).catch(() => undefined);
}

/** Deletes a finished session's transcript: a one-off session leaves nothing behind. */
export async function deleteSession(container: string, sessionId: string): Promise<void> {
  await docker(workerExec.deleteSession(container, sessionId)).catch(() => undefined);
}

/** Whether Claude Code already holds a transcript for this session, without blocking the daemon. */
export async function sessionExistsAsync(container: string, sessionId: string): Promise<boolean> {
  return docker(workerExec.sessionExists(container, sessionId)).then(
    () => true,
    () => false,
  );
}

/** The pull requests GitHub has for a branch name, open or not. A fork's branch can share the name: isCrossRepository says so. */
export async function prsForBranch(container: string, o: { branch: string; repo: string; githubToken: string }): Promise<{ number: number; url: string; state: string; isCrossRepository: boolean }[]> {
  return JSON.parse(await docker(workerExec.prsForBranch(container, o.branch, o.repo), { GH_TOKEN: o.githubToken }));
}
