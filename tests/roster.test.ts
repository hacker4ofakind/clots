import { beforeEach, describe, expect, it } from "vitest";
import { Clot } from "../src/clot.js";
import { FakeChat } from "../src/chat/fake.js";
import type { AgentRunner, TurnHandle, TurnRequest, TurnResult } from "../src/agent/runner.js";
import { rosterBlock, rosterChangeNote, SessionRoster, type RosterEntry } from "../src/roster.js";
import { Store } from "../src/store.js";

const HOME: RosterEntry = { name: "home", about: "anything that belongs to no project" };
const GRAPHITE: RosterEntry = { name: "graphite", about: "the project in the repository octo/graphite" };
const WIDGETS: RosterEntry = { name: "widgets", about: "the widget shop" };

describe("rosterBlock", () => {
  it("lists every Clot but the one it is for, with what each looks after, and says an unlisted project has none", () => {
    const block = rosterBlock("graphite", [HOME, GRAPHITE, WIDGETS]);
    expect(block).toContain("- home: anything that belongs to no project");
    expect(block).toContain("- widgets: the widget shop");
    expect(block).not.toContain("- graphite:");
    expect(block).toContain("route_correct");
    expect(block).toContain("has no Clot");
  });

  it("says nothing for a Clot that is alone", () => {
    expect(rosterBlock("graphite", [GRAPHITE])).toBe("");
  });
});

describe("rosterChangeNote", () => {
  it("gives the whole list, and says when the Clot is now alone", () => {
    expect(rosterChangeNote("graphite", [HOME, GRAPHITE, WIDGETS])).toContain("- widgets: the widget shop");
    expect(rosterChangeNote("graphite", [GRAPHITE])).toContain("only Clot");
  });
});

describe("SessionRoster", () => {
  let store: Store;
  let roster: RosterEntry[];
  let tracker: SessionRoster;
  const fresh = { id: "s1", started: false };
  const running = { id: "s1", started: true };

  beforeEach(() => {
    store = new Store(":memory:");
    roster = [HOME, GRAPHITE];
    tracker = new SessionRoster({ store, name: "graphite", roster: () => roster });
  });

  it("writes the roster into a new session's prompt, and gives no note", () => {
    expect(tracker.prompt(fresh)).toBe(rosterBlock("graphite", roster));
    expect(tracker.note(fresh)).toBeUndefined();
  });

  it("keeps the prompt of the session as it began when a Clot is added later, and tells the Clot by a note until it has read it", () => {
    const first = tracker.prompt(fresh);
    roster = [HOME, GRAPHITE, WIDGETS];
    expect(tracker.prompt(running)).toBe(first);
    const note = tracker.note(running)!;
    expect(note.text).toContain("- widgets: the widget shop");
    // Not recorded until the turn has read it, so a turn that failed leaves it to be given again.
    expect(tracker.note(running)).toEqual(note);
    tracker.markTold(running, note.told);
    expect(tracker.note(running)).toBeUndefined();
    expect(tracker.prompt(running)).toBe(first);
  });

  it("gives the whole new list in a later note when the roster changes again", () => {
    tracker.prompt(fresh);
    roster = [HOME, GRAPHITE, WIDGETS];
    tracker.markTold(running, tracker.note(running)!.told);
    roster = [GRAPHITE];
    expect(tracker.note(running)!.text).toContain("only Clot");
  });

  it("treats a session that began before the roster existed as having been given none, and tells it by a note, however long ago its last turn was", () => {
    expect(tracker.prompt(running)).toBe("");
    expect(tracker.note(running)!.text).toContain("- home: anything that belongs to no project");
    tracker.markTold(running, tracker.note(running)!.told);
    expect(tracker.note(running)).toBeUndefined();
  });

  it("keeps each session's roster apart", () => {
    const one = tracker.prompt({ id: "a", started: false });
    roster = [HOME, GRAPHITE, WIDGETS];
    expect(tracker.prompt({ id: "b", started: false })).toBe(rosterBlock("graphite", roster));
    expect(tracker.prompt({ id: "a", started: true })).toBe(one);
  });
});

describe("Clot and the roster", () => {
  class Runner implements AgentRunner {
    calls: TurnRequest[] = [];
    startTurn(req: TurnRequest): TurnHandle {
      this.calls.push(req);
      const done = (async (): Promise<TurnResult> => {
        req.onText("ok");
        return { sessionId: req.resume ?? req.newSessionId ?? "", contextPercent: 10, ok: true };
      })();
      return { push: () => false, stop: () => undefined, done };
    }
  }

  let store: Store;
  let chat: FakeChat;
  let runner: Runner;
  let clot: Clot;
  let now: Date;
  let roster: RosterEntry[];

  beforeEach(async () => {
    store = new Store(":memory:");
    chat = new FakeChat();
    runner = new Runner();
    now = new Date("2026-10-10T12:00:00Z");
    roster = [HOME, GRAPHITE];
    let ids = 0;
    clot = new Clot({
      name: "graphite",
      store,
      chat,
      router: { decide: async () => ({ effort: "medium" }) },
      runner,
      timeZone: "UTC",
      userId: "user-1",
      rolloverPercent: 65,
      now: () => now,
      newId: () => `sess-${++ids}`,
      schedule: () => undefined,
      roster: () => roster,
    });
    await clot.init();
  });

  const say = (text: string) => clot.onMessage({ id: text, channelId: store.activeSession("graphite")!.channelId, authorId: "user-1", text, at: now });
  const main = (call: TurnRequest) => (call.role === "main" ? call : undefined)!;

  it("gives every turn of a session the same roster, and a Clot added meanwhile arrives as a note, once", async () => {
    await say("one");
    roster = [HOME, GRAPHITE, WIDGETS];
    now = new Date(now.getTime() + 60_000);
    await say("two");
    await say("three");

    const [one, two, three] = runner.calls;
    expect(main(one).roster).toBe(rosterBlock("graphite", [HOME, GRAPHITE]));
    expect(main(two).roster).toBe(main(one).roster);
    expect(main(three).roster).toBe(main(one).roster);
    expect(one.prompt).not.toContain("widgets");
    expect(two.prompt).toContain("- widgets: the widget shop");
    expect(three.prompt).not.toContain("widgets");
  });
});
