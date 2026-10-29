import { beforeEach, describe, expect, it } from "vitest";
import type { FolderChange, FolderState, MemoryFolders } from "../src/agent/memory-folder.js";
import { Asks } from "../src/asks.js";
import { memoryKind } from "../src/asks/memory.js";
import type { InboundMessage } from "../src/chat/adapter.js";
import { FakeChat } from "../src/chat/fake.js";
import { GlobalMemory } from "../src/global-memory.js";
import { BLOCK_END, BLOCK_START } from "../src/memory-index.js";
import { Store } from "../src/store.js";

const USER = "user-1";
const DEPLOY = "global-clot-deploy-days.md";
const PET = "global-clot-pet.md";
const deployV1 = "---\nname: Deploy days\ndescription: when the user deploys\ntype: user\n---\n\nFridays only.\n";
const deployV2 = "---\nname: Deploy days\ndescription: when the user deploys\ntype: user\n---\n\nFridays and Mondays.\n";
const pet = "---\nname: Pet\ndescription: the user's pet\ntype: user\n---\n\nA ferret named Bolt.\n";
const deployLine = "- [Deploy days](global-clot-deploy-days.md) — when the user deploys";

class FakeFolders implements MemoryFolders {
  folders = new Map<string, FolderState>();
  failRead = new Set<string>();
  failWrite = new Set<string>();
  writes: { clot: string; change: FolderChange }[] = [];

  async read(clot: string): Promise<FolderState | undefined> {
    if (this.failRead.has(clot)) throw new Error("docker is not running");
    const folder = this.folders.get(clot);
    return folder && { files: new Map(folder.files), index: folder.index };
  }

  async write(clot: string, change: FolderChange): Promise<void> {
    if (this.failWrite.has(clot)) throw new Error("docker is not running");
    this.writes.push({ clot, change });
    const folder = this.folders.get(clot) ?? { files: new Map(), index: null };
    for (const [file, text] of Object.entries(change.put)) folder.files.set(file, text);
    for (const file of change.remove) folder.files.delete(file);
    if (change.index !== undefined) folder.index = change.index;
    this.folders.set(clot, folder);
  }

  /** What a Clot itself writes in its own folder. */
  put(clot: string, file: string, text: string): void {
    const folder = this.folders.get(clot) ?? { files: new Map(), index: null };
    folder.files.set(file, text);
    this.folders.set(clot, folder);
  }

  remove(clot: string, file: string): void {
    this.folders.get(clot)?.files.delete(file);
  }

  file(clot: string, file: string): string | undefined {
    return this.folders.get(clot)?.files.get(file);
  }

  index(clot: string): string | null | undefined {
    return this.folders.get(clot)?.index;
  }
}

let store: Store;
let chat: FakeChat;
let folders: FakeFolders;
let said: { clot: string; text: string }[];
let busy: Set<string>;
let memory: GlobalMemory;
let asks: Asks;
let n: number;

function build(): void {
  const say = async (clot: string, text: string) => void said.push({ clot, text });
  const kind = memoryKind({ resolve: (payload, answer) => memory.resolve(payload, answer), restore: (payload) => memory.restore(payload) });
  asks = new Asks({ store, chat, userId: USER, now: () => 0, kick: () => undefined, say, after: () => () => undefined, kinds: [kind] });
  memory = new GlobalMemory({
    store,
    folders,
    home: "home",
    clots: ["home", "graphite", "widgets"],
    say,
    isBusy: (clot) => busy.has(clot),
    asks: { open: (payload) => asks.open(kind, "home", payload, { summary: `Global memory ${payload.file}`, dedupe: `${payload.file}:${payload.text}`, max: 3 }), withdraw: (id, reason) => asks.withdraw(id, reason) },
  });
}

function reply(channelId: string, text: string, authorId = USER): InboundMessage {
  n += 1;
  return { id: `r${n}`, channelId, authorId, text, at: new Date(0) };
}

const questions = () => store.openAsks("home").filter((ask) => ask.kind === "memory");
const notes = (clot: string) => store.notes(clot).map((note) => note.text);

/** The home Clot writes a memory, and its turn, one the user's message started, ends. */
async function write(file: string, text: string): Promise<void> {
  folders.put("home", file, text);
  await memory.afterHomeTurn({ outsider: false });
}

beforeEach(async () => {
  store = new Store(":memory:");
  chat = new FakeChat();
  folders = new FakeFolders();
  said = [];
  busy = new Set();
  n = 0;
  const category = await chat.ensureCategory("home");
  store.upsertClot("home", category);
  store.createSession({ id: "s1", clot: "home", channelId: await chat.createChannel(category, "home-1410"), seed: null });
  folders.folders.set("home", { files: new Map(), index: null });
  build();
});

