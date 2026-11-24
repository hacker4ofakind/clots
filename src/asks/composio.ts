import { labelOf } from "../clot-name.js";
import type { AskKind } from "../asks.js";
import type { ComposioActions } from "../composio/actions.js";
import type { Composio } from "../composio/component.js";
import type { Audience } from "../composio/rating.js";
import { blockedLine, json, minutes, waitedMinutes } from "./common.js";

export interface ComposioPayload {
  /** `<toolkit>:<account>` */
  account: string;
  audience: Audience;
  slug: string;
  toolName: string;
  description: string;
  /** Every argument, as the user is shown them: a yes runs exactly these. */
  args: Record<string, unknown>;
  /** Why it asks: the account's audience, the fixed list, or the reviewer's own words. */
  why: string;
  /** Asked for in a turn an outsider's text started. */
  outsider: boolean;
}

export const COMPOSIO_FILED =
  "Put to the user in your chat. Do not wait for the answer, and do not say it was done. Allowing it runs it exactly as shown; you will be told the outcome, and any text the user types in the chat comes to you as a message from them.";

/**
 * A write in a Composio account that the rating sent to the user: a public account, the fixed list, or a
 * reviewer that said ask. A yes runs the stored arguments exactly, through the same path as a direct write
 * (so it is logged and has its undo); a no declines it; any other reply goes to the main session as the
 * user's feedback and closes the ask. It is blocked at its deadline and never withdrawn, except that a yes first
 * checks the account is still configured, with the audience and toolkit it was shown.
 */
export function composioKind(d: { actions: Pick<ComposioActions, "executeWrite">; composio: Composio }): AskKind<ComposioPayload> {
  return {
    kind: "composio",
    answers: ["allow", "block"],
    view: (clot, p) => ({
      heading: `Allow ${labelOf(clot)} to run ${p.toolName}?`,
      shortHeading: `Allow ${p.toolName}?`,
      rows: [
        { label: "Account", value: `${p.account} (${p.audience})` },
        { label: "Tool", value: p.slug },
        ...(p.description ? [{ label: "What it does", value: p.description.replace(/\s+/g, " ").slice(0, 300) }] : []),
        { label: "Why it asks", value: p.why },
      ],
      body: json(p.args),
      labels: { allow: "Run", block: "Decline" },
      ...(p.outsider ? { warning: "From an outsider's report." } : {}),
    }),
    texts: {
      filed: COMPOSIO_FILED,
      already: "This write is already with the user, waiting for their answer.",
      full: (open) => `${open} writes are already with the user, waiting for their answers. Do not ask for more until they answer.`,
      notAsked: (reason) => `The user could not be asked just now${reason ? ` (${reason})` : ""}. Say in your reply what you wanted to do instead.`,
    },

    async onAnswer(ask, answer, io) {
      const p = ask.payload;
      if (answer.action === "block") {
        await io.close(`The user declined ${p.toolName} in ${p.account}; nothing was changed. Do not ask again unless the user asks.`, `Declined: ${p.toolName} in ${p.account}.`);
        return;
      }
      if (answer.action !== "allow" || !io.setBusy()) return;
      // What the user saw must still be what is there: the account may have been changed or removed since.
      const account = d.composio.account(p.account);
      const tool = account && (await d.composio.tool(p.slug).catch(() => undefined));
      if (!account || account.audience !== p.audience || !tool || tool.toolkit !== account.toolkit) {
        await io.close(`The ask to run ${p.toolName} in ${p.account} was withdrawn: the account changed since it was shown. Nothing was changed.`, `Withdrawn: ${p.account} changed since ${p.toolName} was asked about.`);
        return;
      }
      const done = await d.actions.executeWrite({ clot: ask.clot, account, tool, args: p.args, reviewed: false });
      if (done.ok) await io.close(`The user approved ${p.toolName} in ${p.account}, and it ran.\n${done.text}`, null);
      else await io.close(`The user approved ${p.toolName} in ${p.account}, but it did not run: ${done.text}`, done.text);
    },

    async onFeedback(ask, text, io) {
      const p = ask.payload;
      const message = `[The user's reply to your ask to run ${p.toolName} in ${p.account}. It was not run, and the ask is closed:]\n${text}`;
      await io.close(null, `Your reply about ${p.toolName} in ${p.account} was passed on; it was not run.`, { inbox: { id: `composio-feedback:${ask.id}`, text: message, kind: "message", outsider: p.outsider } }, "You answered in chat.");
    },

    async onDeadline(ask, io) {
      const p = ask.payload;
      await io.close(`The user did not answer your ask to run ${p.toolName} in ${p.account} within ${minutes(waitedMinutes(ask))}, so it was not run. Do not ask again unless the user asks.`, blockedLine(ask));
    },

    async interrupted(ask, io) {
      const p = ask.payload;
      await io.close(`The daemon stopped while ${p.toolName} in ${p.account} was being run, so whether it ran is not known. Check ${p.account.split(":")[0]} before asking again.`, `Whether ${p.toolName} in ${p.account} ran is not known; check the service.`);
    },
  };
}
