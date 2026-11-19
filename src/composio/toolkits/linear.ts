import { z } from "zod";
import type { ToolkitDef } from "./index.js";

/** Composio's Linear slugs, confirmed live. Its webhook triggers need an OAuth app, so the polled private-team ones are used for every team. */
export const LINEAR = {
  issueCreated: "LINEAR_PRIVATE_TEAM_ISSUE_CREATED",
  commentCreated: "LINEAR_PRIVATE_TEAM_COMMENT_CREATED",
  whoAmI: "LINEAR_WHO_AM_I",
  listTeams: "LINEAR_LIST_LINEAR_TEAMS",
  graphql: "LINEAR_RUN_QUERY_OR_MUTATION",
  getIssue: "LINEAR_GET_LINEAR_ISSUE",
  createIssue: "LINEAR_CREATE_LINEAR_ISSUE",
  createComment: "LINEAR_CREATE_LINEAR_COMMENT",
  archiveIssue: "LINEAR_ARCHIVE_ISSUE",
  updateIssue: "LINEAR_UPDATE_ISSUE",
} as const;

/** How often Composio polls a team, in minutes. */
export const LINEAR_POLL_MINUTES = 1;

const WhoAmI = z.object({ data: z.object({ id: z.string().min(1) }) });
const Teams = z.object({ teams: z.array(z.object({ id: z.string().min(1) })) });

export const linearDef: ToolkitDef = {
  toolkit: "linear",
  source: "linear",
  async triggers(a, host) {
    const result = await host.run(a, LINEAR.listTeams, {});
    if (!result.ok) throw new Error(`reading Linear's teams failed: ${result.error}`);
    const teams = Teams.parse(result.data).teams;
    return teams.flatMap((team) => [LINEAR.issueCreated, LINEAR.commentCreated].map((slug) => ({ slug, config: { team_id: team.id }, pollingMinutes: LINEAR_POLL_MINUTES })));
  },
  async identity(a, host) {
    const result = await host.run(a, LINEAR.whoAmI, {});
    if (!result.ok) throw new Error(`reading who the Linear key belongs to failed: ${result.error}`);
    return WhoAmI.parse(result.data).data.id;
  },
};