describe("a new or changed global memory", () => {
  it("is in force at once, reaches every Clot at its next turn with a note, and opens no channel", async () => {
    await write(DEPLOY, deployV1);

    expect([...store.approvedMemories()]).toEqual([[DEPLOY, deployV1]]);
    expect(questions()).toEqual([]);
    expect(chat.channels.map((c) => c.name)).toEqual(["home-1410"]);
    expect(said).toEqual([{ clot: "home", text: "Global memory added for every Clot: Deploy days (`global-clot-deploy-days.md`). `&memory undo` takes it back." }]);
    for (const clot of ["graphite", "widgets"]) expect(notes(clot)).toEqual(["A global memory was added: Deploy days (global-clot-deploy-days.md). It is listed in your MEMORY.md."]);

    await memory.beforeTurn("graphite");
    expect(folders.file("graphite", DEPLOY)).toBe(deployV1);
    expect(folders.index("graphite")).toBe(`${BLOCK_START}\n${deployLine}\n${BLOCK_END}\n`);
    expect(folders.file("widgets", DEPLOY)).toBeUndefined();

    await memory.afterHomeTurn();
    expect(said).toHaveLength(1);
  });

  it("says a change is a change", async () => {
    await write(DEPLOY, deployV1);
    await write(DEPLOY, deployV2);
    expect(store.approvedMemories().get(DEPLOY)).toBe(deployV2);
    expect(said.at(-1)!.text).toBe("Global memory changed for every Clot: Deploy days (`global-clot-deploy-days.md`). `&memory undo` takes it back.");
    expect(notes("graphite").at(-1)).toBe("The global memory Deploy days (global-clot-deploy-days.md) was changed. Read it again before relying on it.");
  });
});

describe("a global memory written in a turn an outsider's text started", () => {
  async function tainted(file: string, text: string): Promise<void> {
    folders.put("home", file, text);
    await memory.afterHomeTurn({ outsider: true });
  }

  it("is asked about in a home-memory channel with its full text, and spreads nowhere yet", async () => {
    await tainted(DEPLOY, deployV1);

    expect(questions()).toMatchObject([{ channelName: "home-memory", payload: { file: DEPLOY, text: deployV1 } }]);
    const posted = chat.postsIn(questions()[0].channelId)[0];
    expect(posted).toContain("<@user-1> home wrote a new global memory, `global-clot-deploy-days.md`, in a turn an outsider's text started:");
    expect(posted).toContain("```md\n" + deployV1 + "\n```");
    expect(posted).toContain("`yes`, `sure`, `do that` or `yeah` to give it to every Clot");
    expect(store.approvedMemories().size).toBe(0);
    expect(notes("graphite")).toEqual([]);

    // A later turn of the user's own does not put it in force behind the question.
    await memory.afterHomeTurn({ outsider: false });
    expect(questions()).toHaveLength(1);
    expect(store.approvedMemories().size).toBe(0);
  });

  it("on a yes, is in force as an untainted change would be", async () => {
    await tainted(DEPLOY, deployV1);
    const channel = questions()[0].channelId;
    await asks.onReply(reply(channel, "yes"));
    expect([...store.approvedMemories()]).toEqual([[DEPLOY, deployV1]]);
    expect(questions()).toEqual([]);
    expect(chat.deleted).toContain(channel);
    expect(said.at(-1)!.text).toBe("Approved. Global memory added for every Clot: Deploy days (`global-clot-deploy-days.md`).");
    expect(notes("home")).toEqual(["The user approved the global memory Deploy days (global-clot-deploy-days.md). It is now in every Clot's memory."]);
    expect(notes("graphite")).toEqual(["A global memory was added: Deploy days (global-clot-deploy-days.md). It is listed in your MEMORY.md."]);
  });

  it("on a no, puts the home Clot's copy back and tells it not to write it again", async () => {
    await tainted(DEPLOY, deployV1);
    await asks.onReply(reply(questions()[0].channelId, "no"));
    expect(folders.file("home", DEPLOY)).toBeUndefined();
    expect(store.approvedMemories().size).toBe(0);
    expect(said.at(-1)!.text).toBe("Declined: global memory Deploy days (`global-clot-deploy-days.md`).");
    expect(notes("home")[0]).toBe("The user declined the global memory you wrote, Deploy days (global-clot-deploy-days.md). Your copy was removed. Do not write it again unless the user asks.");

    await write(DEPLOY, deployV1);
    await tainted(DEPLOY, deployV2);
    await asks.onReply(reply(questions()[0].channelId, "dont"));
    expect(folders.file("home", DEPLOY)).toBe(deployV1);
    expect(notes("home").at(-1)).toContain("Your copy was put back to the text in force.");
  });

  it("is withdrawn when the home Clot removes the file or puts it back", async () => {
    await tainted(DEPLOY, deployV1);
    const channel = questions()[0].channelId;
    folders.remove("home", DEPLOY);
    await memory.afterHomeTurn();
    expect(questions()).toEqual([]);
    expect(chat.deleted).toContain(channel);
    expect(store.approvedMemories().size).toBe(0);
  });

  it("is asked about again with the newest text when the home Clot changes it before the answer", async () => {
    await tainted(DEPLOY, deployV1);
    const first = questions()[0].channelId;
    folders.put("home", DEPLOY, deployV2);
    await memory.afterHomeTurn({ outsider: false });
    expect(chat.deleted).toContain(first);
    expect(questions()).toMatchObject([{ payload: { text: deployV2 } }]);
  });

  it("ignores anyone but the user, and repeats the question on any other reply", async () => {
    await tainted(DEPLOY, deployV1);
    const channel = questions()[0].channelId;
    expect(await asks.onReply(reply(channel, "yes", "someone-else"))).toBe(true);
    await asks.onReply(reply(channel, "after"));
    expect(chat.postsIn(channel).at(-1)).toContain("I couldn't match that reply.");
    expect(questions()).toHaveLength(1);
  });

  it("is not applied by a later check when a stop caught the answer half-way: the copy is put back", async () => {
    await tainted(DEPLOY, deployV1);
    store.moveAsk(questions()[0].id, "open", "busy");
    await asks.sweep(true);
    expect(questions()).toEqual([]);
    await memory.afterHomeTurn({ outsider: false });
    expect(store.approvedMemories().size).toBe(0);
    expect(folders.file("home", DEPLOY)).toBeUndefined();
    expect(notes("home").at(-1)).toContain("It is not in force, and your copy was put back.");
  });

  it("is not applied by a later check when its channel was removed: the copy is put back", async () => {
    await tainted(DEPLOY, deployV1);
    await chat.deleteChannel(questions()[0].channelId);
    await asks.sweep(false);
    await memory.afterHomeTurn({ outsider: false });
    expect(store.approvedMemories().size).toBe(0);
    expect(folders.file("home", DEPLOY)).toBeUndefined();
  });

  it("is still a deletion applied at once", async () => {
    await write(DEPLOY, deployV1);
    folders.remove("home", DEPLOY);
    await memory.afterHomeTurn({ outsider: true });
    expect(store.approvedMemories().size).toBe(0);
    expect(questions()).toEqual([]);
  });
});

