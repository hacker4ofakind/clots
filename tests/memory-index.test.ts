import { describe, expect, it } from "vitest";
import { BLOCK_END, BLOCK_START, frontMatter, indexLine, isGlobalFile, withGlobalBlock } from "../src/memory-index.js";

const memory = (front: string, body = "The user deploys on Fridays only.") => `---\n${front}\n---\n\n${body}\n`;
const deploy = "- [Deploy days](global-clot-deploy-days.md) — the user deploys on Fridays only";
const pet = "- [Pet](global-clot-pet.md) — the user's pet";

describe("isGlobalFile", () => {
  it("accepts global-clot- names of lowercase letters, digits and hyphens", () => {
    expect(isGlobalFile("global-clot-deploy-days.md")).toBe(true);
    expect(isGlobalFile("global-clot-2fa.md")).toBe(true);
    for (const name of ["deploy-days.md", "global-clot-.md", "global-clot-Deploy.md", "global-clot-a b.md", "global-clot-x.txt", "MEMORY.md"]) {
      expect(isGlobalFile(name)).toBe(false);
    }
  });
});

describe("frontMatter", () => {
  it("reads name and description", () => {
    expect(frontMatter(memory("name: Deploy days\ndescription: the user deploys on Fridays only\ntype: user"))).toEqual({ name: "Deploy days", description: "the user deploys on Fridays only" });
  });

  it("reads quoted values and folds line breaks", () => {
    expect(frontMatter(memory('name: "Deploy: days"\ndescription: >\n  the user deploys\n  on Fridays only'))).toEqual({ name: "Deploy: days", description: "the user deploys on Fridays only" });
  });

  it("gives nothing for a file without front matter, or with front matter that is not a mapping", () => {
    expect(frontMatter("The user deploys on Fridays only.")).toEqual({});
    expect(frontMatter(memory("- a list"))).toEqual({});
    expect(frontMatter(memory("name: [unclosed"))).toEqual({});
  });
});

describe("indexLine", () => {
  it("links the file under its name, with its description", () => {
    expect(indexLine("global-clot-deploy-days.md", memory("name: Deploy days\ndescription: the user deploys on Fridays only"))).toBe(deploy);
  });

  it("uses the file name when there is no name, and leaves out a missing description", () => {
    expect(indexLine("global-clot-x.md", "Just text.")).toBe("- [global-clot-x.md](global-clot-x.md)");
    expect(indexLine("global-clot-x.md", memory("description: about x"))).toBe("- [global-clot-x.md](global-clot-x.md) — about x");
  });

  it("keeps brackets in a name from breaking the link", () => {
    expect(indexLine("global-clot-x.md", memory("name: Deploy [days]"))).toBe("- [Deploy days](global-clot-x.md)");
  });
});

describe("withGlobalBlock", () => {
  const own = "- [Own note](own-note.md) — a line the Clot wrote itself\n";

  it("writes the block into an empty or missing index", () => {
    expect(withGlobalBlock("", [deploy])).toBe(`${BLOCK_START}\n${deploy}\n${BLOCK_END}\n`);
  });

  it("puts the block at the top and keeps the Clot's own lines as they were", () => {
    expect(withGlobalBlock(own, [deploy, pet])).toBe(`${BLOCK_START}\n${deploy}\n${pet}\n${BLOCK_END}\n${own}`);
  });

  it("gives the same text when applied twice", () => {
    const once = withGlobalBlock(own, [deploy]);
    expect(withGlobalBlock(once, [deploy])).toBe(once);
  });

  it("moves a block the Clot moved back to the top, and replaces what the Clot wrote inside it", () => {
    const moved = `${own}${BLOCK_START}\n${deploy}\n- [Mine](mine.md) — slipped into the block\n${BLOCK_END}\n- [Later](later.md)\n`;
    expect(withGlobalBlock(moved, [pet])).toBe(`${BLOCK_START}\n${pet}\n${BLOCK_END}\n${own}- [Later](later.md)\n`);
  });

  it("drops a line outside the block that links to a global memory", () => {
    expect(withGlobalBlock(`${own}${deploy}\n`, [deploy])).toBe(`${BLOCK_START}\n${deploy}\n${BLOCK_END}\n${own}`);
  });

  it("keeps a line of the Clot's own that only mentions a global memory", () => {
    const mention = "- [Release notes](release-notes.md) — follows [Deploy days](global-clot-deploy-days.md)\n";
    expect(withGlobalBlock(`${own}${mention}`, [deploy])).toBe(`${BLOCK_START}\n${deploy}\n${BLOCK_END}\n${own}${mention}`);
  });

  it("takes out only a start marker that has no end after it", () => {
    expect(withGlobalBlock(`${BLOCK_START}\n${own}`, [deploy])).toBe(`${BLOCK_START}\n${deploy}\n${BLOCK_END}\n${own}`);
  });

  it("removes the block when there are no global memories, and leaves an index without one untouched", () => {
    expect(withGlobalBlock(`${BLOCK_START}\n${deploy}\n${BLOCK_END}\n${own}`, [])).toBe(own);
    expect(withGlobalBlock(`\n\n${own}`, [])).toBe(`\n\n${own}`);
  });
});
