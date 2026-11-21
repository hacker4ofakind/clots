import { describe, expect, it } from "vitest";
import { fillKey, fillPaths, pathGet, pathsIn } from "../src/paths.js";

describe("pathGet and fillPaths", () => {
  it("follows names and indexes, and gives nothing for a missing path", () => {
    expect(pathGet({ data: [{ rows: [1, 2] }] }, "data.0.rows")).toEqual([1, 2]);
    expect(pathGet({ a: 1 }, "b.c")).toBeUndefined();
    expect(fillPaths("{title}{missing}", { title: "Bug" })).toBe("Bug");
  });

  it("takes the first of {a|b} that is present: not missing, not null", () => {
    expect(fillPaths("{thread|ts}", { thread: null, ts: "1.5" })).toBe("1.5");
    expect(fillPaths("{thread|ts}", { thread: "9.9", ts: "1.5" })).toBe("9.9");
    expect(fillPaths("{a|b}", {})).toBe("");
    expect(fillPaths("slack:{c}:{thread_ts|ts}", { c: "C1", thread_ts: null, ts: "1.5" })).toBe("slack:C1:1.5");
  });

  it("writes an object as JSON and keeps a falsy value that is there", () => {
    expect(fillPaths("{o} {n} {f}", { o: { a: 1 }, n: 0, f: false })).toBe('{"a":1} 0 false');
  });
});

describe("fillKey", () => {
  it("is undefined when any path is missing, so a partial key is never made", () => {
    expect(fillKey("{channel}:{ts}", { channel: "C1", ts: "1.5" })).toBe("C1:1.5");
    expect(fillKey("{channel}:{ts}", { channel: "C1" })).toBeUndefined();
    expect(fillKey("{channel}:{ts}", { channel: "C1", ts: null })).toBeUndefined();
  });

  it("is undefined for an empty result, and counts an alternative that is present as filled", () => {
    expect(fillKey("{a}", { a: "" })).toBeUndefined();
    expect(fillKey("{a|b}", { b: "x" })).toBe("x");
  });
});

describe("pathsIn", () => {
  it("lists every path a template reads, alternatives apart", () => {
    expect(pathsIn("{payload.a|payload.b} and {enrich.user.name}")).toEqual(["payload.a", "payload.b", "enrich.user.name"]);
  });
});
