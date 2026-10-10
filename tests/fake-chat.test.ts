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

it("delivers inbound messages to the handler", async () => {
  const chat = new FakeChat();
  const seen: string[] = [];
  await chat.start((m) => seen.push(m.text));
  chat.deliver({ id: "1", channelId: "c", authorId: "u", text: "hi", at: new Date(0) });
  expect(seen).toEqual(["hi"]);
});
