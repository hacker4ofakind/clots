import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { defaultRecipe, defaultRecipeToolkits } from "../src/composio/default-recipes.js";
import { renderRecipe } from "../src/composio/recipe.js";
import { composioEntryProblems } from "../src/config.js";
import { parseRuleFile } from "../src/rulebook.js";

const NOW = 1_760_000_000_000;
const account = { toolkit: "posthog", account: "app" };
const SLUG = "POSTHOG_EVENT_CAPTURED";

// The shape of Composio's PostHog trigger, per its published payload schema (the payload the built-in mapper was tested with).
const captured = {
  event: { event: "signup", distinct_id: "user-42", timestamp: "2026-11-19T10:00:00Z", captured_at: "2026-11-19T10:00:01Z", url: "https://us.posthog.com/project/7/events/abc", properties: { plan: "pro", $ip: "1.2.3.4", nested: { a: 1 }, seats: 3 } },
  person: { id: "p-1", name: "Ann", distinct_id: "user-42", url: "https://us.posthog.com/person/user-42", properties: {} },
  project: { id: 7, name: "Truecast (Dev)", url: "https://us.posthog.com/project/7" },
};

const render = (payload: unknown, webhookId = "msg_1", receivedAt = NOW) => renderRecipe(defaultRecipe("posthog")!, SLUG, account, payload, {}, webhookId, receivedAt);

describe("the shipped recipes", () => {
  it("all fit the recipe schema, so a bad one fails here and not in the daemon", () => {
    expect(defaultRecipeToolkits()).toEqual(["posthog"]);
    for (const toolkit of defaultRecipeToolkits()) expect(defaultRecipe(toolkit)?.toolkit).toBe(toolkit);
    expect(defaultRecipe("slack")).toBeUndefined();
    expect(defaultRecipe("toString")).toBeUndefined();
  });
});

describe("the shipped PostHog recipe makes the events the built-in mapper made", () => {
  it("turns an event into an automated analytics_event in its project, about the event's name", () => {
    expect(render(captured)).toEqual({
      actorId: "",
      objectIds: [],
      event: {
        id: "posthog:app:signup:user-42:2026-11-19T10:00:00Z",
        source: "posthog",
        account: "app",
        kind: "analytics_event",
        place: "Truecast (Dev)",
        actor: "user-42",
        title: "signup in PostHog (user-42)",
        body: "PostHog event: signup\nProject: Truecast (Dev)\nPerson: Ann\nAt: 2026-11-19T10:00:00Z\nplan: pro\nseats: 3",
        url: "https://us.posthog.com/project/7/events/abc",
        ref: "signup",
        subject: "posthog:signup",
        automated: true,
        outsider: true,
        receivedAt: NOW,
      },
    });
  });

  it("keeps a repeat of the same event one event, whatever the delivery", () => {
    expect(render(captured, "msg_2", NOW + 1).event.id).toBe(render(captured, "msg_1", NOW).event.id);
    expect(render(captured).event.id).toBe("posthog:app:signup:user-42:2026-11-19T10:00:00Z");
  });

  it("makes the place the project's name, then its ID, then the account", () => {
    expect(render({ ...captured, project: { id: 7 } }).event.place).toBe("7");
    expect(render({ ...captured, project: undefined }).event.place).toBe("app");
  });

  it("falls back to the person's distinct ID, and to its URL and the project's, as the mapper did", () => {
    const { distinct_id: _gone, ...bare } = captured.event;
    const noDistinct = render({ ...captured, event: bare }).event;
    expect(noDistinct.actor).toBe("user-42");
    expect(noDistinct.id).toBe("posthog:app:signup:user-42:2026-11-19T10:00:00Z");
    const { url: _url, ...noUrl } = captured.event;
    expect(render({ ...captured, event: noUrl }).event.url).toBe("https://us.posthog.com/person/user-42");
    expect(render({ ...captured, event: noUrl, person: undefined }).event.url).toBe("https://us.posthog.com/project/7");
  });

  it("names the person by name, then distinct ID", () => {
    expect(render({ ...captured, person: { ...captured.person, name: undefined } }).event.body).toContain("Person: user-42\n");
  });

  it("leaves out a $-property and a nested one, and keeps at most 20 properties", () => {
    const properties = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`p${i}`, i]));
    const lines = render({ ...captured, event: { ...captured.event, properties: { $ip: "1.2.3.4", nested: { a: 1 }, list: [1], ...properties } } }).event.body.split("\n");
    expect(lines.slice(4)).toEqual(Array.from({ length: 20 }, (_, i) => `p${i}: ${i}`));
  });

  it("has no blank line when the event has no properties", () => {
    expect(render({ ...captured, event: { ...captured.event, properties: undefined } }).event.body).toBe("PostHog event: signup\nProject: Truecast (Dev)\nPerson: Ann\nAt: 2026-11-19T10:00:00Z");
    expect(render({ ...captured, event: { ...captured.event, properties: { $only: 1 } } }).event.body.endsWith("At: 2026-11-19T10:00:00Z")).toBe(true);
  });
});

