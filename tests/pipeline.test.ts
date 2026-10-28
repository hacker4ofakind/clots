import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeChat } from "../src/chat/fake.js";
import type { ClotEvent, TriageResult } from "../src/events/types.js";
import { acceptGithub, githubHandler, startIntake } from "../src/intake.js";
import { isSelfCaused } from "../src/events/github.js";

import { Pipeline, type ClotPort } from "../src/pipeline.js";
import { Store } from "../src/store.js";
import type { Triage, TriageInput } from "../src/triage.js";

class FakePort implements ClotPort {
  busy = false;
  queued: { id: string; notice: string }[] = [];
  isBusy(): boolean {
    return this.busy;
  }
  async queueEvent(event: ClotEvent, notice: string): Promise<void> {
    this.queued.push({ id: event.id, notice });
  }
}

class FakeTriage implements Triage {
  inputs: TriageInput[] = [];
  next: Partial<TriageResult> = {};
  fail = false;
  async judge(input: TriageInput): Promise<TriageResult> {
    this.inputs.push(input);
    if (this.fail) throw new Error("model unavailable");
    return { needsAction: true, message: "Login fails. Looking into it.", urgent: false, suspicious: false, ...this.next };
  }
}

let store: Store;
let chat: FakeChat;
let port: FakePort;
let triage: FakeTriage;
let dropRule: (event: ClotEvent) => boolean;
let ownDropRule: (event: ClotEvent) => boolean;
let pipeline: Pipeline;
let live: string;
let clock: number;
let timers: { ms: number; fn: () => void; cancelled: boolean }[];
let inline: (event: ClotEvent) => Promise<ClotEvent>;

/** Lets the waits that are still pending run out. */
function fire(): void {
  for (const timer of timers.splice(0)) if (!timer.cancelled) timer.fn();
}

/** An automated report about pull request #14. */
function report(id: string, overrides: Partial<ClotEvent> = {}): ClotEvent {
  return event(id, { kind: "comment", actor: "vercel[bot]", title: "Comment on pull request #14: Add cache", body: "Deployment failed.", url: `https://github.com/octo/widgets/pull/14#issuecomment-${id}`, ref: "14", subject: "pr:14", automated: true, ...overrides });
}

const ciFailure = { kind: "ci_failed", actor: "widgets-clot", title: "CI failed: CI on clot/add-cache", body: "Workflow run ID: 4242", ref: "clot/add-cache" } as const;

function event(id: string, overrides: Partial<ClotEvent> = {}): ClotEvent {
  const e: ClotEvent = {
    id,
    source: "github",
    kind: "issue_opened",
    account: "github", place: "octo/widgets",
    actor: "someone",
    title: "Issue #7 opened: Login fails",
    body: "Steps...",
    url: "https://github.com/octo/widgets/issues/7",
    ref: "7",
    subject: "issue:7",
    automated: false,
    outsider: false,
    receivedAt: 0,
    ...overrides,
  };
  store.insertEvent(e);
  return e;
}

beforeEach(async () => {
  store = new Store(":memory:");
  chat = new FakeChat();
  port = new FakePort();
  triage = new FakeTriage();
  dropRule = () => false;
  ownDropRule = () => false;
  clock = 0;
  timers = [];
  inline = async (e) => e;
  const category = await chat.ensureCategory("graphite");
  store.upsertClot("graphite", category);
  live = await chat.createChannel(category, "graphite-1110");
  store.createSession({ id: "s1", clot: "graphite", channelId: live, seed: null });
  store.appendTail("graphite", "user", "fix the login page");
  pipeline = new Pipeline({
    store,
    chat,
    rulebook: { dropsIn: (name, e) => (name === "global" ? dropRule(e) : ownDropRule(e)), guidance: () => "Ignore typo reports." },
    triage,
    clots: new Map([["graphite", port]]),
    route: async (e) => (e.place === "octo/widgets" ? { clot: "graphite", how: "bound" } : { how: "no Clot is bound to this repository" }),
    selfCaused: (e) => e.source === "github" && isSelfCaused(e, "widgets-clot"),
    enrich: (e) => inline(e),
    hold: { quietMs: 60_000, capMs: 120_000 },
    now: () => clock,
    schedule: (ms, fn) => {
      const timer = { ms, fn, cancelled: false };
      timers.push(timer);
      return () => void (timer.cancelled = true);
    },
  });
});

