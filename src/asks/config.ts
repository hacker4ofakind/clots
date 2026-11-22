import type { AskKind } from "../asks.js";
import { configChannelName, restartChannelName } from "../chat/names.js";
import { matchYesNo } from "../events/reply.js";

export interface ConfigPayload {
  /** `sources.composio`, `mcpServers.elevenlabs`, ... */
  key: string;
  value: unknown;
  /** What the key holds now, shown beside the new value; undefined when it is not set. */
  current?: unknown;
}

const fenced = (value: unknown) => `\`\`\`json\n${(JSON.stringify(value, null, 2) ?? "not set").replaceAll("```", "'''")}\n\`\`\``;

export const CONFIG_FILED = "Put to the user in a separate channel. Do not wait for the answer, and do not say it was done. A yes saves it exactly as shown; you will be told the outcome, and any other reply comes to you as a message from the user.";

/**
 * A change to `clots.config.json` that is not one of the plain tunables: a Clot proposes one key's new value, the user
 * sees the old and the new, and a yes saves it exactly as shown. A change takes effect at the daemon's next restart.
 */
export function configKind(d: { apply(key: string, value: unknown): { ok: boolean; text: string } }): AskKind<ConfigPayload> {
  return {
    kind: "config",
    channelName: configChannelName,
    render: (_clot, p) =>
      [`asks to change \`${p.key}\` in clots.config.json.`, "Now:", fenced(p.current), "As it would be:", fenced(p.value), "yes saves it (it applies at the next restart); no declines it."].join("\n"),
    texts: {
      filed: CONFIG_FILED,
      already: "This change is already with the user, waiting for their answer.",
      full: (open) => `${open} configuration changes are already with the user, waiting for their answers. Do not ask for more until they answer.`,
      notAsked: (reason) => `The user could not be asked just now${reason ? ` (${reason})` : ""}.`,
    },
    async onReply(ask, text, io) {
      const p = ask.payload;
      const answer = matchYesNo(text);
      if (answer === "no") {
        await io.close(`The user declined the change to ${p.key}; nothing was changed. Do not ask again unless the user asks.`, `Declined: ${p.key} is unchanged.`);
        return;
      }
      if (answer === undefined) {
        await io.close(null, `Your reply about ${p.key} was passed on; nothing was changed.`, {
          inbox: { id: `config-feedback:${ask.id}`, text: `[The user's reply to your proposed change to ${p.key}. It was not made, and the ask is closed:]\n${text}`, kind: "message", outsider: false },
        });
        return;
      }
      if (!io.setBusy()) return;
      const done = d.apply(p.key, p.value);
      if (!done.ok) {
        await io.close(`The user approved the change to ${p.key}, but it was not saved. ${done.text}`, done.text);
        return;
      }
      // The Clot carries on: it tells the user what is left for them to do, and asks for the restart when that is done.
      await io.close(null, `Saved ${p.key}.`, {
        inbox: { id: `config-saved:${ask.id}`, text: `[The user approved your change to ${p.key}, and it was saved. ${done.text} Tell the user what is left for them to do. When they say it is done, ask for the restart with daemon_restart.]`, kind: "message", outsider: false },
      });
    },
    async interrupted(ask, io) {
      await io.close(`The daemon stopped while the change to ${ask.payload.key} was being saved. Read it with config_get to see whether it was.`, `Whether ${ask.payload.key} was saved is not known; the Clot will check.`);
    },
  };
}

export interface RestartPayload {
  reason: string;
}

/**
 * The daemon's restart, which only the user may allow. A yes does not restart at once: it waits until no Clot has a turn
 * running (and no worker), then restarts, so nothing is cut off. A restart nothing has waited for is never made.
 */
export function restartKind(d: {
  /** Waits until nothing runs, calls `beforeExit`, and restarts; false when turns kept running too long (nothing was done). */
  restartWhenIdle(beforeExit: () => Promise<unknown>): Promise<boolean>;
}): AskKind<RestartPayload> {
  return {
    kind: "restart",
    channelName: restartChannelName,
    render: (_clot, p) => [`asks to restart the daemon: ${p.reason}`, "yes waits until every Clot's turn has finished, then restarts it, which takes a few seconds; no declines."].join("\n"),
    texts: {
      filed: "Put to the user in a separate channel. Do not say it was restarted. The user's yes makes it wait for every turn to end, then restart.",
      already: "A restart is already with the user.",
      full: () => "A restart is already with the user.",
      notAsked: (reason) => `The user could not be asked just now${reason ? ` (${reason})` : ""}.`,
    },
    async onReply(ask, text, io) {
      const answer = matchYesNo(text);
      if (answer === "no") {
        await io.close("The user declined the restart. Do not ask again unless the user asks.", "Declined: the daemon keeps running.");
        return;
      }
      if (answer === undefined) {
        await io.repeat("Reply `yes` to restart once every turn has finished, or `no`.");
        return;
      }
      if (!io.setBusy()) return;
      await io.dropChannel();
      if (!(await d.restartWhenIdle(() => io.close(null, "Restarting the daemon now.")))) await io.close("The restart was approved, but turns kept running too long, so it was not made. Ask again later.", "Restart not made: turns kept running. Ask again when they are done.");
    },
    async interrupted(_ask, io) {
      await io.close(null, null);
    },
  };
}
