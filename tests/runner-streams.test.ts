import { describe, expect, it } from "vitest";
import { TextStreams } from "../src/agent/runner.js";

const start = (id: string) => ({ type: "message_start", message: { id } });
const block = (index: number, type: string) => ({ type: "content_block_start", index, content_block: { type } });
const delta = (index: number, text: string) => ({ type: "content_block_delta", index, delta: { type: "text_delta", text } });

describe("TextStreams", () => {
  it("keys each text block of a message, and hands the same keys to the finished blocks in order", () => {
    const s = new TextStreams();
    s.observe(start("msg_1"));
    s.observe(block(0, "thinking"));
    s.observe(block(1, "text"));
    expect(s.observe(delta(1, "Hel"))).toEqual({ key: "msg_1:0", text: "Hel" });
    expect(s.observe(delta(1, "lo"))).toEqual({ key: "msg_1:0", text: "lo" });
    s.observe(block(2, "tool_use"));
    s.observe(block(3, "text"));
    expect(s.observe(delta(3, "Bye"))).toEqual({ key: "msg_1:1", text: "Bye" });
    expect(s.finish("msg_1")).toBe("msg_1:0");
    expect(s.finish("msg_1")).toBe("msg_1:1");
    expect(s.finish("msg_1")).toBeUndefined();
  });

  it("keeps messages apart", () => {
    const s = new TextStreams();
    s.observe(start("a"));
    s.observe(block(0, "text"));
    expect(s.observe(delta(0, "x"))?.key).toBe("a:0");
    s.observe(start("b"));
    s.observe(block(0, "text"));
    expect(s.observe(delta(0, "y"))?.key).toBe("b:0");
    expect(s.finish("b")).toBe("b:0");
    expect(s.finish("a")).toBe("a:0");
  });

  it("says nothing for what is not text, and gives no key to a message that was not streamed", () => {
    const s = new TextStreams();
    s.observe(start("m"));
    s.observe(block(0, "tool_use"));
    expect(s.observe({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{" } })).toBeUndefined();
    expect(s.observe(null)).toBeUndefined();
    expect(s.observe({ type: "ping" })).toBeUndefined();
    expect(s.finish("m")).toBeUndefined();
    expect(s.finish("never-seen")).toBeUndefined();
  });
});
