import { describe, expect, it } from "vitest";
import { fillKey, fillPaths, pathGet, pathsIn } from "../src/paths.js";
import { parseComposioRecipe } from "../src/rulebook.js";

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

  it("gives the path of {lines:path} without its prefix", () => {
    expect(pathsIn("x {lines:payload.event.properties} {payload.a}")).toEqual(["payload.event.properties", "payload.a"]);
  });
});

describe("{lines:path}", () => {
  const value = { props: { plan: "pro", seats: 3, active: true, $ip: "1.2.3.4", nested: { a: 1 }, list: [1], none: null }, other: "x" };

  it("fills an object as key: value lines, scalars only, with the $ keys and the non-scalars left out", () => {
    expect(fillPaths("{lines:props}", value)).toBe("plan: pro\nseats: 3\nactive: true");
    expect(fillPaths("Head\n{lines:props}", value)).toBe("Head\nplan: pro\nseats: 3\nactive: true");
  });

  it("fills at most 20 lines", () => {
    const many = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${i}`, i]));
    const lines = fillPaths("{lines:many}", { many }).split("\n");
    expect(lines).toHaveLength(20);
    expect(lines[19]).toBe("k19: 19");
  });

  it("fills nothing for a missing or empty object, and for what is not an object", () => {
    expect(fillPaths("a{lines:nope}b", value)).toBe("ab");
    expect(fillPaths("a{lines:empty}b", { empty: {} })).toBe("ab");
    expect(fillPaths("a{lines:other}b", value)).toBe("ab");
    expect(fillPaths("a{lines:list}b", { list: [1, 2] })).toBe("ab");
    expect(fillPaths("a{lines:props}b", { props: { $only: 1 } })).toBe("ab");
  });

  it("leaves no blank line in a body when its line fills nothing", () => {
    expect(fillPaths("One\n{lines:nope}\nTwo", value)).toBe("One\nTwo");
    expect(fillPaths("One\n{lines:props}\nTwo", { props: {} })).toBe("One\nTwo");
    expect(fillPaths("One\n{lines:nope}", value)).toBe("One");
    expect(fillPaths("One\r\n{lines:nope}\r\nTwo", value)).toBe("One\r\nTwo");
  });

  it("keeps {path} for every other path, including one that is an object", () => {
    expect(fillPaths("{props.plan} {other} {nested}", { props: { plan: "pro" }, other: "x", nested: { a: 1 } })).toBe('pro x {"a":1}');
  });

  it("makes a key incomplete when it fills nothing", () => {
    expect(fillKey("k:{lines:props}", value)).toBe("k:plan: pro\nseats: 3\nactive: true");
    expect(fillKey("k:{lines:nope}", value)).toBeUndefined();
    expect(fillKey("k:{lines:props}", { props: {} })).toBeUndefined();
  });

  it("is accepted by the recipe checker in a body and in a read's arguments, and its path is checked like any", () => {
    const recipe = (body: string, args: unknown) => ({ toolkit: "slack", triggers: { SLACK_X: { kind: "message", title: "t", body, enrich: [{ as: "a", tool: "SLACK_GET", args }] } } });
    expect(parseComposioRecipe(recipe("{lines:payload.props}", { q: "{lines:payload.props}" })).toolkit).toBe("slack");
    expect(parseComposioRecipe(recipe("{lines:enrich.a.props}", {})).toolkit).toBe("slack");
    expect(() => parseComposioRecipe(recipe("{lines:secrets.props}", {}))).toThrow("out of reach");
    expect(() => parseComposioRecipe(recipe("x", { q: "{lines:secrets.props}" }))).toThrow("out of reach");
    expect(() => parseComposioRecipe(recipe("{lines:enrich.b.props}", {}))).toThrow("names no read");
  });
});
