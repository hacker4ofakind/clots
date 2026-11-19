import { z } from "zod";
import type { ToolkitDef } from "./index.js";

/**
 * Composio's Notion slugs. Its triggers need a Notion OAuth app, which an API-key connection lacks, so
 * none is made: Notion's events arrive on stage 2c's own webhook.
 */
export const NOTION = {
  whoAmI: "NOTION_WHO_AM_I",
  createComment: "NOTION_CREATE_COMMENT",
  createPage: "NOTION_CREATE_NOTION_PAGE",
  archivePage: "NOTION_ARCHIVE_NOTION_PAGE",
  // Reads: each answers Notion's own object as `data`.
  retrievePage: "NOTION_RETRIEVE_PAGE",
  fetchComments: "NOTION_FETCH_COMMENTS",
  fetchBlocks: "NOTION_FETCH_BLOCK_CONTENTS",
  getUser: "NOTION_GET_ABOUT_USER",
} as const;

const WhoAmI = z.object({ data: z.object({ id: z.string().min(1) }) });

export const notionDef: ToolkitDef = {
  toolkit: "notion",
  source: "notion",
  async triggers() {
    return [];
  },
  async identity(a, host) {
    const result = await host.run(a, NOTION.whoAmI, {});
    if (!result.ok) throw new Error(`reading who the Notion connection is failed: ${result.error}`);
    return WhoAmI.parse(result.data).data.id;
  },
};
