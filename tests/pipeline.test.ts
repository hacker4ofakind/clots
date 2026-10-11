import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeChat } from "../src/chat/fake.js";
import type { ClotEvent, TriageResult } from "../src/events/types.js";
import { acceptGithub, startIntake } from "../src/intake.js";
import { Pipeline } from "../src/pipeline.js";
import type { ClotPort } from "../src/steering.js";
import { Store } from "../src/store.js";
import type { Triage, TriageInput } from "../src/triage.js";

class FakePort implements ClotPort {
  busy = false;
  queued: { id: string; notice: string }[] = [];
  isBusy(): boolean {
    return this.busy;
  }
  steerEvent(): boolean {
    return false;
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
    return { needsAction: true, message: "Login fails. Looking into it.", urgent: false, suspicious: false, relevantNow: false, ...this.next };
  }
}

let store: Store;
let chat: FakeChat;
let port: FakePort;
let triage: FakeTriage;
let asked: { clot: string; id: string; message: string }[];
let canAsk: boolean;
let dropRule: (event: ClotEvent) => boolean;
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
    repo: "octo/widgets",
    actor: "someone",
    title: "Issue #7 opened: Login fails",
    body: "Steps...",
    url: "https://github.com/octo/widgets/issues/7",
    ref: "7",
    subject: "issue:7",
    automated: false,
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
  asked = [];
  canAsk = true;
  dropRule = () => false;
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
    rulebook: { isDropped: (_clot, e) => dropRule(e), guidance: () => "Ignore typo reports." },
    triage,
    steering: {
      ask: async (clot, e, message) => {
        if (canAsk) asked.push({ clot, id: e.id, message });
        return canAsk;
      },
    },
    clots: new Map([["graphite", port]]),
    clotForRepo: (repo) => (repo === "octo/widgets" ? "graphite" : undefined),
    clotLogin: "widgets-clot",
    readInline: (e) => inline(e),
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
    expect(triage.inputs[0]).toMatchObject({ guidance: "Ignore typo reports.", tail: null });
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
    await pipeline.handle(event("d-1", { repo: "octo/other" }));
    expect(store.getEvent("d-1")).toMatchObject({ status: "dropped", note: "no Clot is bound to this repository" });
    expect(triage.inputs).toEqual([]);
  });

  it("drops what a pre-filter matches, before triage is asked", async () => {
    dropRule = (e) => e.actor === "someone";
    await pipeline.handle(event("d-1"));
    expect(store.getEvent("d-1")).toMatchObject({ status: "dropped", note: "matched a pre-filter" });
    expect(triage.inputs).toEqual([]);
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

  it("gives triage the conversation only while a turn is running", async () => {
    port.busy = true;
    await pipeline.handle(event("d-1"));
    expect(triage.inputs[0].tail).toEqual([{ role: "user", text: "fix the login page" }]);
  });

  it("asks the user when a turn is running and triage says the event bears on it", async () => {
    port.busy = true;
    triage.next = { relevantNow: true };
    await pipeline.handle(event("d-1"));
    expect(asked).toEqual([{ clot: "graphite", id: "d-1", message: "Login fails. Looking into it." }]);
    expect(port.queued).toEqual([]);
  });

  it("queues without asking when the event does not bear on the running turn", async () => {
    port.busy = true;
    await pipeline.handle(event("d-1"));
    expect(asked).toEqual([]);
    expect(port.queued.map((q) => q.id)).toEqual(["d-1"]);
  });

  it("queues when the question could not be asked", async () => {
    port.busy = true;
    canAsk = false;
    triage.next = { relevantNow: true };
    await pipeline.handle(event("d-1"));
    expect(port.queued.map((q) => q.id)).toEqual(["d-1"]);
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
    const server = startIntake({ ...deps(), port: 0, onEvent: (e) => seen.push(e.id) });
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
