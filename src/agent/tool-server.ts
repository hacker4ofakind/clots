import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { RULE_KINDS } from "../rulebook.js";
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
  kind: z.enum(RULE_KINDS).optional().describe("The kind of event."),
  actor: z.string().min(1).optional().describe("The login of whoever caused the event, for example dependabot[bot]."),
  repo: z.string().min(1).optional().describe("The repository, as owner/name."),
  titleContains: z.string().min(1).optional().describe("Text the event's title contains. Letter case is ignored."),
};

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
        `Adds or removes a pre-filter: events that match it are dropped before anything looks at them. Give at least one of kind, actor, repo and titleContains. To remove one, give the same fields it has. ${EDIT_NOTE}`,
        { action: z.enum(["add", "remove"]), file, ...match },
        (a) => reply(() => tools.prefilter({ action: a.action, file: a.file, rule: { kind: a.kind, actor: a.actor, repo: a.repo, titleContains: a.titleContains } })),
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
        "Adds, replaces or removes a standing rule: one exact message you may send without asking, when an event matches its trigger. It is always put to the user as a proposal. With action \"set\", give the kind and the template; a rule of the same name is replaced. The template may use {actor}, {title}, {ref}, {repo} and {url}, filled from the event. The message is posted as a comment on the event's own issue or pull request.",
        {
          action: z.enum(["set", "remove"]),
          file,
          name: z.string().min(1).describe("Lowercase letters, digits and hyphens, for example ack-issue."),
          ...match,
          template: z.string().min(1).max(2000).optional().describe("The exact text to send."),
        },
        (a) =>
          reply(() =>
            tools.standing({
              action: a.action,
              file: a.file,
              name: a.name,
              trigger: a.kind === undefined ? undefined : { kind: a.kind, actor: a.actor, repo: a.repo, titleContains: a.titleContains },
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
    ],
  });
}
