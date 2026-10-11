import { ChannelType, Client, EmbedBuilder, Events, GatewayIntentBits, type Guild, type TextChannel } from "discord.js";
import type { TurnActivity } from "../types.js";
import { formatActivity } from "./activity-format.js";
import type { ChatAdapter, InboundMessage } from "./adapter.js";
import { splitMessage } from "./names.js";

/** Discord clears the indicator after about 10 seconds, or when the bot posts. */
const TYPING_REFRESH_MS = 8_000;

export class DiscordChat implements ChatAdapter {
  private client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  });
  private guild!: Guild;

  constructor(private token: string, private guildId: string) {}

  async start(onMessage: (m: InboundMessage) => void): Promise<void> {
    this.client.on(Events.MessageCreate, (m) => {
      if (m.author.bot || m.guildId !== this.guildId) return;
      onMessage({ id: m.id, channelId: m.channelId, authorId: m.author.id, text: m.content, at: m.createdAt });
    });
    await this.client.login(this.token);
    this.guild = await this.client.guilds.fetch(this.guildId);
  }

  async ensureCategory(name: string): Promise<string> {
    const all = await this.guild.channels.fetch();
    const found = all.find((c) => c?.type === ChannelType.GuildCategory && c.name.toLowerCase() === name.toLowerCase());
    if (found) return found.id;
    const created = await this.guild.channels.create({ name, type: ChannelType.GuildCategory });
    return created.id;
  }

  async listChannelNames(categoryId: string): Promise<string[]> {
    const all = await this.guild.channels.fetch();
    return [...all.values()].filter((c) => c?.parentId === categoryId).map((c) => c!.name);
  }

  async createChannel(categoryId: string, name: string): Promise<string> {
    const channel = await this.guild.channels.create({ name, type: ChannelType.GuildText, parent: categoryId });
    await channel.setPosition(0);
    return channel.id;
  }

  async post(channelId: string, text: string): Promise<void> {
    const channel = await this.textChannel(channelId);
    for (const part of splitMessage(text)) await channel.send(part);
  }

  async postActivity(channelId: string, activity: TurnActivity): Promise<void> {
    const channel = await this.textChannel(channelId);
    await channel.send({ embeds: [new EmbedBuilder().setColor(0x5865f2).setDescription(formatActivity(activity))] });
  }

  startTyping(channelId: string): () => void {
    const send = () => void this.textChannel(channelId).then((c) => c.sendTyping()).catch(() => undefined);
    send();
    const timer = setInterval(send, TYPING_REFRESH_MS);
    return () => clearInterval(timer);
  }

  async makeReadOnly(channelId: string): Promise<void> {
    const channel = await this.textChannel(channelId);
    // The bot is a member of @everyone, so it needs its own allowance or the denial silences it too.
    await channel.permissionOverwrites.edit(this.client.user!.id, { SendMessages: true });
    await channel.permissionOverwrites.edit(this.guild.roles.everyone, { SendMessages: false });
  }

  mention(userId: string): string {
    return `<@${userId}>`;
  }

  channelLink(channelId: string): string {
    return `<#${channelId}>`;
  }

  private async textChannel(id: string): Promise<TextChannel> {
    const channel = await this.guild.channels.fetch(id);
    if (!channel || channel.type !== ChannelType.GuildText) throw new Error(`Channel ${id} is not a text channel`);
    return channel;
  }
}
