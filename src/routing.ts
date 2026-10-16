import type { AccountBase } from "./config.js";
import type { ClotEvent } from "./events/types.js";
import type { RoutingCall } from "./routing-call.js";
import { matchesPrefilter, type RoutingRule } from "./rulebook.js";

/** Where an account sends its events: to one Clot, or to be routed. */
export type Binding = { clot: string } | "shared";

/** Where an event went, and how that was decided. Without a Clot, `how` is why it went nowhere. */
export interface Route {
  clot?: string;
  how: string;
}

export interface RouterDeps {
  /** The binding of the event's account. Undefined for a GitHub repository no Clot is bound to. */
  bindingOf: (event: ClotEvent) => Binding | undefined;
  /** The routing rules in force. */
  rules: () => RoutingRule[];
  call: RoutingCall;
  /** The project Clots the call may pick, with a line on each. The home Clot is not among them: it is where an unsure call ends. */
  clots: () => { name: string; about: string }[];
  /** The global triage guidance. */
  guidance: () => string;
  /** The home Clot's name, when there is one. */
  home?: string;
}

/**
 * Picks the Clot for an event: the account's own Clot, else the first routing rule that
 * matches, else a confident routing call, else the home Clot. A GitHub repository no Clot is
 * bound to goes home at once, as in 2b.
 */
export class EventRouter {
  constructor(private d: RouterDeps) {}

  async route(event: ClotEvent): Promise<Route> {
    const binding = this.d.bindingOf(event);
    if (binding === undefined) return this.home("no Clot is bound to this repository", "no Clot is bound to this repository");
    if (binding !== "shared") return { clot: binding.clot, how: "bound" };

    const rule = this.d.rules().find((candidate) => matchesPrefilter(candidate, event));
    if (rule) return { clot: rule.clot, how: "routing rule" };

    const candidates = this.d.clots();
    if (candidates.length > 0) {
      const answer = await this.d.call.decide({ event, guidance: this.d.guidance(), clots: candidates }).catch(() => undefined);
      if (answer?.confident && answer.clot !== null && candidates.some((clot) => clot.name === answer.clot)) return { clot: answer.clot, how: "routing call" };
    }
    return this.home("home: no routing rule matched and the routing call was not sure", "no routing rule matched and the routing call was not sure, and there is no home Clot");
  }

  private home(how: string, nowhere: string): Route {
    return this.d.home === undefined ? { how: nowhere } : { clot: this.d.home, how };
  }
}

/**
 * The binding of an event's account: a GitHub repository by the Clot whose repoUrl names it, a
 * recipe by the file it is written in, any other source by its configured account. An account
 * that is not configured is treated as shared.
 */
export function bindingResolver(o: {
  repos: Map<string, string>;
  accounts: (AccountBase & { source: string })[];
  recipes?: (name: string) => Binding | undefined;
}): (event: ClotEvent) => Binding | undefined {
  return (event) => {
    if (event.source === "github") {
      const clot = o.repos.get(event.place);
      return clot === undefined ? undefined : { clot };
    }
    const account = o.accounts.find((candidate) => candidate.source === event.source && candidate.account === event.account);
    if (account) return account.clot === undefined ? "shared" : { clot: account.clot };
    return o.recipes?.(event.source) ?? "shared";
  };
}
