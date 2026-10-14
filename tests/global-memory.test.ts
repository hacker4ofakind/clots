import { beforeEach, describe, expect, it } from "vitest";
import type { FolderChange, FolderState, MemoryFolders } from "../src/agent/memory-folder.js";
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
let n: number;

function build(max = 3): GlobalMemory {
  return new GlobalMemory({
    store,
    chat,
    folders,
    home: "home",
    clots: ["home", "graphite", "widgets"],
    userId: USER,
    max,
    say: async (clot, text) => void said.push({ clot, text }),
    isBusy: (clot) => busy.has(clot),
  });
}

function reply(channelId: string, text: string, authorId = USER): InboundMessage {
  n += 1;
  return { id: `r${n}`, channelId, authorId, text, at: new Date(0) };
}

const questions = () => store.memoryQuestions();
const notes = (clot: string) => store.notes(clot).map((note) => note.text);

/** The home Clot writes a memory, its turn ends, and the user answers. */
async function approve(file: string, text: string): Promise<void> {
  folders.put("home", file, text);
  await memory.afterHomeTurn();
  const question = questions().find((q) => q.file === file)!;
  await memory.onReply(reply(question.channelId, "yes"));
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
  memory = build();
});

describe("a new or changed global memory", () => {
  it("is asked about in a home-memory channel with its full text, and spreads nowhere yet", async () => {
    folders.put("home", DEPLOY, deployV1);
    await memory.afterHomeTurn();

    expect(questions()).toEqual([{ file: DEPLOY, text: deployV1, channelId: questions()[0].channelId, channelName: "home-memory" }]);
    const posted = chat.postsIn(questions()[0].channelId)[0];
    expect(posted).toContain("<@user-1> The home Clot wrote a new global memory, `global-clot-deploy-days.md`:");
    expect(posted).toContain("```md\n" + deployV1 + "\n```");
    expect(posted).toContain("`yes`, `sure`, `do that` or `yeah` to give it to every Clot");
    expect(store.approvedMemories().size).toBe(0);
    expect(notes("graphite")).toEqual([]);

    await memory.afterHomeTurn();
    expect(questions()).toHaveLength(1);
  });

  it("on a yes, is in force, reaches every Clot at its next turn with a note, and the channel goes", async () => {
    await approve(DEPLOY, deployV1);

    expect([...store.approvedMemories()]).toEqual([[DEPLOY, deployV1]]);
    expect(questions()).toEqual([]);
    expect(chat.deleted).toHaveLength(1);
    expect(said).toEqual([{ clot: "home", text: "Approved. Global memory Deploy days (`global-clot-deploy-days.md`) is in force for every Clot." }]);
    expect(notes("home")).toEqual(["The user approved the global memory Deploy days (global-clot-deploy-days.md). It is now in every Clot's memory."]);
    for (const clot of ["graphite", "widgets"]) expect(notes(clot)).toEqual(["A global memory was added: Deploy days (global-clot-deploy-days.md). It is listed in your MEMORY.md."]);

    await memory.beforeTurn("graphite");
    expect(folders.file("graphite", DEPLOY)).toBe(deployV1);
    expect(folders.index("graphite")).toBe(`${BLOCK_START}\n${deployLine}\n${BLOCK_END}\n`);
    expect(folders.file("widgets", DEPLOY)).toBeUndefined();
  });

  it("shows a change as the approved text and the new one", async () => {
    await approve(DEPLOY, deployV1);
    folders.put("home", DEPLOY, deployV2);
    await memory.afterHomeTurn();
    const posted = chat.postsIn(questions()[0].channelId)[0];
    expect(posted).toContain("changed the global memory `global-clot-deploy-days.md`. As it is now:");
    expect(posted.indexOf("Fridays only.")).toBeLessThan(posted.indexOf("Fridays and Mondays."));
  });

  it("breaks up a code fence in the text, so the question shows it as it is", async () => {
    folders.put("home", PET, "Run:\n```\nls\n```\n");
    await memory.afterHomeTurn();
    expect(chat.postsIn(questions()[0].channelId)[0]).toContain("Run:\n`​``\nls\n`​``\n");
  });

  it("on a no, puts the home Clot's copy back and tells it not to write it again", async () => {
    folders.put("home", DEPLOY, deployV1);
    await memory.afterHomeTurn();
    await memory.onReply(reply(questions()[0].channelId, "no"));

    expect(folders.file("home", DEPLOY)).toBeUndefined();
    expect(store.approvedMemories().size).toBe(0);
    expect(said).toEqual([{ clot: "home", text: "Declined: global memory Deploy days (`global-clot-deploy-days.md`)." }]);
    expect(notes("home")[0]).toBe("The user declined the global memory you wrote, Deploy days (global-clot-deploy-days.md). Your copy was removed. Do not write it again unless the user asks.");
    expect(notes("graphite")).toEqual([]);

    await approve(DEPLOY, deployV1);
    folders.put("home", DEPLOY, deployV2);
    await memory.afterHomeTurn();
    await memory.onReply(reply(questions()[0].channelId, "dont"));
    expect(folders.file("home", DEPLOY)).toBe(deployV1);
    expect(notes("home").at(-1)).toContain("Your copy was put back to the approved text.");
  });

  it("on a no during a home Clot turn, puts the copy back after that turn, and does not ask again", async () => {
    folders.put("home", DEPLOY, deployV1);
    await memory.afterHomeTurn();
    busy.add("home");
    await memory.onReply(reply(questions()[0].channelId, "no"));
    expect(folders.file("home", DEPLOY)).toBe(deployV1);

    busy.delete("home");
    await memory.afterHomeTurn();
    expect(folders.file("home", DEPLOY)).toBeUndefined();
    expect(questions()).toEqual([]);
  });

  it("asks about the newest text when the home Clot changes the file again before the answer", async () => {
    folders.put("home", DEPLOY, deployV1);
    await memory.afterHomeTurn();
    const channel = questions()[0].channelId;
    folders.put("home", DEPLOY, deployV2);
    await memory.afterHomeTurn();

    expect(questions()).toEqual([expect.objectContaining({ text: deployV2, channelId: channel })]);
    expect(chat.postsIn(channel).at(-1)).toContain("changed `global-clot-deploy-days.md` again. Your answer now applies to this text:");
    await memory.onReply(reply(channel, "yes"));
    expect(store.approvedMemories().get(DEPLOY)).toBe(deployV2);
  });

  it("keeps the question on the text the user saw when the newer text cannot be posted, and posts it at the next check", async () => {
    folders.put("home", DEPLOY, deployV1);
    await memory.afterHomeTurn();
    const channel = questions()[0].channelId;
    folders.put("home", DEPLOY, deployV2);
    const post = chat.post.bind(chat);
    chat.post = async () => {
      throw new Error("Discord is down");
    };
    await memory.afterHomeTurn();
    expect(questions()[0].text).toBe(deployV1);

    chat.post = post;
    await memory.afterHomeTurn();
    expect(questions()[0].text).toBe(deployV2);
    expect(chat.postsIn(channel).at(-1)).toContain("Fridays and Mondays.");
  });

  it("keeps to the limit, and asks about the rest once a question closes", async () => {
    memory = build(2);
    folders.put("home", "global-clot-a.md", "a");
    folders.put("home", "global-clot-b.md", "b");
    folders.put("home", "global-clot-c.md", "c");
    await memory.afterHomeTurn();
    expect(questions().map((q) => q.file)).toEqual(["global-clot-a.md", "global-clot-b.md"]);

    await memory.onReply(reply(questions()[0].channelId, "yes"));
    await memory.afterHomeTurn();
    expect(questions().map((q) => q.file)).toEqual(["global-clot-b.md", "global-clot-c.md"]);
  });

  it("withdraws the question when the home Clot removes the file or puts it back", async () => {
    folders.put("home", DEPLOY, deployV1);
    await memory.afterHomeTurn();
    const channel = questions()[0].channelId;
    folders.remove("home", DEPLOY);
    await memory.afterHomeTurn();

    expect(questions()).toEqual([]);
    expect(chat.deleted).toEqual([channel]);
    expect(said.at(-1)!.text).toBe("Withdrawn: the question about global memory `global-clot-deploy-days.md`, which the home Clot has since removed or put back.");
    expect(store.approvedMemories().size).toBe(0);
  });

  it("is not asked about when the channel cannot be made, and is asked at the next check instead", async () => {
    folders.put("home", DEPLOY, deployV1);
    const create = chat.createChannel.bind(chat);
    chat.createChannel = async () => {
      throw new Error("Discord is down");
    };
    await memory.afterHomeTurn();
    expect(questions()).toEqual([]);

    chat.createChannel = create;
    await memory.afterHomeTurn();
    expect(questions()).toHaveLength(1);
  });

  it("stays open across a new home session and a daemon restart", async () => {
    folders.put("home", DEPLOY, deployV1);
    await memory.afterHomeTurn();
    const channel = questions()[0].channelId;
    store.createSession({ id: "s2", clot: "home", channelId: await chat.createChannel("cat-home", "home-1510"), seed: null });

    memory = build();
    await memory.closeOrphans();
    await memory.onReply(reply(channel, "yes"));
    expect(store.approvedMemories().get(DEPLOY)).toBe(deployV1);
  });

  it("is closed at startup when its channel is gone, and asked about again at the next check", async () => {
    folders.put("home", DEPLOY, deployV1);
    await memory.afterHomeTurn();
    await chat.deleteChannel(questions()[0].channelId);
    await memory.closeOrphans();
    expect(questions()).toEqual([]);
    await memory.afterHomeTurn();
    expect(questions()).toHaveLength(1);
  });
});

