import { z } from "zod";

const FileSchema = z.object({
  timeZone: z.string().min(1),
  image: z.string().min(1),
  discord: z.object({ guildId: z.string().min(1), userId: z.string().min(1) }),
  clots: z
    .array(z.object({ name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/), repoUrl: z.string().url() }))
    .min(1),
});

export interface Config {
  timeZone: string;
  image: string;
  guildId: string;
  userId: string;
  clots: { name: string; repoUrl: string }[];
  discordToken: string;
  claudeToken: string;
  githubToken: string;
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
    clots: file.clots,
    discordToken: secret(env, "DISCORD_BOT_TOKEN"),
    claudeToken: secret(env, "CLAUDE_CODE_OAUTH_TOKEN"),
    githubToken: secret(env, "CLOT_GITHUB_TOKEN"),
    rolloverPercent: Number(env.CLOTS_ROLLOVER_PERCENT ?? "65"),
  };
}
