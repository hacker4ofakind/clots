import { z } from "zod";
import { repoSlug } from "./events/github.js";

const FileSchema = z.object({
  timeZone: z.string().min(1),
  image: z.string().min(1),
  discord: z.object({ guildId: z.string().min(1), userId: z.string().min(1) }),
  intake: z.object({ port: z.number().int().min(1).max(65535) }).default({ port: 8787 }),
  rulebookDir: z.string().min(1).default("rulebook"),
  hold: z.object({ quietSeconds: z.number().min(0), capSeconds: z.number().min(0) }).default({ quietSeconds: 60, capSeconds: 120 }),
  clots: z
    .array(
      z.object({
        name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
        // Events are routed by repository, so the URL must be one a repository can be read from.
        repoUrl: z.string().refine((url) => repoSlug(url) !== undefined, "repoUrl must look like https://github.com/owner/name.git"),
        testCommand: z.string().min(1).optional(),
      }),
    )
    .min(1),
});

export interface Config {
  timeZone: string;
  image: string;
  guildId: string;
  userId: string;
  /** The local port GitHub's webhooks arrive on, behind the tunnel. */
  intakePort: number;
  rulebookDir: string;
  /** How long automated events are held to be gathered: after the last one, and at most after the first. */
  hold: { quietMs: number; capMs: number };
  /** testCommand, when set, is the one command a locked turn may run besides the read-only list. */
  clots: { name: string; repoUrl: string; testCommand?: string }[];
  discordToken: string;
  claudeToken: string;
  githubToken: string;
  webhookSecret: string;
  rolloverPercent: number;
}

function secret(env: Record<string, string | undefined>, key: string): string {
  const value = env[key];
  if (!value) throw new Error(`${key} is not set in .env`);
  return value;
}

export function loadConfig(json: unknown, env: Record<string, string | undefined>): Config {
  const file = FileSchema.parse(json);
  return {
    timeZone: file.timeZone,
    image: file.image,
    guildId: file.discord.guildId,
    userId: file.discord.userId,
    intakePort: file.intake.port,
    rulebookDir: file.rulebookDir,
    hold: { quietMs: file.hold.quietSeconds * 1000, capMs: file.hold.capSeconds * 1000 },
    clots: file.clots,
    discordToken: secret(env, "DISCORD_BOT_TOKEN"),
    claudeToken: secret(env, "CLAUDE_CODE_OAUTH_TOKEN"),
    githubToken: secret(env, "CLOT_GITHUB_TOKEN"),
    webhookSecret: secret(env, "GITHUB_WEBHOOK_SECRET"),
    rolloverPercent: Number(env.CLOTS_ROLLOVER_PERCENT ?? "65"),
  };
}