describe("a deletion", () => {
  it("is applied at once, everywhere, with notes and a line in the home channel", async () => {
    await write(DEPLOY, deployV1);
    await memory.beforeTurn("graphite");
    folders.remove("home", DEPLOY);
    await memory.afterHomeTurn();

    expect(store.approvedMemories().size).toBe(0);
    expect(said.at(-1)!.text).toBe("Global memory removed from every Clot: Deploy days (`global-clot-deploy-days.md`). `&memory undo` brings it back.");
    expect(notes("graphite").at(-1)).toBe("The global memory Deploy days (global-clot-deploy-days.md) was removed. Stop acting on it.");

    await memory.beforeTurn("graphite");
    expect(folders.file("graphite", DEPLOY)).toBeUndefined();
    expect(folders.index("graphite")).toBe("");
  });

  it("is not taken from a missing folder: the files in force are written back into it", async () => {
    await write(DEPLOY, deployV1);
    folders.folders.delete("home");
    await memory.afterHomeTurn();

    expect(store.approvedMemories().get(DEPLOY)).toBe(deployV1);
    expect(folders.file("home", DEPLOY)).toBe(deployV1);
    expect(folders.index("home")).toContain(deployLine);
  });
});

describe("syncing before a turn", () => {
  it("removes a global memory a project Clot wrote itself, and restores an edited block, keeping the Clot's own lines", async () => {
    await write(DEPLOY, deployV1);
    folders.folders.set("graphite", {
      files: new Map([
        [PET, pet],
        [DEPLOY, "tampered"],
      ]),
      index: `- [Own](own.md) — mine\n${BLOCK_START}\n- [Tampered](x.md)\n${BLOCK_END}\n`,
    });
    await memory.beforeTurn("graphite");

    expect(folders.file("graphite", PET)).toBeUndefined();
    expect(folders.file("graphite", DEPLOY)).toBe(deployV1);
    expect(folders.index("graphite")).toBe(`${BLOCK_START}\n${deployLine}\n${BLOCK_END}\n- [Own](own.md) — mine\n`);
  });

  it("writes nothing when the folder is already up to date", async () => {
    await write(DEPLOY, deployV1);
    await memory.beforeTurn("graphite");
    const writes = folders.writes.length;
    await memory.beforeTurn("graphite");
    expect(folders.writes).toHaveLength(writes);
  });

  it("leaves the home Clot's own changes alone and only keeps its block", async () => {
    await write(DEPLOY, deployV1);
    folders.put("home", DEPLOY, deployV2);
    folders.put("home", PET, pet);
    await memory.beforeTurn("home");
    expect(folders.file("home", DEPLOY)).toBe(deployV2);
    expect(folders.file("home", PET)).toBe(pet);
    expect(folders.index("home")).toBe(`${BLOCK_START}\n${deployLine}\n${BLOCK_END}\n`);
  });

  it("never throws: a failed sync is tried again before the next turn", async () => {
    await write(DEPLOY, deployV1);
    folders.failRead.add("graphite");
    await expect(memory.beforeTurn("graphite")).resolves.toBeUndefined();
    folders.failRead.delete("graphite");
    await memory.beforeTurn("graphite");
    expect(folders.file("graphite", DEPLOY)).toBe(deployV1);

    folders.failRead.add("home");
    await expect(memory.afterHomeTurn()).resolves.toBeUndefined();
  });
});