describe("Pipeline", () => {
  it("queues an event that needs action, with triage's message, and records what triage said", async () => {
    triage.next = { urgent: true };
    await pipeline.handle(event("d-1"));
    expect(port.queued).toEqual([{ id: "d-1", notice: "Login fails. Looking into it." }]);
    expect(store.getEvent("d-1")).toMatchObject({ clot: "graphite", triageMessage: "Login fails. Looking into it.", urgent: true });
    expect(triage.inputs[0]).toMatchObject({ guidance: "Ignore typo reports." });
  });

  it("drops what the Clot caused itself, before triage is asked", async () => {
    await pipeline.handle(event("d-1", { actor: "Widgets-Clot", kind: "comment" }));
    expect(store.getEvent("d-1")).toMatchObject({ status: "dropped", note: "caused by the Clot itself" });
    expect(triage.inputs).toEqual([]);
    expect(port.queued).toEqual([]);
  });

  it("keeps a failed CI run even though the Clot's push caused it", async () => {
    await pipeline.handle(event("d-1", { actor: "widgets-clot", kind: "ci_failed" }));
    expect(port.queued.map((q) => q.id)).toEqual(["d-1"]);
  });

  it("drops an event for a repository no Clot is bound to", async () => {
    await pipeline.handle(event("d-1", { place: "octo/other" }));
    expect(store.getEvent("d-1")).toMatchObject({ status: "dropped", note: "no Clot is bound to this repository" });
    expect(triage.inputs).toEqual([]);
  });

  it("drops what a pre-filter matches, before triage is asked", async () => {
    dropRule = (e) => e.actor === "someone";
    await pipeline.handle(event("d-1"));
    expect(store.getEvent("d-1")).toMatchObject({ status: "dropped", note: "matched a pre-filter" });
    expect(triage.inputs).toEqual([]);
  });

  it("checks the global pre-filters before routing, and the Clot's own after", async () => {
    let routed = 0;
    pipeline = new Pipeline({ ...(pipeline as any).d, route: async () => ((routed += 1), { clot: "graphite", how: "bound" }) });
    dropRule = (e) => e.id === "d-1";
    ownDropRule = (e) => e.id === "d-2";
    await pipeline.handle(event("d-1"));
    expect(routed).toBe(0);
    await pipeline.handle(event("d-2"));
    expect(routed).toBe(1);
    expect(store.getEvent("d-2")).toMatchObject({ status: "dropped", note: "matched a pre-filter", clot: "graphite" });
  });

  it("drops an event that no Clot takes, with the router's reason", async () => {
    pipeline = new Pipeline({ ...(pipeline as any).d, route: async () => ({ how: "no routing rule matched and the routing call was not sure, and there is no home Clot" }) });
    await pipeline.handle(event("d-1", { source: "email", account: "gmail", kind: "email" }));
    expect(store.getEvent("d-1")).toMatchObject({ status: "dropped", note: "no routing rule matched and the routing call was not sure, and there is no home Clot" });
  });

  it("keeps a title and an actor that enrichment gave the event", async () => {
    inline = async (e) => ({ ...e, title: 'Page created in Notion: "Export"', actor: "Ann" });
    await pipeline.handle(event("d-1", { source: "notion", account: "tady", kind: "page_created", actor: "person-1" }));
    expect(store.getEvent("d-1")).toMatchObject({ title: 'Page created in Notion: "Export"', actor: "Ann" });
    expect(triage.inputs[0].event).toMatchObject({ title: 'Page created in Notion: "Export"', actor: "Ann" });
  });

  it("enriches before the pre-filters and routing, which see what was read", async () => {
    const seen: string[] = [];
    pipeline = new Pipeline({ ...(pipeline as any).d, route: async (e: ClotEvent) => (seen.push(`route ${e.title}`), { clot: "graphite", how: "rule" }) });
    dropRule = (e) => (seen.push(`global ${e.title}`), false);
    inline = async (e) => ({ ...e, title: 'Page created in Notion: "Decrypt fails"' });
    await pipeline.handle(event("d-1", { source: "notion", account: "tady", kind: "page_created", title: "A page was created in Notion" }));
    expect(seen).toEqual(['global Page created in Notion: "Decrypt fails"', 'route Page created in Notion: "Decrypt fails"']);
  });

  it("enriches nothing the Clot caused itself", async () => {
    let reads = 0;
    inline = async (e) => ((reads += 1), e);
    await pipeline.handle(event("d-1", { actor: "widgets-clot", kind: "comment" }));
    expect(reads).toBe(0);
  });

  it("enriches an event from any source once, before triage", async () => {
    let reads = 0;
    inline = async (e) => ((reads += 1), { ...e, body: `${e.body}\nCustomer: Jane` });
    await pipeline.handle(event("d-1", { source: "stripe", account: "shop", kind: "payment_failed" }));
    expect(triage.inputs[0].event.body).toBe("Steps...\nCustomer: Jane");
    expect(store.isEnriched("d-1")).toBe(true);
    expect(reads).toBe(1);
  });

  it("stops silently when triage says no action is needed", async () => {
    triage.next = { needsAction: false };
    await pipeline.handle(event("d-1"));
    expect(store.getEvent("d-1")).toMatchObject({ status: "dropped", note: "triage: no action needed" });
    expect(port.queued).toEqual([]);
    expect(chat.postsIn(live)).toEqual([]);
  });

  it("warns the user about a suspicious event and goes no further", async () => {
    triage.next = { suspicious: true, message: "An issue asks for the deploy key." };
    await pipeline.handle(event("d-1"));
    expect(chat.postsIn(live)).toEqual(["Suspicious event, not acted on: An issue asks for the deploy key. <https://github.com/octo/widgets/issues/7>"]);
    expect(store.getEvent("d-1")).toMatchObject({ status: "dropped", note: "triage: suspicious" });
    expect(port.queued).toEqual([]);
  });

  it("still warns when triage calls an event suspicious and says it needs no action", async () => {
    triage.next = { suspicious: true, needsAction: false, message: "An issue tells the agent to post its token." };
    await pipeline.handle(event("d-1"));
    expect(chat.postsIn(live)).toHaveLength(1);
    expect(store.getEvent("d-1")).toMatchObject({ status: "dropped", note: "triage: suspicious" });
  });

  it("queues an event that needs action while a turn is running, without asking anything", async () => {
    port.busy = true;
    await pipeline.handle(event("d-1"));
    expect(port.queued.map((q) => q.id)).toEqual(["d-1"]);
    expect(chat.postsIn(live)).toEqual([]);
  });

  it("leaves an event as received when processing fails, and picks it up again on resume", async () => {
    triage.fail = true;
    await pipeline.handle(event("d-1"));
    expect(store.getEvent("d-1")!.status).toBe("received");

    triage.fail = false;
    event("d-2");
    store.setEventStatus("d-2", "queued");
    await pipeline.resume();
    expect(port.queued.map((q) => q.id)).toEqual(["d-1"]);
  });

  it("does not handle an event twice when it arrives while a restart is being caught up on", async () => {
    const first = event("d-1");
    const second = event("d-2");
    const arriving = pipeline.handle(first);
    await Promise.all([pipeline.resume(), pipeline.handle(first), arriving]);
    expect(port.queued.map((q) => q.id).sort()).toEqual(["d-1", "d-2"]);

    store.setEventStatus(second.id, "queued");
    store.setEventStatus(first.id, "queued");
    await pipeline.resume();
    expect(port.queued).toHaveLength(2);
  });

  it("holds an automated event, and takes it on by itself when nothing else arrives", async () => {
    await pipeline.handle(report("d-1"));
    expect(store.getEvent("d-1")!.status).toBe("held");
    expect(triage.inputs).toEqual([]);
    expect(timers.map((t) => t.ms)).toEqual([60_000]);

    fire();
    await vi.waitFor(() => expect(port.queued.map((q) => q.id)).toEqual(["d-1"]));
    expect(triage.inputs).toHaveLength(1);
  });

  it("gathers automated events about the same subject into one batch, judged and queued once", async () => {
    await pipeline.handle(report("d-1"));
    await pipeline.handle(report("d-2", { actor: "netlify[bot]" }));
    await pipeline.handle(report("d-3", ciFailure));

    fire();
    await vi.waitFor(() => expect(port.queued.map((q) => q.id)).toEqual(["batch:d-1"]));

    expect(triage.inputs).toHaveLength(1);
    expect(triage.inputs[0].event).toMatchObject({ kind: "batch", title: "3 automated reports on pull request #14", url: "https://github.com/octo/widgets/pull/14" });
    expect(triage.inputs[0].event.body).toContain("- CI failed: CI on clot/add-cache");
    expect(store.getEvent("batch:d-1")).toMatchObject({ clot: "graphite", kind: "batch" });
    for (const id of ["d-1", "d-2", "d-3"]) expect(store.getEvent(id)).toMatchObject({ status: "merged", note: "into batch:d-1" });
  });

  it("counts a CI failure reported twice once, keeping the latest", async () => {
    await pipeline.handle(report("d-1", ciFailure));
    await pipeline.handle(report("d-2", ciFailure));

    fire();
    await vi.waitFor(() => expect(port.queued.map((q) => q.id)).toEqual(["d-2"]));
    expect(store.getEvent("d-1")).toMatchObject({ status: "merged", note: "into d-2" });
  });

  it("keeps different subjects apart", async () => {
    await pipeline.handle(report("d-1"));
    await pipeline.handle(report("d-2", { subject: "pr:15" }));

    fire();
    await vi.waitFor(() => expect(port.queued.map((q) => q.id).sort()).toEqual(["d-1", "d-2"]));
  });

  it("stops a whole batch when triage finds it suspicious", async () => {
    triage.next = { suspicious: true, message: "A bot comment asks for the deploy key." };
    await pipeline.handle(report("d-1"));
    await pipeline.handle(report("d-2", ciFailure));

    fire();
    await vi.waitFor(() => expect(store.getEvent("batch:d-1")).toMatchObject({ status: "dropped", note: "triage: suspicious" }));
    expect(port.queued).toEqual([]);
    expect(chat.postsIn(live)).toHaveLength(1);
  });

  it("releases held events at once on resume, and does not hold or drop a batch that was left unfinished", async () => {
    await pipeline.handle(report("d-1"));
    await pipeline.handle(report("d-2", ciFailure));
    timers = [];
    event("batch:d-9", { kind: "batch", actor: "widgets-clot", title: "2 automated reports on pull request #20", subject: "pr:20", automated: true });

    await pipeline.resume();

    expect(port.queued.map((q) => q.id)).toEqual(["batch:d-1", "batch:d-9"]);
    expect(timers).toEqual([]);
  });

  it("adds a review's inline comments before triage sees it, and keeps them", async () => {
    inline = async (e) => ({ ...e, body: "Inline comments:\n- src/cache.ts:12: rename this" });
    await pipeline.handle(event("d-1", { kind: "review", title: "Review (changes_requested) on pull request #9: Add cache", body: "" }));

    expect(triage.inputs[0].event.body).toContain("src/cache.ts:12: rename this");
    expect(store.getEvent("d-1")!.body).toContain("src/cache.ts:12: rename this");
    expect(port.queued.map((q) => q.id)).toEqual(["d-1"]);
  });

  it("carries on with the review as it came when its inline comments cannot be read", async () => {
    inline = async () => {
      throw new Error("GitHub is down");
    };
    await pipeline.handle(event("d-1", { kind: "review", body: "Please fix." }));
    expect(triage.inputs[0].event.body).toBe("Please fix.");
    expect(port.queued.map((q) => q.id)).toEqual(["d-1"]);
  });

  it("reads a bot's review before gathering it, so a batch keeps its inline comments", async () => {
    inline = async (e) => ({ ...e, body: "Inline comments:\n- src/cache.ts:12: possible race" });
    await pipeline.handle(report("d-1"));
    await pipeline.handle(report("d-2", { kind: "review", actor: "reviewbot[bot]", title: "Review (commented) on pull request #14: Add cache", body: "" }));

    fire();
    await vi.waitFor(() => expect(port.queued.map((q) => q.id)).toEqual(["batch:d-1"]));
    expect(triage.inputs[0].event.body).toContain("src/cache.ts:12: possible race");
    expect(store.getEvent("d-2")!.body).toContain("src/cache.ts:12: possible race");
  });

  it("reads a review's inline comments once, however often the event is taken up again", async () => {
    let reads = 0;
    inline = async (e) => {
      reads += 1;
      return { ...e, body: `${e.body}\n\nInline comments:\n- a.ts:3: rename` };
    };
    triage.fail = true;
    await pipeline.handle(event("d-1", { kind: "review", body: "Please fix." }));
    triage.fail = false;
    await pipeline.resume();

    expect(reads).toBe(1);
    expect(triage.inputs.at(-1)!.event.body).toBe("Please fix.\n\nInline comments:\n- a.ts:3: rename");
    expect(port.queued.map((q) => q.id)).toEqual(["d-1"]);
  });

  it("reads the inline comments of a review whose own text happens to use the daemon's wording", async () => {
    let reads = 0;
    inline = async (e) => {
      reads += 1;
      return { ...e, body: `${e.body}\n\nInline comments:\n- a.ts:3: rename` };
    };
    await pipeline.handle(event("d-1", { kind: "review", body: "See the Inline comments: they explain the required fix." }));

    expect(reads).toBe(1);
    expect(triage.inputs[0].event.body).toBe("See the Inline comments: they explain the required fix.\n\nInline comments:\n- a.ts:3: rename");
  });

  it("does not read a review again when it had no inline comments to add", async () => {
    let reads = 0;
    inline = async (e) => {
      reads += 1;
      return e;
    };
    triage.fail = true;
    await pipeline.handle(event("d-1", { kind: "review", body: "Please fix." }));
    triage.fail = false;
    await pipeline.resume();

    expect(reads).toBe(1);
  });

  it("releases events held for the same subject in two repositories separately, after a restart", async () => {
    for (const held of [report("d-1"), report("d-2", { place: "octo/gadgets" })]) {
      store.setEventClot(held.id, "graphite");
      store.setEventStatus(held.id, "held");
    }
    await pipeline.resume();
    expect(port.queued.map((q) => q.id).sort()).toEqual(["d-1", "d-2"]);
  });
});

