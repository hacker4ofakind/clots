import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { WatchRecipe } from "../rulebook.js";
import type { DaemonTools } from "../tools.js";
import { DAEMON_TOOL_SERVER } from "./command-check.js";

/** Runs a tool and gives its text back in the shape the SDK expects. A tool that throws says so instead of ending the turn. */
async function reply(run: () => Promise<string>) {
  try {
    return { content: [{ type: "text" as const, text: await run() }] };
  } catch (error) {
    console.error("[tools]", error);
    return { content: [{ type: "text" as const, text: `The tool failed: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

const file = z.enum(["own", "global"]).describe('Which rule file: "own" is this Clot\'s file, "global" applies to every Clot.');

/** The fields a pre-filter or a trigger matches on. An event matches when every field given matches. */
const match = {
  source: z.string().min(1).optional().describe("Where the event comes from: github, stripe, email, calendar, linear, notion, or a recipe's name."),
  account: z.string().min(1).optional().describe("Which configured account of the source, as the event's account line names it."),
  kind: z.string().min(1).optional().describe("The kind of event, as the event's kind line names it: issue_opened, comment, payment_failed, email, reminder, ..."),
  place: z.string().min(1).optional().describe("Where at the source, as the event's place line names it: a repository, a Linear team, the address an email was sent to."),
  repo: z.string().min(1).optional().describe("A GitHub repository, as owner/name. The same as source github with that place."),
  actor: z.string().min(1).optional().describe("Whoever caused the event, as the event's actor line names it, for example dependabot[bot]."),
  titleContains: z.string().min(1).optional().describe("Text the event's title contains. Letter case is ignored."),
};

/** The match fields of a tool's arguments, as a rule. */
const pick = (a: { source?: string; account?: string; kind?: string; place?: string; repo?: string; actor?: string; titleContains?: string }) => ({
  source: a.source,
  account: a.account,
  kind: a.kind,
  place: a.place,
  repo: a.repo,
  actor: a.actor,
  titleContains: a.titleContains,
});

/** Always in the turn's tool list, so the Clot does not have to search for them. */
const always = { alwaysLoad: true };

const EDIT_NOTE = "The daemon decides whether the change is applied at once or put to the user as a proposal, and the result says which.";

/** The daemon's tools for one turn, as an in-process MCP server. The handlers run in the daemon. */
export function toolServer(tools: DaemonTools) {
  return createSdkMcpServer({
    name: DAEMON_TOOL_SERVER,
    version: "1.0.0",
    tools: [
      tool("rulebook_show", "Shows the rules in force for you (pre-filters, triage guidance, standing rules) and your proposals that still wait for the user's answer.", {}, () => reply(() => tools.show()), always),
      tool(
        "rulebook_prefilter",
        `Adds or removes a pre-filter: events that match it are dropped before anything looks at them. Give at least one of source, account, kind, place, repo, actor and titleContains. To remove one, give the same fields it has. ${EDIT_NOTE}`,
        { action: z.enum(["add", "remove"]), file, ...match },
        (a) => reply(() => tools.prefilter({ action: a.action, file: a.file, rule: pick(a) })),
        always,
      ),
      tool(
        "rulebook_guidance",
        `Adds or removes one line of triage guidance: a plain sentence that tells triage what does or does not need attention. To remove a line, give its exact text. ${EDIT_NOTE}`,
        { action: z.enum(["add", "remove"]), file, line: z.string().min(1).describe("One sentence.") },
        (a) => reply(() => tools.guidance({ action: a.action, file: a.file, line: a.line })),
        always,
      ),
      tool(
        "rulebook_standing",
        "Adds, replaces or removes a standing rule: one exact message you may send without asking, when an event matches its trigger. It is always put to the user as a proposal. With action \"set\", give the kind, the way of sending and the template; a rule of the same name is replaced. The template may use {actor}, {title}, {ref}, {place} and {url}, filled from the event. github_comment comments on the event's issue or pull request; email_reply answers an email (source email); linear_comment and notion_comment comment on the Linear issue or Notion page.",
        {
          action: z.enum(["set", "remove"]),
          file,
          name: z.string().min(1).describe("Lowercase letters, digits and hyphens, for example ack-issue."),
          ...match,
          via: z.enum(["github_comment", "email_reply", "linear_comment", "notion_comment", "sentry_comment"]).optional().describe("How the message is sent. Default github_comment."),
          template: z.string().min(1).max(2000).optional().describe("The exact text to send."),
        },
        (a) =>
          reply(() =>
            tools.standing({
              action: a.action,
              file: a.file,
              name: a.name,
              trigger: a.kind === undefined ? undefined : { ...pick(a), kind: a.kind },
              via: a.via,
              template: a.template,
            }),
          ),
        always,
      ),
      tool(
        "send_from_template",
        "Sends the message of a standing rule that applies to the event you are looking into. Works only in the turn that looks into that event, once per rule. Leave text out to send the template as filled in. To adjust the wording, give the whole text: at most five words may be added, removed or replaced.",
        { rule: z.string().min(1).describe("The standing rule's name."), text: z.string().optional().describe("The whole text to send, if you changed the wording.") },
        (a) => reply(() => tools.send({ rule: a.rule, text: a.text })),
        always,
      ),
      tool(
        "rulebook_routing",
        "Adds or removes a routing rule: events from a shared account (one inbox, one calendar, one workspace for several projects) that match it go to the Clot it names. Give at least one field to match on, and the Clot. It is always put to the user as a proposal.",
        { action: z.enum(["add", "remove"]), ...match, clot: z.string().min(1).describe("The Clot the events go to, or home.") },
        (a) => reply(() => tools.routing({ action: a.action, rule: { ...pick(a), clot: a.clot } })),
        always,
      ),
      tool(
        "route_correct",
        "Hands an event that was routed to you to the Clot it belongs to, when the user has said so. Give the event's id, from its block, and the Clot. Works in a working turn only.",
        { event: z.string().min(1).describe("The event's id."), clot: z.string().min(1).describe("The Clot it belongs to, or home.") },
        (a) => reply(() => tools.routeCorrect({ event: a.event, clot: a.clot })),
        always,
      ),
      ...(tools.emailDraft === undefined
        ? []
        : [
            tool(
              "email_draft",
              `Saves an email as a draft in the user's mailbox, for the user to read, change and send. Nothing is sent. To answer an email event, give its id and your text: the draft answers its sender, in its thread, from the address it came to. For a new message, give the account, the recipients and a subject. Works in a working turn only. ${tools.emailAccounts ?? ""}`.trim(),
              {
                event: z.string().optional().describe("The id of the email you are answering."),
                account: z.string().optional().describe("For a new message: the email account to write from."),
                to: z.array(z.string()).optional().describe("For a new message: the recipients' addresses."),
                subject: z.string().optional().describe("For a new message: the subject."),
                text: z.string().min(1).describe("The message, in plain text."),
              },
              (a) => reply(() => tools.emailDraft!({ event: a.event, account: a.account, to: a.to, subject: a.subject, text: a.text })),
              always,
            ),
          ]),
      ...(tools.emailSend === undefined
        ? []
        : [
            tool(
              "email_send",
              `Asks to send an email. The daemon shows it to the user in a separate channel and sends it only on their yes; they may also drop it, have it saved as a draft, or give feedback, which reaches you as a message from them: revise the email and call this again. Takes the same fields as email_draft. Works in every kind of turn; while looking into an event, only to answer that email. ${tools.emailAccounts ?? ""}`.trim(),
              {
                event: z.string().optional().describe("The id of the email you are answering."),
                account: z.string().optional().describe("For a new message: the email account to write from."),
                to: z.array(z.string()).optional().describe("For a new message: the recipients' addresses."),
                subject: z.string().optional().describe("For a new message: the subject."),
                text: z.string().min(1).describe("The message, in plain text."),
              },
              (a) => reply(() => tools.emailSend!({ event: a.event, account: a.account, to: a.to, subject: a.subject, text: a.text })),
              always,
            ),
          ]),
      ...(tools.calendarList === undefined
        ? []
        : [
            tool(
              "calendar_list",
              "Lists the user's calendar for a range: by default the coming week, at most 31 days. Each event shows its id, which calendar_write and calendar_remove take. Works in every kind of turn.",
              {
                from: z.string().optional().describe('The start: a date ("2026-10-16"), a local time ("2026-10-16T14:00") or a time with a zone. Default: now.'),
                to: z.string().optional().describe("The end, in the same forms. Default: a week after the start."),
              },
              (a) => reply(() => tools.calendarList!({ from: a.from, to: a.to })),
              always,
            ),
          ]),
      ...(tools.calendarWrite === undefined
        ? []
        : [
            tool(
              "calendar_write",
              "Adds an event to the user's calendar, or changes one (its title, time, description or location). Events with guests cannot be changed, and no guest can be added, so nothing notifies another person. A change to a repeating event applies to every occurrence. Works in a working turn only. The daemon tells the user each change.",
              {
                action: z.enum(["create", "update"]),
                account: z.string().optional().describe("Which calendar, when there are several."),
                uid: z.string().optional().describe("For update: the event's id, from calendar_list."),
                title: z.string().optional(),
                start: z.string().optional().describe('A date ("2026-10-16") for an all-day event, a local time ("2026-10-16T14:00"), or a time with a zone.'),
                end: z.string().optional().describe("In the same form. For an all-day event, the day after the last day."),
                allDay: z.boolean().optional(),
                description: z.string().optional(),
                location: z.string().optional(),
              },
              (a) => reply(() => tools.calendarWrite!({ action: a.action, account: a.account, uid: a.uid, title: a.title, start: a.start, end: a.end, allDay: a.allDay, description: a.description, location: a.location })),
              always,
            ),
          ]),
      ...(tools.calendarRemove === undefined
        ? []
        : [
            tool(
              "calendar_remove",
              "Asks the user, in a separate channel, to confirm removing an event from their calendar; the daemon removes it on their yes. Call it only after the user has said yes in chat to removing this event. Works only in a working turn the user started.",
              { account: z.string().optional().describe("Which calendar, when there are several."), uid: z.string().min(1).describe("The event's id, from calendar_list.") },
              (a) => reply(() => tools.calendarRemove!({ account: a.account, uid: a.uid })),
              always,
            ),
          ]),
      ...(tools.mcpList === undefined
        ? []
        : [tool("mcp_list", "Lists the daemon's own MCP servers, whether each is connected, and their tools, marking which only read. Watch recipes call these tools. Works in every kind of turn.", {}, () => reply(() => tools.mcpList!()), always)]),
      ...(() => {
        const recipe = {
          name: z.string().min(1).describe("Lowercase letters, digits and hyphens; not a built-in source's name. It becomes the events' source."),
          server: z.string().min(1).describe("One of the daemon's MCP servers, from mcp_list."),
          tool: z.string().min(1).describe("A read-only tool of that server."),
          arguments: z.record(z.string(), z.unknown()).optional().describe("The tool's arguments."),
          items: z.string().describe('Where the list of items is in the result, as a path such as "results" or "data.0.rows"; "" when the result is the list.'),
          id: z.string().min(1).describe("The path, within an item, of what identifies it."),
          title: z.string().optional().describe('Text for the event\'s title, with {path} filled from the item, such as "{properties.Name}".'),
          body: z.string().optional(),
          url: z.string().optional(),
          actor: z.string().optional(),
          ignore: z.array(z.string()).optional().describe("Paths left out when deciding whether an item changed."),
          every: z.number().int().min(1).optional().describe("Minutes between calls. Default 5."),
          report: z.enum(["added", "added_and_changed"]).optional(),
          notReadOnly: z.literal(true).optional().describe("Only when the tool does not declare itself read-only and you know it changes nothing. The user is warned."),
        };
        const asRecipe = (a: any): WatchRecipe => ({ ignore: [], every: 5, report: "added", arguments: {}, ...Object.fromEntries(Object.entries(a).filter(([key, value]) => key !== "action" && key !== "file" && value !== undefined)) }) as unknown as WatchRecipe;
        return [
          ...(tools.watchTry === undefined
            ? []
            : [tool("watch_try", "Runs a draft watch recipe once and shows how many items it finds and the first five, as the recipe reads them. Records nothing. Works in every kind of turn, for read-only tools.", recipe, (a) => reply(() => tools.watchTry!(asRecipe(a))), always)]),
          tool(
            "rulebook_watch",
            "Adds, replaces or removes a watch recipe: the daemon calls one read-only tool of one of its MCP servers on a timer and reports each new item as an event. Try it first with watch_try. It is always put to the user as a proposal. In your own file its events come to you; in the global file they are routed.",
            { action: z.enum(["set", "remove"]), file, ...recipe, server: recipe.server.optional(), tool: recipe.tool.optional(), items: recipe.items.optional(), id: recipe.id.optional() },
            (a) => reply(() => tools.watch(a.action === "remove" ? { action: "remove", file: a.file, name: a.name } : { action: "set", file: a.file, recipe: asRecipe(a) })),
            always,
          ),
        ];
      })(),
      tool(
        "rulebook_webhook",
        "Adds, replaces or removes a webhook recipe: how to verify and read the webhooks of a service with no built-in support, so its deliveries become events. Draft it from a sample payload or the service's documentation the user gives you. It is always put to the user as a proposal; the user then puts the secret in .env and sets up the webhook in the service. In your own file its events come to you; in the global file they are routed.",
        {
          action: z.enum(["set", "remove"]),
          file,
          name: z.string().min(1),
          verify: z
            .object({
              scheme: z.enum(["hmac-sha256", "token"]),
              header: z.string(),
              prefix: z.string().optional(),
              encoding: z.enum(["hex", "base64"]).optional(),
              signed: z.enum(["body", "timestamp.body"]).optional(),
              timestampHeader: z.string().optional(),
              toleranceSeconds: z.number().optional(),
              secret: z.string().describe("An .env key beginning RECIPE_."),
            })
            .optional(),
          delivery: z.object({ header: z.string().optional(), field: z.string().optional() }).optional(),
          kinds: z.array(z.object({ kind: z.string(), when: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])) })).optional(),
          event: z.object({ title: z.string(), actor: z.string().optional(), body: z.string().optional(), url: z.string().optional(), ref: z.string().optional(), place: z.string().optional(), subject: z.string().optional() }).optional(),
          automatedWhen: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
        },
        (a) =>
          reply(() =>
            tools.webhook(
              a.action === "remove"
                ? { action: "remove", file: a.file, name: a.name }
                : { action: "set", file: a.file, recipe: Object.fromEntries(Object.entries(a).filter(([key, value]) => key !== "action" && key !== "file" && value !== undefined)) as never },
            ),
          ),
        always,
      ),
    ],
  });
}
