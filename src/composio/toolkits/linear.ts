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
const text = z.string().nullish();

/**
 * What the GraphQL tool answers: the operation's own `data` (null when it failed) and its `errors`. The
 * operation's shape goes in `inner`; one that fails is drift, whatever the query.
 */
export const graphqlAnswer = (inner: z.ZodType) => z.looseObject({ data: inner.nullish(), errors: z.array(z.unknown()).nullish() });

/** The fields the issue enrichment reads. Each is optional; one that is present has the type the enricher assumes. */
const IssueFacts = z.looseObject({
  identifier: text,
  description: text,
  priorityLabel: text,
  team: z.looseObject({ key: text }).nullish(),
  state: z.looseObject({ name: text }).nullish(),
  assignee: z.looseObject({ name: text }).nullish(),
  labels: z.looseObject({ nodes: z.array(z.looseObject({ name: text })) }).nullish(),
  comments: z.looseObject({ nodes: z.array(z.looseObject({ body: text, createdAt: text, user: z.looseObject({ name: text }).nullish() })) }).nullish(),
});

/** The GraphQL answers the daemon relies on: the enrichment's issue query, the issue lookup before a comment, and the comment mutation. */
export const LINEAR_GRAPHQL = {
  issue: graphqlAnswer(z.looseObject({ issue: IssueFacts.nullable() })),
  issueId: graphqlAnswer(z.looseObject({ issue: z.looseObject({ id: z.string().min(1) }).nullable() })),
  commentCreate: graphqlAnswer(z.looseObject({ commentCreate: z.looseObject({ success: z.boolean(), comment: z.looseObject({ id: text, url: text }).nullish() }) })),
} as const;

export const linearDef: ToolkitDef = {
  toolkit: "linear",
  source: "linear",
  async triggers(a, host) {
    const result = await host.runChecked(a, LINEAR.listTeams, {});
    if (!result.ok) throw new Error(`reading Linear's teams failed: ${result.error}`);
    const teams = Teams.parse(result.data).teams;
    return teams.flatMap((team) => [LINEAR.issueCreated, LINEAR.commentCreated].map((slug) => ({ slug, config: { team_id: team.id }, pollingMinutes: LINEAR_POLL_MINUTES })));
  },
  async identity(a, host) {
    const result = await host.runChecked(a, LINEAR.whoAmI, {});
    if (!result.ok) throw new Error(`reading who the Linear key belongs to failed: ${result.error}`);
    return WhoAmI.parse(result.data).data.id;
  },
  responseChecks: {
    [LINEAR.listTeams]: Teams,
    [LINEAR.whoAmI]: WhoAmI,
    // The issue read before an update, and for the reviewer's facts: Linear's own object under `issue`.
    [LINEAR.getIssue]: z.looseObject({ issue: z.looseObject({ id: text, creator: z.looseObject({ name: text }).nullish() }) }),
    // The envelope of every GraphQL call; the operations' own shapes are checked on top (`LINEAR_GRAPHQL`).
    [LINEAR.graphql]: graphqlAnswer(z.looseObject({})),
  },
};
