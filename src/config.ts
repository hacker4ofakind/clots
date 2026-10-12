import { z } from "zod";
import { repoSlug } from "./events/github.js";

/** The name of the Clot for what belongs to no project. */
export const HOME_CLOT = "home";

/** Names a project Clot cannot have: the home Clot's, and the one the rulebook uses for the file every Clot shares. */
const RESERVED_NAMES = [HOME_CLOT, "global"];

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
        name: z
          .string()
          .regex(/^[a-z0-9][a-z0-9-]*$/)
          .refine((name) => !RESERVED_NAMES.includes(name), "the names home and global are the daemon's own"),
        // Events are routed by repository, so the URL must be one a repository can be read from.
        repoUrl: z.string().refine((url) => repoSlug(url) !== undefined, "repoUrl must look like https://github.com/owner/name.git"),
        testCommand: z.string().min(1).optional(),
      }),
    )
    .min(1),
  // A Clot with no repository of its own, for events from repositories no Clot is bound to.
  home: z.boolean().default(false),
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
  /** Whether the home Clot runs. */
  home: boolean;
  /** How many rule proposals a Clot may have waiting for the user at once. */
  maxProposals: number;
}

function secret(env: Record<string, string | undefined>, key: string): string {
  const value = env[key];
  if (!value) throw new Error(`${key} is not set in .env`);
  return value;
}

export function loadConfig(json: unknown, env: Record<string, string | undefined>): Config {
  const file = FileSchema.parse(json);
  const maxProposals = Number(env.CLOTS_MAX_PROPOSALS || "3");
  if (!Number.isInteger(maxProposals) || maxProposals < 1) throw new Error("CLOTS_MAX_PROPOSALS must be a whole number of at least 1");
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
    home: file.home,
    maxProposals,
  };
}
