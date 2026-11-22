import type { Store } from "./store.js";

/** One Clot, as the others are told of it: its name and a line on what it looks after. */
export interface RosterEntry {
  name: string;
  about: string;
}

const lines = (own: string, roster: RosterEntry[]): string[] => roster.filter((c) => c.name !== own).map((c) => `- ${c.name}: ${c.about}`);

/**
 * What a Clot's system prompt says of the other Clots, or nothing when it is the only one. The Clots are the user's
 * agents side by side; naming them all is what keeps a Clot from offering a handover to one that does not exist.
 */
export function rosterBlock(own: string, roster: RosterEntry[]): string {
  const others = lines(own, roster);
  if (others.length === 0) return "";
  return `

The other Clots. You are one of several agents the user runs side by side: one for each project that has a repository, and a home Clot for what belongs to no project. These are all the others, with what each looks after:
${others.join("\n")}
- An event or request that belongs to one of them goes to it, with route_correct. A project that is not listed has no Clot: never offer to hand anything to one. Say that no Clot exists for it, and deal with the matter yourself or tell the user.`;
}

/** The note a Clot gets when the Clots changed after its session began, which its system prompt cannot show. */
export function rosterChangeNote(own: string, roster: RosterEntry[]): string {
  const others = lines(own, roster);
  return others.length === 0
    ? "The Clots have changed since your session began: you are now the only Clot. Nothing can be handed over with route_correct."
    : `The Clots are not as your instructions say, or your instructions do not list them. These are all the other Clots now, and they replace any list of Clots you have been given:\n${others.join("\n")}\nAn event or request that belongs to one of them goes to it, with route_correct. A project that is not listed has no Clot: never offer to hand anything to one.`;
}

export interface RosterDeps {
  store: Pick<Store, "getState" | "setState">;
  /** The Clot this keeps the roster for. */
  name: string;
  /** Every Clot the daemon runs now, this one included. */
  roster: () => RosterEntry[];
}

/**
 * Which roster of Clots a session knows of, and what it is yet to be told.
 *
 * A session's system prompt is fixed when the session is created: resuming it with a different prompt changes
 * nothing, as the session keeps the one it began with. So the roster goes into the prompt of a new session
 * only, which also keeps the prompt from ever changing under a warm cache. For every other session, and for a
 * session whose roster has changed since it began, the next turn gets a note with the whole current roster.
 * A session that began before this existed is recorded as having been given none.
 */
export class SessionRoster {
  constructor(private d: RosterDeps) {}

  private live(): string {
    return rosterBlock(this.d.name, this.d.roster());
  }

  /** What to append to the system prompt of a turn of this session: the roster the session began with, which only a session's first turn can set. */
  prompt(session: { id: string; started: boolean }): string {
    const key = `session-roster:${session.id}`;
    const kept = this.d.store.getState(key);
    if (kept !== undefined) return kept;
    const began = session.started ? "" : this.live();
    this.d.store.setState(key, began);
    return began;
  }

  /** A note for the session's next turn when the roster differs from the last one the Clot was given, with that roster to record once the turn has read it. */
  note(session: { id: string; started: boolean }): { text: string; told: string } | undefined {
    const began = this.prompt(session);
    const live = this.live();
    const told = this.d.store.getState(`session-roster-told:${session.id}`) ?? began;
    return live === told ? undefined : { text: rosterChangeNote(this.d.name, this.d.roster()), told: live };
  }

  /** Records that a turn read the note, so that it is not given again. */
  markTold(session: { id: string }, told: string): void {
    this.d.store.setState(`session-roster-told:${session.id}`, told);
  }
}