describe("&memory undo", () => {
  it("steps back through additions, changes and deletions, putting the home Clot's copy back to match", async () => {
    await write(DEPLOY, deployV1);
    await write(DEPLOY, deployV2);
    folders.remove("home", DEPLOY);
    await memory.afterHomeTurn();

    expect(await memory.undo()).toBe("Undid the removal of global memory Deploy days (`global-clot-deploy-days.md`).");
    expect(store.approvedMemories().get(DEPLOY)).toBe(deployV2);
    expect(folders.file("home", DEPLOY)).toBe(deployV2);
    expect(notes("graphite").at(-1)).toBe("A global memory was added: Deploy days (global-clot-deploy-days.md). It is listed in your MEMORY.md.");
    expect(notes("home").at(-1)).toBe("The user undid the removal of global memory Deploy days (`global-clot-deploy-days.md`). Your copy was put back to match. Do not write it again unless the user asks.");

    expect(await memory.undo()).toBe("Undid the change to global memory Deploy days (`global-clot-deploy-days.md`).");
    expect(folders.file("home", DEPLOY)).toBe(deployV1);
    expect(await memory.undo()).toBe("Undid the addition of global memory Deploy days (`global-clot-deploy-days.md`).");
    expect(folders.file("home", DEPLOY)).toBeUndefined();
    expect(store.approvedMemories().size).toBe(0);
    expect(await memory.undo()).toBe("There is no global memory change left to undo.");

    // The copies put back are not taken for new changes.
    await memory.afterHomeTurn();
    expect(store.approvedMemories().size).toBe(0);
    await memory.beforeTurn("graphite");
    expect(folders.file("graphite", DEPLOY)).toBeUndefined();
  });

  it("is refused while the file has an open question, and changes nothing", async () => {
    await write(DEPLOY, deployV1);
    folders.put("home", DEPLOY, deployV2);
    await memory.afterHomeTurn({ outsider: true });
    expect(await memory.undo()).toBe("`global-clot-deploy-days.md` has a question waiting for your answer. Answer it first, then undo.");
    expect(store.approvedMemories().get(DEPLOY)).toBe(deployV1);
    expect(folders.file("home", DEPLOY)).toBe(deployV2);
  });

  it("puts the home Clot's copy back only after a running turn", async () => {
    await write(DEPLOY, deployV1);
    busy.add("home");
    await memory.undo();
    expect(folders.file("home", DEPLOY)).toBe(deployV1);
    busy.delete("home");
    await memory.afterHomeTurn();
    expect(folders.file("home", DEPLOY)).toBeUndefined();
    expect(store.approvedMemories().size).toBe(0);
  });
});

describe("&memory", () => {
  it("lists only what is in force", async () => {
    expect(memory.list()).toBe("No global memories are in force.");
    await write(DEPLOY, deployV1);
    folders.put("home", "global-clot-x.md", "No front matter.");
    await memory.afterHomeTurn({ outsider: true });
    expect(memory.list()).toBe(["Global memories in force:", "- Deploy days (`global-clot-deploy-days.md`): when the user deploys"].join("\n"));
  });
});