describe("acceptGithub", () => {
  const secret = "s3cret";
  const payload = { action: "opened", repository: { full_name: "octo/widgets" }, sender: { login: "someone" }, issue: { number: 7, title: "Login fails", body: "", html_url: "https://github.com/octo/widgets/issues/7" } };
  const body = (value: unknown) => Buffer.from(JSON.stringify(value));
  const sign = (raw: Buffer) => `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;
  const deps = () => ({ secret, insertEvent: (e: ClotEvent) => store.insertEvent(e), now: () => 1234 });
  const delivery = (raw: Buffer, overrides = {}) => ({ signature: sign(raw), eventName: "issues", deliveryId: "d-1", rawBody: raw, ...overrides });

  it("accepts a signed delivery of a kind the Clots react to, and stores it", () => {
    const answer = acceptGithub(delivery(body(payload)), deps());
    expect(answer).toMatchObject({ status: 202, text: "accepted" });
    expect(answer.event).toMatchObject({ id: "d-1", kind: "issue_opened", receivedAt: 1234 });
    expect(store.getEvent("d-1")!.status).toBe("received");
  });

  it("tells the workers of a closed pull request and stores nothing; an opened one is told and stored", () => {
    const changes: unknown[] = [];
    const withPr = () => ({ ...deps(), onPullRequest: async (a: unknown) => void changes.push(a) });
    const pr = (action: string) => ({
      action,
      number: 3,
      repository: { full_name: "O/R" },
      sender: { login: "someone" },
      pull_request: { number: 3, title: "Fix", body: "", html_url: "https://github.com/o/r/pull/3", head: { ref: "clot/x-1a2b", repo: { full_name: "O/R" } } },
    });
    expect(acceptGithub(delivery(body(pr("closed")), { eventName: "pull_request", deliveryId: "d-9" }), withPr())).toEqual({ status: 200, text: "pull request closed" });
    expect(store.getEvent("d-9")).toBeUndefined();
    expect(changes).toEqual([{ repo: "o/r", branch: "clot/x-1a2b", headRepo: "o/r", number: 3, url: "https://github.com/o/r/pull/3", action: "closed" }]);

    expect(acceptGithub(delivery(body(pr("opened")), { eventName: "pull_request", deliveryId: "d-10" }), withPr())).toMatchObject({ status: 202 });
    expect(store.getEvent("d-10")).toBeDefined();
    expect(changes[1]).toMatchObject({ action: "opened", branch: "clot/x-1a2b" });
  });

  it("acknowledges a repeated delivery without handing it on", () => {
    acceptGithub(delivery(body(payload)), deps());
    expect(acceptGithub(delivery(body(payload)), deps())).toEqual({ status: 200, text: "duplicate" });
  });

  it("acknowledges and discards a delivery outside the five kinds", () => {
    const raw = body({ zen: "Keep it logically awesome." });
    expect(acceptGithub(delivery(raw, { eventName: "ping" }), deps())).toEqual({ status: 200, text: "ignored" });
    expect(store.eventsWithStatus("received")).toEqual([]);
  });

  it("refuses a bad signature, missing headers and a body that is not JSON", () => {
    const raw = body(payload);
    expect(acceptGithub(delivery(raw, { signature: "sha256=00" }), deps()).status).toBe(401);
    expect(acceptGithub(delivery(raw, { signature: undefined }), deps()).status).toBe(401);
    expect(acceptGithub(delivery(raw, { deliveryId: undefined }), deps()).status).toBe(400);
    const junk = Buffer.from("not json");
    expect(acceptGithub(delivery(junk), deps()).status).toBe(400);
  });

  it("serves the same answers over HTTP and hands a new event on once", async () => {
    const seen: string[] = [];
    const handler = githubHandler(deps());
    const server = startIntake({ port: 0, handlerFor: (path) => (path === "/webhooks/github" ? handler : undefined), onAnswer: (answer) => seen.push(answer.event!.id) });
    await new Promise((resolve) => server.once("listening", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const raw = body(payload);
    const post = (headers: Record<string, string>) => fetch(`http://127.0.0.1:${port}/webhooks/github`, { method: "POST", body: raw, headers });
    const headers = { "x-hub-signature-256": sign(raw), "x-github-event": "issues", "x-github-delivery": "d-9" };

    expect((await post(headers)).status).toBe(202);
    expect((await post(headers)).status).toBe(200);
    expect((await post({ ...headers, "x-hub-signature-256": "sha256=00" })).status).toBe(401);
    expect((await fetch(`http://127.0.0.1:${port}/elsewhere`, { method: "POST", body: raw })).status).toBe(404);
    expect(seen).toEqual(["d-9"]);
    await new Promise((resolve) => server.close(resolve));
  });
});
