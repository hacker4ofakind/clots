import { labelOf } from "../clot-name.js";
import type { AskKind } from "../asks.js";
import { blockedLine, json, minutes, waitedMinutes } from "./common.js";

export interface ConfigPayload {
  /** `sources.composio`, `mcpServers.elevenlabs`, ... */
  key: string;
  value: unknown;
  /** What the key holds now, shown beside the new value; undefined when it is not set. */
  current?: unknown;
}

export const CONFIG_FILED = "Put to the user in your chat. Do not wait for the answer, and do not say it was done. Allowing it saves and applies it exactly as shown; you will be told the outcome, and any text the user types in the chat comes to you as a message from them.";

/**
 * A change to `clots.config.json` that is not one of the plain tunables: a Clot proposes one key's new value, the user
 * sees the old and the new, and a yes saves it exactly as shown and applies it at once, with no restart, except for the few settings the daemon reads only when it starts.
 */
export function configKind(d: { apply(key: string, value: unknown): { ok: boolean; text: string } | Promise<{ ok: boolean; text: string }> }): AskKind<ConfigPayload> {
  return {
    kind: "config",
    answers: ["allow", "block"],
    view: (clot, p) => ({
      heading: `Allow ${labelOf(clot)} to change a setting?`,
      shortHeading: "Allow a setting change?",
      rows: [{ label: "Setting", value: p.key }, { label: "File", value: "clots.config.json" }],
      ...(p.current === undefined ? {} : { previous: json(p.current) }),
      body: json(p.value),
      labels: { allow: "Save", block: "Decline" },
    }),
    texts: {
      filed: CONFIG_FILED,
      already: "This change is already with the user, waiting for their answer.",
      full: (open) => `${open} configuration changes are already with the user, waiting for their answers. Do not ask for more until they answer.`,
      notAsked: (reason) => `The user could not be asked just now${reason ? ` (${reason})` : ""}.`,
    },
    async onAnswer(ask, answer, io) {
      const p = ask.payload;
      if (answer.action === "block") {
        await io.close("declined", `The user declined the change to ${p.key}; nothing was changed. Do not ask again unless the user asks.`, `Declined: ${p.key} is unchanged.`);
        return;
      }
      if (answer.action !== "allow") return;
      if (!io.setBusy()) return;
      const done = await d.apply(p.key, p.value);
      if (!done.ok) {
        await io.close("failed", `The user approved the change to ${p.key}, but it was not saved. ${done.text}`, done.text);
        return;
      }
      // The Clot carries on: it tells the user what is left for them to do, if anything.
      await io.close("approved", null, `Saved ${p.key}.`, {
        inbox: { id: `config-saved:${ask.id}`, text: `[The user approved your change to ${p.key}, and it was saved. ${done.text} Tell the user what is left for them to do, if anything.]`, kind: "message", outsider: false },
      });
    },

    async onFeedback(ask, text, io) {
      const p = ask.payload;
      await io.close("feedback", null, `Your reply about ${p.key} was passed on; nothing was changed.`, {
        inbox: { id: `config-feedback:${ask.id}`, text: `[The user's reply to your proposed change to ${p.key}. It was not made, and the ask is closed:]\n${text}`, kind: "message", outsider: false },
      }, "You answered in chat.");
    },

    async onDeadline(ask, io) {
      await io.close("timed_out", `The user did not answer your change to ${ask.payload.key} within ${minutes(waitedMinutes(ask))}, so nothing was changed. Do not ask again unless the user asks.`, blockedLine(ask));
    },
    async interrupted(ask, io) {
      await io.close("failed", `The daemon stopped while the change to ${ask.payload.key} was being saved. Read it with config_get to see whether it was.`, `Whether ${ask.payload.key} was saved is not known; the Clot will check.`);
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
    answers: ["allow", "block"],
    view: (clot, p) => ({
      heading: `Allow ${labelOf(clot)} to restart Clots?`,
      shortHeading: "Allow a restart?",
      rows: [{ label: "Why", value: p.reason }],
      labels: { allow: "Restart", block: "Decline" },
      warning: "It waits until every turn has finished, then takes a few seconds.",
    }),
    texts: {
      filed: "Put to the user in your chat. Do not say it was restarted. Allowing it makes it wait for every turn to end, then restart.",
      already: "A restart is already with the user.",
      full: () => "A restart is already with the user.",
      notAsked: (reason) => `The user could not be asked just now${reason ? ` (${reason})` : ""}.`,
    },
    async onAnswer(ask, answer, io) {
      if (answer.action === "block") {
        await io.close("declined", "The user declined the restart. Do not ask again unless the user asks.", "Declined: the daemon keeps running.");
        return;
      }
      if (answer.action !== "allow" || !io.setBusy()) return;
      // Waiting for the turns to end can take a long while: the answer does not wait for it.
      void d.restartWhenIdle(() => io.close("approved", "The user approved the restart, and the daemon is restarting now.", "Restarting the daemon now.")).then(async (restarted) => {
        if (!restarted) await io.close("failed", "The restart was approved, but turns kept running too long, so it was not made. Ask again later.", "Restart not made: turns kept running. Ask again when they are done.");
      });
    },

    async onDeadline(ask, io) {
      await io.close("timed_out", `The user did not answer your restart within ${minutes(waitedMinutes(ask))}, so the daemon was not restarted.`, blockedLine(ask));
    },

    async interrupted(_ask, io) {
      await io.close("failed", null, null);
    },
  };
}