describe("what the shipped recipe does differently from the built-in mapper (accepted: PostHog's payload always carries these)", () => {
  it("takes the delivery's ID for the event's when the event, the distinct ID or the timestamp is missing", () => {
    const { distinct_id: _d, ...noDistinct } = captured.event;
    const { timestamp: _t, ...noTime } = captured.event;
    expect(render({ ...captured, event: noDistinct, person: undefined }).event.id).toBe("composio:msg_1");
    expect(render({ ...captured, event: noTime }).event.id).toBe("composio:msg_1");
  });

  it("leaves the Project line empty with no project name or ID, where the mapper showed the account", () => {
    expect(render({ ...captured, project: undefined }).event.body).toContain("Project: \n");
  });

  it("leaves the At line empty with no timestamp, and the Person line empty with no person at all", () => {
    const { timestamp: _t, ...noTime } = captured.event;
    expect(render({ ...captured, event: noTime }).event.body).toContain("At: \n");
    const { distinct_id: _d, ...noDistinct } = captured.event;
    expect(render({ ...captured, event: noDistinct, person: undefined }).event.body).toContain("Person: \n");
  });

  it("shows empty parentheses in the title with no distinct ID, and the actor is unknown", () => {
    const { distinct_id: _d, ...noDistinct } = captured.event;
    const event = render({ ...captured, event: noDistinct, person: undefined }).event;
    expect(event.title).toBe("signup in PostHog ()");
    expect(event.actor).toBe("unknown");
  });

  it("makes an event of a payload that names no event, which the mapper ignored", () => {
    const event = render({ event: {} }).event;
    expect(event.kind).toBe("analytics_event");
    expect(event.id).toBe("composio:msg_1");
  });

  it("counts an empty string as present, so an empty name is not skipped for the next alternative", () => {
    expect(render({ ...captured, person: { ...captured.person, name: "" } }).event.body).toContain("Person: \n");
    expect(render({ ...captured, project: { ...captured.project, name: "" } }).event.place).toBe("app");
  });
});

describe("the composio-integration skill", () => {
  const skill = fs.readFileSync("plugin/skills/composio-integration/SKILL.md", "utf8");
  const section = skill.slice(skill.indexOf("\n## PostHog\n"), skill.indexOf("\n## Config entries for any other toolkit"));

  it("shows the recipe the daemon ships for PostHog, for a Clot to copy and change", () => {
    const yaml = /```yaml\n([\s\S]*?)```/.exec(section)?.[1];
    expect(yaml).toBeDefined();
    expect(parseRuleFile(yaml!).composio).toEqual([defaultRecipe("posthog")]);
  });

  it("shows an entry in the new shape, which the loader takes", () => {
    const entry = JSON.parse(/```json\n([\s\S]*?)```/.exec(section)![1]);
    expect(composioEntryProblems(entry, ["app"])).toBeUndefined();
  });
});
