import { expect, it } from "vitest";
import { FakeChat } from "../src/chat/fake.js";

it("records categories, channels, posts and read-only state", async () => {
  const chat = new FakeChat();
  const category = await chat.ensureCategory("graphite");
  expect(await chat.ensureCategory("graphite")).toBe(category);

  const channel = await chat.createChannel(category, "graphite-1010");
  expect(await chat.listChannelNames(category)).toEqual(["graphite-1010"]);

  await chat.post(channel, "hello");
  expect(chat.postsIn(channel)).toEqual(["hello"]);

  await chat.makeReadOnly(channel);
  expect(chat.readOnly.has(channel)).toBe(true);
});

it("tracks which channels show typing", () => {
  const chat = new FakeChat();
  const stop = chat.startTyping("c");
  expect(chat.typing.has("c")).toBe(true);
  stop();
  expect(chat.typing.has("c")).toBe(false);
});

it("records activity summaries apart from ordinary posts", async () => {
  const chat = new FakeChat();
  const activity = { files: [{ path: "a.ts", added: 1, removed: 0 }], commands: ["ls"] };
  await chat.postActivity("c", activity);
  expect(chat.activities).toEqual([{ channelId: "c", activity }]);
  expect(chat.postsIn("c")).toEqual([]);
});

it("deletes a channel", async () => {
  const chat = new FakeChat();
  const category = await chat.ensureCategory("graphite");
  const keep = await chat.createChannel(category, "graphite-1010");
  const gone = await chat.createChannel(category, "graphite-ask");
  await chat.deleteChannel(gone);
  expect(await chat.listChannelNames(category)).toEqual(["graphite-1010"]);
  expect(chat.deleted).toEqual([gone]);
  expect(keep).not.toBe(gone);
});

it("delivers inbound messages to the handler", async () => {
  const chat = new FakeChat();
  const seen: string[] = [];
  await chat.start((m) => seen.push(m.text));
  chat.deliver({ id: "1", channelId: "c", authorId: "u", text: "hi", at: new Date(0) });
  expect(seen).toEqual(["hi"]);
});