describe("answers", () => {
  it("repeat the question on any other reply, and ignore anyone but the user", async () => {
    folders.put("home", DEPLOY, deployV1);
    await memory.afterHomeTurn();
    const channel = questions()[0].channelId;
    expect(await memory.onReply(reply(channel, "yes", "someone-else"))).toBe(true);
    expect(await memory.onReply(reply(channel, "after"))).toBe(true);
    expect(chat.postsIn(channel).at(-1)).toContain("I couldn't match that reply.");
    expect(questions()).toHaveLength(1);
  });

  it("leave messages in other channels alone", async () => {
    expect(await memory.onReply(reply("somewhere-else", "yes"))).toBe(false);
  });

  it("stand: a second answer does nothing", async () => {
    folders.put("home", DEPLOY, deployV1);
    await memory.afterHomeTurn();
    const channel = questions()[0].channelId;
    await Promise.all([memory.onReply(reply(channel, "yes")), memory.onReply(reply(channel, "no"))]);
    expect(store.approvedMemories().get(DEPLOY)).toBe(deployV1);
    expect(said).toHaveLength(1);
  });
});

describe("a deletion", () => {
  it("is applied at once, everywhere, with notes and a line in the home channel", async () => {
    await approve(DEPLOY, deployV1);
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

  it("is not taken from a missing folder: the approved files are written back into it", async () => {
    await approve(DEPLOY, deployV1);
    folders.folders.delete("home");
    await memory.afterHomeTurn();

    expect(store.approvedMemories().get(DEPLOY)).toBe(deployV1);
    expect(folders.file("home", DEPLOY)).toBe(deployV1);
    expect(folders.index("home")).toContain(deployLine);
  });
});

describe("syncing before a turn", () => {
  it("removes a global memory a project Clot wrote itself, and restores an edited block, keeping the Clot's own lines", async () => {
    await approve(DEPLOY, deployV1);
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
    await approve(DEPLOY, deployV1);
    await memory.beforeTurn("graphite");
    const writes = folders.writes.length;
    await memory.beforeTurn("graphite");
    expect(folders.writes).toHaveLength(writes);
  });

  it("leaves the home Clot's own changes alone and only keeps its block", async () => {
    await approve(DEPLOY, deployV1);
    folders.put("home", DEPLOY, deployV2);
    folders.put("home", PET, pet);
    await memory.beforeTurn("home");
    expect(folders.file("home", DEPLOY)).toBe(deployV2);
    expect(folders.file("home", PET)).toBe(pet);
    expect(folders.index("home")).toBe(`${BLOCK_START}\n${deployLine}\n${BLOCK_END}\n`);
  });

  it("never throws: a failed sync is tried again before the next turn", async () => {
    await approve(DEPLOY, deployV1);
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
  it("steps back through approvals, changes and deletions, putting the home Clot's copy back to match", async () => {
    await approve(DEPLOY, deployV1);
    await approve(DEPLOY, deployV2);
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

    await memory.afterHomeTurn();
    expect(questions()).toEqual([]);
    await memory.beforeTurn("graphite");
    expect(folders.file("graphite", DEPLOY)).toBeUndefined();
  });

  it("is refused while the file has an open question, and changes nothing", async () => {
    await approve(DEPLOY, deployV1);
    folders.put("home", DEPLOY, deployV2);
    await memory.afterHomeTurn();
    expect(await memory.undo()).toBe("`global-clot-deploy-days.md` has a question waiting for your answer. Answer it first, then undo.");
    expect(store.approvedMemories().get(DEPLOY)).toBe(deployV1);
    expect(folders.file("home", DEPLOY)).toBe(deployV2);
  });

  it("puts the home Clot's copy back only after a running turn", async () => {
    await approve(DEPLOY, deployV1);
    busy.add("home");
    await memory.undo();
    expect(folders.file("home", DEPLOY)).toBe(deployV1);
    busy.delete("home");
    await memory.afterHomeTurn();
    expect(folders.file("home", DEPLOY)).toBeUndefined();
    expect(questions()).toEqual([]);
  });
});

describe("&memory", () => {
  it("lists what is in force and what is waiting for an answer", async () => {
    expect(memory.list()).toBe("No global memories are in force.");
    await approve(DEPLOY, deployV1);
    folders.put("home", "global-clot-x.md", "No front matter.");
    await memory.afterHomeTurn();
    expect(memory.list()).toBe(
      [
        "Global memories in force:",
        "- Deploy days (`global-clot-deploy-days.md`): when the user deploys",
        "",
        "Waiting for your answer:",
        `- \`global-clot-x.md\` in <#${questions()[0].channelId}>`,
      ].join("\n"),
    );
  });
});
