import { describe, expect, it } from "vitest";
import { compareHome, type OpenQuestion } from "../src/memory-compare.js";

const A = "global-clot-a.md";
const B = "global-clot-b.md";
const map = (entries: [string, string][] = []) => new Map(entries);
const q = (file: string, text: string, channelId = `ch-${file}`): OpenQuestion => ({ file, text, channelId });

describe("compareHome, one row of the spec's table each", () => {
  it("same text as approved, no question: nothing", () => {
    expect(compareHome(map([[A, "v1"]]), map([[A, "v1"]]), [])).toEqual([]);
  });

  it("same text as approved, with a question: withdraws it", () => {
    expect(compareHome(map([[A, "v1"]]), map([[A, "v1"]]), [q(A, "v2")])).toEqual([{ kind: "withdraw", file: A, channelId: `ch-${A}` }]);
  });

  it("different text, no question: asks, about a new memory or a change", () => {
    expect(compareHome(map([[A, "v1"]]), map(), [])).toEqual([{ kind: "ask", file: A, text: "v1", approved: undefined }]);
    expect(compareHome(map([[A, "v2"]]), map([[A, "v1"]]), [])).toEqual([{ kind: "ask", file: A, text: "v2", approved: "v1" }]);
  });

  it("different text, with a question about other text: updates the question", () => {
    expect(compareHome(map([[A, "v3"]]), map([[A, "v1"]]), [q(A, "v2")])).toEqual([{ kind: "update", file: A, text: "v3", channelId: `ch-${A}` }]);
    expect(compareHome(map([[A, "v3"]]), map(), [q(A, "v2")])).toEqual([{ kind: "update", file: A, text: "v3", channelId: `ch-${A}` }]);
  });

  it("different text, with a question about this text: nothing", () => {
    expect(compareHome(map([[A, "v2"]]), map([[A, "v1"]]), [q(A, "v2")])).toEqual([]);
  });

  it("missing but approved: a deletion, and its question is withdrawn", () => {
    expect(compareHome(map(), map([[A, "v1"]]), [])).toEqual([{ kind: "delete", file: A }]);
    expect(compareHome(map(), map([[A, "v1"]]), [q(A, "v2")])).toEqual([
      { kind: "withdraw", file: A, channelId: `ch-${A}` },
      { kind: "delete", file: A },
    ]);
  });

  it("missing and never approved, with a question: withdraws it", () => {
    expect(compareHome(map(), map(), [q(A, "v1")])).toEqual([{ kind: "withdraw", file: A, channelId: `ch-${A}` }]);
  });
});

it("puts withdrawals first, then deletions, updates and questions, each in name order", () => {
  const actions = compareHome(
    map([
      [B, "new"],
      [A, "new"],
      ["global-clot-c.md", "v3"],
    ]),
    map([["global-clot-d.md", "x"]]),
    [q("global-clot-c.md", "v2"), q("global-clot-e.md", "gone")],
  );
  expect(actions.map((a) => `${a.kind} ${a.file}`)).toEqual([
    "withdraw global-clot-e.md",
    "delete global-clot-d.md",
    "update global-clot-c.md",
    `ask ${A}`,
    `ask ${B}`,
  ]);
});
